import { COMPOSITION_MAX_SECONDS, type CompositionClip } from '@allay/template-sdk';
import type { TFunction } from 'i18next';
import type { TemplateEntry } from '../../../shared/templates';
import { notify } from '../../stores/noticeStore';
import { useProjectStore } from '../../stores/projectStore';
import { useResourceStore } from '../../stores/resourceStore';
import { useTransportStore } from '../../stores/transportStore';
import { readTemplate } from '../../templates/catalog';
import { appendClip, clampFrame, makeTrack, type Selection } from '../studio/edits';
import { boundResourceEdition, creationParams } from '../templates/profileDefaults';

export async function appendTemplate(entry: TemplateEntry, trackId: string | undefined, locale: string, t: TFunction): Promise<Selection | null> {
  const snapshot = useProjectStore.getState().composition;
  if (!snapshot || entry.baseMissing) return null;
  const startFrame = clampFrame(useTransportStore.getState().time * snapshot.fps, 0, snapshot.durationFrames - 1);
  const source = await readTemplate(entry.id, entry.version).catch(() => null);
  const project = useProjectStore.getState();
  if (project.composition !== snapshot) return null;
  if (!source) {
    notify('error', t('project.errors.templateMissing', { id: entry.id, version: entry.version }));
    return null;
  }
  const params = creationParams(source, locale, boundResourceEdition(useResourceStore.getState().state, snapshot.defaultProfile));
  const segments = source.manifest.timeline?.segments;
  const seconds = segments?.length ? segments.reduce((sum, { param }) => sum + Number(params[param] ?? 0), 0)
    : typeof params.duration === 'number' ? params.duration : 1;
  const durationFrames = clampFrame(seconds * snapshot.fps, 1, snapshot.fps * COMPOSITION_MAX_SECONDS - startFrame);
  const track = snapshot.tracks.find((item) => item.id === trackId && !item.locked) ?? snapshot.tracks.find((item) => !item.locked)
    ?? makeTrack(crypto.randomUUID(), t('workspaceNavigation.track', { number: snapshot.tracks.length + 1 }));
  const clip: CompositionClip = { id: crypto.randomUUID(), startFrame, durationFrames, sourceInFrame: 0, template: source.ref, params };
  const next = appendClip(snapshot, track, clip);
  if (next === snapshot) {
    notify('info', t('workspaceNavigation.insertLimit'));
    return null;
  }
  project.setComposition(next);
  return { trackId: track.id, clipId: clip.id };
}
