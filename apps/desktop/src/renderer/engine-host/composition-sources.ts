import { CompositionSchema, compositionSourceKey, type Composition, type CompositionLoadRequest, type OutputSettings } from '@allay/template-sdk';
import { useResourceStore } from '../stores/resourceStore';
import { readCompositionClip } from '../templates/catalog';
import type { ResourceResolver } from './EngineHost';
import { createResolver, loadStamp, profileStamp } from './resource-client';

export interface PreparedComposition {
  request: CompositionLoadRequest;
  resources: ResourceResolver[];
  assertCurrent(): void;
}

export function compositionResourceStamp(composition: Composition): string {
  const profiles = new Set<string | undefined>();
  for (const track of composition.tracks) if (!track.muted) {
    for (const clip of track.clips) profiles.add(clip.profile ?? composition.defaultProfile);
  }
  return JSON.stringify([...profiles].map((profile) => profileStamp(profile)).sort());
}

export async function prepareComposition(composition: Composition, output: OutputSettings, locale: string, stamp = compositionResourceStamp(composition)): Promise<PreparedComposition> {
  const model = CompositionSchema.parse(composition);
  const sources: CompositionLoadRequest['sources'] = [];
  const resources: ResourceResolver[] = [];
  const keys = new Set<string>();
  const templates = new Map<string, ReturnType<typeof readCompositionClip>>();
  const assertCurrent = () => {
    if (compositionResourceStamp(model) !== stamp) throw new Error('resource stack changed during composition setup');
  };
  for (const track of model.tracks) {
    if (track.muted) continue;
    for (const clip of track.clips) {
      if (clip.startFrame >= model.durationFrames) continue;
      const profile = clip.profile ?? model.defaultProfile;
      if (profile !== undefined && !useResourceStore.getState().state?.library?.profiles.some((entry) => entry.id === profile && !entry.missing)) {
        throw new Error(`missing composition resource profile: ${profile}`);
      }
      const key = compositionSourceKey(clip.template, profile);
      if (keys.has(key)) continue;
      keys.add(key);
      const templateKey = compositionSourceKey(clip.template);
      let pending = templates.get(templateKey);
      if (!pending) {
        pending = readCompositionClip(clip.template);
        templates.set(templateKey, pending);
      }
      const template = await pending;
      assertCurrent();
      if (!template) throw new Error(`missing composition template: ${clip.template.id}@${clip.template.version}`);
      sources.push({ template: clip.template, ...('code' in template ? { manifest: template.manifest, code: template.code } : {}), resourceStamp: loadStamp(template.assets, profile),
        ...(profile === undefined ? {} : { profile }) });
      const resolve = createResolver(template.assets, profile);
      const sourceStamp = profileStamp(profile);
      const assertSource = () => {
        if (profileStamp(profile) !== sourceStamp) throw new Error('resource profile changed during composition setup');
      };
      resources.push(async (kind, id) => {
        assertSource();
        const payload = await resolve(kind, id);
        assertSource();
        return payload;
      });
    }
  }
  assertCurrent();
  return { request: { composition: model, output: { ...output, fps: model.fps }, locale, sources }, resources, assertCurrent };
}
