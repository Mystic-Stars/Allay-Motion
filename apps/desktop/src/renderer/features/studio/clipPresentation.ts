import { localize, studioMaterialKind, studioMaterialRefs, type CompositionClip, type LocalizedString } from '@allay/template-sdk';
import { Cube, FilmStrip, Image, SpeakerHigh, TextT, User } from '@phosphor-icons/react';
import type { useStudioLabels } from './labels';

export const materialRefs = {
  text: studioMaterialRefs.object,
  image: studioMaterialRefs.object,
  sound: studioMaterialRefs.object,
  block: studioMaterialRefs.object,
  player: studioMaterialRefs.player,
} as const;

export type Material = keyof typeof materialRefs;
export const materialIcons = { text: TextT, image: Image, sound: SpeakerHigh, block: Cube, player: User };

function summary(text: string) {
  const clean = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(clean);
  return chars.length > 36 ? `${chars.slice(0, 36).join('')}…` : clean;
}

export function describeClip(clip: CompositionClip, templateName: LocalizedString | undefined, locale: string,
  label: ReturnType<typeof useStudioLabels>, fileNames: Record<string, string>, fallbackKind?: unknown) {
  const kind = clip.params.kind ?? fallbackKind;
  const native = studioMaterialKind(clip.template);
  if (native === 'object' && (kind === 'text' || kind === 'image' || kind === 'sound' || kind === 'block')) {
    const detail = kind === 'text' && typeof clip.params.text === 'string' ? summary(clip.params.text)
      : kind === 'image' && typeof clip.params.image === 'string' ? fileNames[clip.params.image] : undefined;
    return { name: detail || label(kind), kind: label(kind), icon: materialIcons[kind], audio: kind === 'sound' };
  }
  const player = native === 'player';
  return {
    name: localize(templateName, locale) || label(player ? 'player' : 'template'), kind: label(player ? 'player' : 'template'),
    icon: player ? materialIcons.player : FilmStrip, audio: false,
  };
}
