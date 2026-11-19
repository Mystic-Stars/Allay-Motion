import type { CompositionClip } from '../composition';
import { TemplateManifestSchema, type TemplateManifest } from '../manifest';
import object from './object.json' with { type: 'json' };
import player from './player.json' with { type: 'json' };

type TemplateRef = CompositionClip['template'];

const nativeManifests = {
  object: TemplateManifestSchema.parse(object),
  player: TemplateManifestSchema.parse(player),
};

export const studioMaterialRefs = {
  object: { id: object.id, version: object.version },
  player: { id: player.id, version: player.version },
};

export function studioMaterialKind(ref: TemplateRef): keyof typeof nativeManifests | undefined {
  if (ref.id === object.id && ref.version === object.version) return 'object';
  if (ref.id === player.id && ref.version === player.version) return 'player';
  return undefined;
}

export function studioMaterialManifest(ref: TemplateRef): TemplateManifest | undefined {
  const kind = studioMaterialKind(ref);
  return kind ? nativeManifests[kind] : undefined;
}
