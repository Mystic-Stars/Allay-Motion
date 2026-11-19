import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { isSafeRelativePath, readPngHeader } from '@allay/assets';
import { z } from 'zod';
import { scanDirectory } from './directory';
import type { ClosableLayer } from './layers';
import { openZip, ZipRejectedError } from './zip';

export class EncryptedPackError extends ZipRejectedError {}

const Version = z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative(), z.number().int().nonnegative()]).or(z.string().regex(/^\d+\.\d+\.\d+$/));
const Manifest = z.object({
  format_version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  header: z.object({ uuid: z.uuid(), name: z.string().min(1), description: z.string().optional(), version: Version }),
  modules: z.array(z.object({ type: z.string() })).refine((modules) => modules.some((module) => module.type === 'resources')),
});
const TextureRef = z.string().or(z.object({ path: z.string() }));
const Atlas = z.object({ texture_data: z.record(z.string(), z.object({ textures: TextureRef.or(z.array(TextureRef)) })) });
const Sound = z.object({ name: z.string(), volume: z.number().optional(), pitch: z.number().optional(), weight: z.number().int().positive().optional() });
const SoundDefinitions = z.record(z.string(), z.object({ sounds: z.array(z.string().or(Sound)) }));
const WrappedSounds = z.object({ sound_definitions: SoundDefinitions });
const Music = z.record(z.string(), z.object({ event_name: z.string() }));
const PackContents = z.object({ content: z.array(z.object({ key: z.string().optional() })) });
const utf8 = new TextDecoder();
const encode = (data: unknown) => new TextEncoder().encode(JSON.stringify(data));
const ROOT = 'assets/minecraft/';
const pathName = /^[a-z0-9_./-]+$/;
const RESOURCES = /^(textures|sounds|font|texts)\//;
const nativeLoadingTiles = new Set(['textures/blocks/dirt.png', 'textures/blocks/netherrack.png', 'textures/blocks/end_stone.png']);

const guiSlices = [
  ['dialog_background_hollow_3', 18, 33, 8, 23, 8, 8],
  ['greyborder', 16, 16, 4, 4, 4, 4],
  ['experiencebarempty', 13, 5, 6, 1, 6, 1],
  ['experiencebarfull', 13, 5, 1, 0, 1, 0],
] as const;

async function json(source: Pick<ClosableLayer, 'read'>, path: string): Promise<unknown> {
  const bytes = await source.read(path);
  if (!bytes || bytes.length > 4 * 1024 * 1024) return null;
  try { return JSON.parse(utf8.decode(bytes)) as unknown; } catch { return null; }
}

