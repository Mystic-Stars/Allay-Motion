import {
  expandSoundEvent, fileFromSoundEvent, mergeSoundDefinitions, parseResourceId, parseSoundLanguage, parseSoundsJson,
  soundFileEvent, soundKind, soundNames, soundNameToPaths, type ResourceLayer,
} from '@allay/assets';
import type { SoundFileState, SoundLibraryItem, SoundVariantInfo } from '../../shared/resources';
import type { ClosableLayer } from './layers';

/** 只允许从当前已启用的下载原版层取这两个索引对象。 */
export async function missingSoundNameObjects(stack: readonly ResourceLayer[]) {
  const vanilla = stack.find((layer) => layer.enabled && layer.kind === 'vanilla') as ClosableLayer | undefined;
  if (!vanilla?.remoteObject) return [];
  const objects = await Promise.all(['assets/minecraft/sounds.json', 'assets/minecraft/lang/zh_cn.json'].map((path) => vanilla.remoteObject!(path)));
  return objects.filter((object): object is { hash: string; size: number } => object !== null && object.size <= 4 * 1024 * 1024);
}

/** 先按资源包优先级找文件，同一层才按 OGG、WAV 优先级。状态、来源和读取必须使用同一个赢家。 */
export function findSoundFile(stack: readonly ResourceLayer[], file: string) {
  const paths = soundNameToPaths(file);
  for (const layer of [...stack].reverse()) {
    if (!layer.enabled) continue;
    for (const path of paths) if (layer.has(path)) return { layer, path };
  }
  return null;
}

async function readText(layer: ResourceLayer, path: string): Promise<string> {
  const bytes = await layer.read(path).catch(() => null);
  return bytes && bytes.length <= 4 * 1024 * 1024 ? new TextDecoder().decode(bytes) : '';
}

export async function buildSoundCatalog(stack: readonly ResourceLayer[]) {
  const sources = [];
  const musicFiles = new Set<string>();
  const vanillaFiles = new Set<string>();
  const vanillaSubtitles = new Map<string, string | undefined>();
  const vanilla = stack.find((layer) => layer.enabled && layer.kind === 'vanilla');
  const [zh, en] = vanilla ? await Promise.all(['zh_cn', 'en_us'].map(async (lang) => parseSoundLanguage(await readText(vanilla, `assets/minecraft/lang/${lang}.json`)))) : [];
  for (const layer of stack) {
    if (!layer.enabled) continue;
    for (const path of layer.list('assets/')) {
      const definition = /^assets\/([a-z0-9_.-]+)\/sounds\.json$/.exec(path);
      if (definition) {
        if (definition[1] === 'user-audio' || definition[1] === 'sound-file') continue;
        const parsed = parseSoundsJson(await readText(layer, path), definition[1]!);
        for (const id of parsed.events.keys()) if (id.startsWith('user-audio:') || id.startsWith('sound-file:')) parsed.events.delete(id);
        if (layer === vanilla) for (const [id, event] of parsed.events) vanillaSubtitles.set(id, event.subtitle);
        sources.push({ kind: layer.kind, parsed });
      } else if (layer.kind !== 'builtin') {
        const media = /^assets\/([^/]+)\/sounds\/(.+)\.(?:ogg|wav)$/.exec(path);
        const file = media ? `${media[1]}:${media[2]}` : '';
        if (!file || file.length > 240 || file.startsWith('user-audio:') || !parseResourceId(file)) continue;
        if (layer.kind === 'vanilla') vanillaFiles.add(file);
        if (soundKind('', file) === 'music') musicFiles.add(file);
      }
    }
  }
  const defs = mergeSoundDefinitions(sources);
  const variantsById = new Map<string, SoundVariantInfo[]>();
  const referenced = new Set<string>();
  const clamp = (value: number) => Math.min(16, Math.max(0, value));
  for (const id of defs.keys()) {
    const variants = expandSoundEvent(defs, id).filter((variant) => !variant.file.startsWith('user-audio:')).map((variant) => {
      referenced.add(variant.file);
      return { file: variant.file, volume: clamp(variant.volume), pitch: clamp(variant.pitch), weight: Math.min(1_000_000, variant.weight), kind: soundKind(id, variant.file) };
    });
    variantsById.set(id, variants);
  }
  for (const file of musicFiles) {
    if (!referenced.has(file)) variantsById.set(soundFileEvent(file), [{ file, volume: 1, pitch: 1, weight: 1, kind: 'music' }]);
  }
  function variants(id: string): SoundVariantInfo[] | null {
    const file = fileFromSoundEvent(id);
    if (file) return musicFiles.has(file) ? [{ file, volume: 1, pitch: 1, weight: 1, kind: 'music' }] : null;
    return variantsById.get(id) ?? null;
  }
  async function items(stateFor: (file: string) => Promise<SoundFileState>): Promise<SoundLibraryItem[]> {
    const states = new Map<string, Promise<SoundFileState>>();
    return Promise.all([...variantsById].map(async ([id, entries]): Promise<SoundLibraryItem> => {
      const def = defs.get(id);
      const file = fileFromSoundEvent(id);
      const known = def?.vanilla === true;
      const original = known || (file !== null && vanillaFiles.has(file));
      const fileOverride = entries.some((entry) => vanillaFiles.has(entry.file) && findSoundFile(stack, entry.file)?.layer.kind === 'pack');
      const source = def?.packDefinition ? (known ? 'definition-override' : 'pack-new') : original ? (fileOverride ? 'file-override' : 'vanilla') : def?.builtinOnly ? 'builtin' : 'pack-new';
      const labels = soundNames(id, known, known ? vanillaSubtitles.get(id) : undefined, zh ?? {}, en ?? {});
      const availability = await Promise.all(entries.map(({ file }) => {
        const existing = states.get(file);
        if (existing) return existing;
        const resolved = stateFor(file);
        states.set(file, resolved);
        return resolved;
      }));
      return {
        id, source, fileOverride, names: labels, variantCount: entries.length,
        kind: entries.some((entry) => entry.kind === 'music') ? 'music' : soundKind(id),
        state: availability.includes('remote') ? 'remote' : availability.includes('local') ? 'local' : 'missing',
      };
    }));
  }
  return { variants, items };
}
