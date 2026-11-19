import { CompositionSchema, sanitizeParams, sameValue, type Composition, type OutputSettings, type ParamValue } from '@allay/template-sdk';
import { MAX_COMPOSITION_DOCUMENT_BYTES, type CompositionPackage } from '../../../shared/template-authoring';
import { prepareComposition } from '../../engine-host/composition-sources';
import { EngineHost } from '../../engine-host/EngineHost';

export function parseCompositionDocument(document: string): Composition {
  if (new TextEncoder().encode(document).length > MAX_COMPOSITION_DOCUMENT_BYTES) throw new Error('composition document is too large');
  return CompositionSchema.parse(JSON.parse(document));
}

export async function trialComposition(composition: Composition, output: OutputSettings, locale: string, time: number): Promise<void> {
  const ratio = Math.min(1, 320 / Math.max(output.width, output.height));
  const size = { ...output, width: Math.max(16, Math.round(output.width * ratio)), height: Math.max(16, Math.round(output.height * ratio)) };
  const prepared = await prepareComposition(composition, size, locale);
  const host = await EngineHost.create({ mode: 'utility', resolveResource: async () => null, strictDeterminism: true });
  try {
    await host.loadComposition(prepared.request, prepared.resources);
    await host.renderFrame(Math.min(composition.durationFrames - 1, Math.max(0, Math.round(time * composition.fps))), { subframes: 1, shutterAngle: 0 });
    prepared.assertCurrent();
  } finally {
    host.dispose();
  }
}

export function instantiateComposition(pkg: CompositionPackage, values: string[], assets: Readonly<Record<string, string>>, profiles: Readonly<Record<string, string>>, locale: string): Composition {
  const composition = structuredClone(pkg.composition);
  const clips = new Map(composition.tracks.flatMap((track) => track.clips.map((clip) => [clip.id, clip] as const)));
  const remapAsset = (value: ParamValue): ParamValue => {
    if (typeof value === 'string') return Object.hasOwn(assets, value.toLowerCase()) ? assets[value.toLowerCase()]! : value;
    if (Array.isArray(value)) return value.map(remapAsset);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remapAsset(item)]));
    return value;
  };
  pkg.exposed.forEach(({ clipId, key, definition }, index) => {
    const text = values[index];
    if (text === undefined || text === '') return;
    if (text.length > MAX_COMPOSITION_DOCUMENT_BYTES) throw new Error(`parameter too large: ${clipId}/${key}`);
    const raw: unknown = JSON.parse(text);
    const clean = sanitizeParams([definition], { [key]: raw }, { locale })[key];
    const clip = clips.get(clipId);
    if (!clip || clean === undefined || !sameValue(clean, raw as ParamValue)) throw new Error(`invalid parameter: ${clipId}/${key}`);
    clip.params[key] = clean;
  });
  if (composition.defaultProfile && Object.hasOwn(profiles, composition.defaultProfile)) composition.defaultProfile = profiles[composition.defaultProfile]!;
  for (const clip of clips.values()) {
    clip.params = Object.fromEntries(Object.entries(clip.params).map(([key, value]) => [key, remapAsset(value)]));
    if (clip.profile && Object.hasOwn(profiles, clip.profile)) clip.profile = profiles[clip.profile]!;
  }
  return CompositionSchema.parse(composition);
}