function parseLang(bytes: Uint8Array | null): Record<string, string> {
  const entries: [string, string][] = [];
  if (bytes && bytes.length <= 4 * 1024 * 1024) for (const line of utf8.decode(bytes).split(/\r?\n/)) {
    const pair = /^([^#=\s]+)=(.*)$/.exec(line);
    if (pair?.[1] && pair[2] !== undefined) entries.push([pair[1], pair[2].split(/\t+#/)[0]!.trimEnd()]);
  }
  return Object.fromEntries(entries);
}

const textureAliases: Readonly<Record<string, string>> = {
  oak_planks: 'planks_oak', oak_log: 'log_oak', oak_log_top: 'log_oak_top', oak_leaves: 'leaves_oak',
  grass_block_top: 'grass_top', grass_block_side: 'grass_side', grass_block_side_overlay: 'grass_side_carried',
  bricks: 'brick', stone_bricks: 'stonebrick', nether_bricks: 'nether_brick',
};
const soundAliases: Readonly<Record<string, string>> = {
  'dig.stone': 'block.stone.break', 'place.stone': 'block.stone.place', 'place.wood': 'block.wood.place',
  'random.click': 'ui.button.click', 'random.orb': 'entity.experience_orb.pickup',
  'random.levelup': 'entity.player.levelup', 'random.explode': 'entity.generic.explode',
};

/** 只读适配 Bedrock 资源模块，不执行脚本、不处理模型或加密包。 */
export async function openBedrockPack(path: string, id: string, archive: boolean, required = true): Promise<(ClosableLayer & { version: string; uuid: string }) | null> {
  const source = archive ? await openZip(path, { rejectLinks: true }) : { ...(await scanDirectory(path)), close: () => undefined };
  let keep = false;
  try {
    if ((required || source.has('manifest.json')) && source.warnings.some((warning) => warning.startsWith('跳过无法解码的条目'))) throw new EncryptedPackError('不支持加密或无法解码的基岩包');
    if (source.has('contents.json')) {
      const contents = PackContents.safeParse(await json(source, 'contents.json'));
      if (!contents.success || contents.data.content.some((entry) => Boolean(entry.key))) throw new EncryptedPackError('不支持加密的基岩包');
    }
    if (!required && (!source.has('manifest.json') || source.has('pack.mcmeta'))) return null;
    const manifest = Manifest.safeParse(await json(source, 'manifest.json'));
    if (!manifest.success) throw new ZipRejectedError('没有有效的基岩资源包 manifest.json');
    const { header } = manifest.data;
    const version = typeof header.version === 'string' ? header.version : header.version.join('.');
    const mapped = new Map<string, string | Uint8Array>();
    for (const file of source.list('')) {
      if (!RESOURCES.test(file) || !pathName.test(file.toLowerCase())) continue;
      const original = file.toLowerCase();
      if (nativeLoadingTiles.has(original)) mapped.set(ROOT + original, file);
      let key = original.replace(/^textures\/blocks\//, 'textures/block/').replace(/^textures\/items\//, 'textures/item/');
      if (key.startsWith('texts/')) {
        if (!key.endsWith('.lang')) continue;
        const lang = parseLang(await source.read(file));
        mapped.set(`${ROOT}lang/${basename(key, '.lang')}.json`, encode(lang));
        key = key.replace(/^texts\//, 'lang/');
      }
      if (key.startsWith('font/') && key.endsWith('.png')) key = `textures/${key}`;
      mapped.set(ROOT + key, file);
    }
    for (const [name, width, height, left, top, right, bottom] of guiSlices) {
      const key = `${ROOT}textures/ui/${name}.png`;
      if (!mapped.has(key)) continue;
      mapped.set(`${key}.mcmeta`, encode({ gui: { scaling: { type: 'nine_slice', width, height, border: { left, top, right, bottom } } } }));
    }
    for (const [atlasPath, kind] of [['textures/terrain_texture.json', 'block'], ['textures/item_texture.json', 'item']] as const) {
      const atlas = Atlas.safeParse(await json(source, atlasPath));
      if (!atlas.success) continue;
      for (const [key, entry] of Object.entries(atlas.data.texture_data)) {
        if (!isSafeRelativePath(key) || !pathName.test(key)) continue;
        for (const ref of Array.isArray(entry.textures) ? entry.textures : [entry.textures]) {
          const raw = typeof ref === 'string' ? ref : ref.path;
          const png = raw.endsWith('.png') ? raw : `${raw}.png`;
          if (!png.startsWith('textures/') || !isSafeRelativePath(png) || !source.has(png)) continue;
          mapped.set(`${ROOT}textures/${kind}/${key}.png`, png);
          break;
        }
      }
    }
    for (const [key, original] of Object.entries(textureAliases)) {
      const target = `${ROOT}textures/block/${key}.png`;
      const alias = mapped.get(`${ROOT}textures/block/${original}.png`);
      if (alias && !mapped.has(target)) mapped.set(target, alias);
    }
    const rawSounds = await json(source, 'sounds/sound_definitions.json') ?? await json(source, 'sound_definitions.json');
    const wrapped = WrappedSounds.safeParse(rawSounds);
    const defs = wrapped.success ? wrapped.data.sound_definitions : SoundDefinitions.safeParse(rawSounds).data ?? {};
    const sounds = new Map<string, { replace: true; sounds: z.infer<typeof Sound>[] }>();
    for (const [event, def] of Object.entries(defs)) {
      if (!/^[a-z0-9_.-]+$/.test(event)) continue;
      const variants = def.sounds.flatMap((sound) => {
        const props = typeof sound === 'string' ? { name: sound } : sound;
        const name = props.name.replace(/^sounds\//, '').replace(/\.(ogg|wav)$/i, '');
        return isSafeRelativePath(name) && pathName.test(name) ? [{ ...props, name }] : [];
      });
      const definition = { replace: true as const, sounds: variants };
      sounds.set(event, definition);
      const alias = soundAliases[event];
      if (alias && !Object.hasOwn(defs, alias)) sounds.set(alias, definition);
    }
    const music = Music.safeParse(await json(source, 'sounds/music_definitions.json'));
    if (music.success) for (const [event, data] of Object.entries(music.data)) {
      const definition = sounds.get(data.event_name);
      if (definition && /^[a-z0-9_.-]+$/.test(event) && !sounds.has(event)) sounds.set(event, definition);
    }
    if (sounds.size) mapped.set(`${ROOT}sounds.json`, encode(Object.fromEntries(sounds)));
    const bitmapPath = mapped.get(`${ROOT}textures/font/default8.png`);
    const bitmap = typeof bitmapPath === 'string' ? await source.read(bitmapPath) : null;
    const grid = bitmap ? readPngHeader(bitmap) : null;
    if (grid && grid.width === grid.height && grid.width >= 128 && grid.width % 16 === 0) {
      const chars = Array.from({ length: 8 }, (_, row) => Array.from({ length: 16 }, (_, col) => {
        const code = row * 16 + col;
        return code > 32 && code < 127 ? String.fromCharCode(code) : '\u0000';
      }).join(''));
      // 提供器的行数决定裁切网格；不猜测 Bedrock Unicode 字形页的布局。
      chars.push(...Array<string>(8).fill('\u0000'.repeat(16)));
      mapped.set(`${ROOT}font/default.json`, encode({ providers: [
        { type: 'space', advances: { ' ': 4 } },
        { type: 'bitmap', file: 'minecraft:font/default8.png', height: 8, ascent: 7, chars },
      ] }));
    }
    const en = parseLang(await source.read('texts/en_US.lang'));
    const loc = (text: string) => en[text] ?? text;
    const icon = await source.read('pack_icon.png').catch(() => null);
    const info = archive ? await stat(path) : null;
    keep = true;
    return {
      id, kind: 'pack', name: loc(header.name), uuid: header.uuid, version, enabled: true,
      ...(header.description ? { description: loc(header.description) } : {}),
      ...(icon && icon.length <= 1024 * 1024 && readPngHeader(icon) ? { icon } : {}),
      revision: `bedrock:${info ? `${info.size}:${info.mtimeMs}:${info.ctimeMs}` : 'revision' in source ? source.revision : ''}`,
      warnings: source.warnings, close: source.close,
      has: (key) => mapped.has(key),
      list: (prefix) => [...mapped.keys()].filter((key) => key.startsWith(prefix)).sort(),
      read: async (key) => {
        const mappedKey = mapped.get(key);
        return typeof mappedKey === 'string' ? source.read(mappedKey) : mappedKey ?? null;
      },
    };
  } finally {
    if (!keep) source.close();
  }
}
