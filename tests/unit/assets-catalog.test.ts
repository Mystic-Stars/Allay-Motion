import { describe, expect, it } from 'vitest';
import {
  BLOCKS,
  buildStack,
  DEFAULT_RESOURCE_STACK_SETTINGS,
  displayName,
  expandSoundEvent,
  findGlyph,
  findMissing,
  glyphAdvance,
  glyphInkWidth,
  ITEMS,
  mergeSoundDefinitions,
  NAMES,
  parseFontJson,
  parseResourceId,
  parseSoundsJson,
  pickSoundVariant,
  resolveBlockFaces,
  resolveFontProviders,
  requiredTextures,
  searchCatalog,
  SOUND_EVENTS,
  textureIdToPath,
  tintRgb,
  TINTS,
  type ResourceLayer,
} from '../../packages/assets/src/index';

// 03-assets.md 3.7 的 v1 方块与物品清单（与文档逐项核对）
const COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];
const SPEC_BLOCKS = [
  ...'stone cobblestone deepslate dirt grass_block sand gravel snow_block ice packed_ice netherrack end_stone bedrock obsidian crying_obsidian magma_block'.split(' '),
  ...'oak_planks spruce_planks birch_planks dark_oak_planks oak_log spruce_log birch_log oak_leaves spruce_leaves birch_leaves'.split(' '),
  ...'bricks stone_bricks deepslate_bricks nether_bricks quartz_block smooth_stone glass bookshelf hay_block'.split(' '),
  ...'coal_ore iron_ore copper_ore gold_ore redstone_ore lapis_ore diamond_ore emerald_ore'.split(' '),
  ...'coal_block iron_block copper_block gold_block redstone_block lapis_block diamond_block emerald_block netherite_block amethyst_block'.split(' '),
  ...'crafting_table furnace tnt note_block jukebox glowstone sea_lantern pumpkin melon slime_block honey_block'.split(' '),
  ...COLORS.flatMap((c) => [`${c}_wool`, `${c}_concrete`, `${c}_terracotta`]),
];
const SPEC_ITEMS =
  'diamond_sword iron_sword netherite_sword golden_sword diamond_pickaxe iron_pickaxe netherite_pickaxe diamond_axe diamond_shovel bow arrow diamond emerald gold_ingot iron_ingot netherite_ingot copper_ingot redstone lapis_lazuli coal amethyst_shard apple golden_apple bread cooked_beef ender_pearl ender_eye blaze_rod nether_star totem_of_undying firework_rocket book enchanted_book compass clock bucket water_bucket lava_bucket experience_bottle snowball stick music_disc_13'.split(
    ' ',
  );

describe('方块目录、物品目录、名称表、着色常量（3.7）', () => {
  it('目录与规格清单一致，名称表两种语言齐全', () => {
    expect(Object.keys(BLOCKS).sort()).toEqual(SPEC_BLOCKS.map((b) => `minecraft:${b}`).sort());
    expect(Object.keys(ITEMS).sort()).toEqual(SPEC_ITEMS.map((b) => `minecraft:${b}`).sort());
    for (const id of [...Object.keys(BLOCKS), ...Object.keys(ITEMS)]) {
      expect(NAMES[id]?.['zh-CN'], id).toBeTruthy();
      expect(NAMES[id]?.en, id).toBeTruthy();
    }
  });

  it('着色常量：规格给的三个值，云杉与白桦已填', () => {
    expect(TINTS).toMatchObject({ grass: '#91BD59', foliage: '#77AB2F', water: '#3F76E4' });
    expect(TINTS.foliage_spruce).toMatch(/^#[0-9A-F]{6}$/);
    expect(TINTS.foliage_birch).toMatch(/^#[0-9A-F]{6}$/);
    expect(tintRgb('grass')[0]).toBeCloseTo(0x91 / 255);
  });

  it('展开六个面', () => {
    const grass = resolveBlockFaces(BLOCKS['minecraft:grass_block']!);
    expect(grass.faces.up).toEqual({ texture: 'minecraft:block/grass_block_top', tint: 'grass' });
    expect(grass.faces.down.texture).toBe('minecraft:block/dirt');
    expect(grass.sideOverlay).toEqual({ texture: 'minecraft:block/grass_block_side_overlay', tint: 'grass' });
    const furnace = resolveBlockFaces(BLOCKS['minecraft:furnace']!);
    expect(furnace.faces.north.texture).toBe('minecraft:block/furnace_front');
    expect(furnace.faces.down.texture).toBe('minecraft:block/furnace_top');
    expect(resolveBlockFaces(BLOCKS['minecraft:glass']!).render).toBe('cutout');
    expect(resolveBlockFaces(BLOCKS['minecraft:stone']!).sideOverlay).toBeUndefined();
  });

  it('搜索与显示名', () => {
    const ids = Object.keys(BLOCKS);
    expect(searchCatalog('钻石', ids)).toEqual(['minecraft:diamond_ore', 'minecraft:diamond_block']);
    expect(searchCatalog('Diamond Ore', ids)).toEqual(['minecraft:diamond_ore']);
    expect(displayName('stone', 'zh-CN')).toBe('石头');
    expect(displayName('minecraft:unknown_thing', 'en')).toBe('minecraft:unknown_thing');
  });

  it('资源 ID', () => {
    expect(textureIdToPath('block/stone')).toBe('assets/minecraft/textures/block/stone.png');
    expect(parseResourceId('minecraft:../x')).toBeNull();
    expect(parseResourceId('Minecraft:Stone')).toBeNull();
  });
});

describe('目录覆盖率', () => {
  it('列出方块、物品目录和界面贴图引用的全部贴图，报告某一层缺哪些', () => {
    const required = requiredTextures(['minecraft:block/extra_for_template']);
    expect(required.length).toBeGreaterThan(180);
    const present = new Set(required.filter((r) => r.source !== 'template').flatMap((r) => r.anyOf));
    expect(findMissing(required, (p) => present.has(p)).map((m) => m.id)).toEqual(['minecraft:block/extra_for_template']);
  });
});

describe('音效（3.8）', () => {
  const vanillaLike = JSON.stringify({ 'block.stone.place': { sounds: ['dig/stone1', { name: 'dig/stone2', weight: 3 }] } });

  it('模板音效事件表与规格一致', () => {
    expect(SOUND_EVENTS).toHaveLength(11);
    expect(SOUND_EVENTS).toContain('allay:whoosh');
  });

  it('上层追加变体，replace 替换；只来自 builtin 的定义被上层整个替换', () => {
    const b = { kind: 'builtin' as const, parsed: parseSoundsJson('{"block.stone.place":{"sounds":["fallback/place"]}}', 'minecraft') };
    const vanilla = { kind: 'vanilla' as const, parsed: parseSoundsJson(vanillaLike, 'minecraft') };
    const pack = { kind: 'pack' as const, parsed: parseSoundsJson('{"block.stone.place":{"sounds":["custom:x"]},"ui.button.click":{"replace":true,"sounds":["a"]}}', 'minecraft') };
    const defs = mergeSoundDefinitions([b, vanilla, pack]);
    expect(expandSoundEvent(defs, 'minecraft:block.stone.place').map((v) => v.file)).toEqual(['minecraft:dig/stone1', 'minecraft:dig/stone2', 'custom:x']);
    expect(expandSoundEvent(defs, 'minecraft:ui.button.click').map((v) => v.file)).toEqual(['minecraft:a']);
    expect(expandSoundEvent(mergeSoundDefinitions([b]), 'minecraft:block.stone.place').map((v) => v.file)).toEqual(['minecraft:fallback/place']);
  });

  it('event 引用展开、环检测、按权重选择', () => {
    const defs = mergeSoundDefinitions([
      { kind: 'pack', parsed: parseSoundsJson('{"a":{"sounds":[{"name":"b","type":"event"},"x"]},"b":{"sounds":[{"name":"a","type":"event"},{"name":"y","weight":3}]}}', 'minecraft') },
    ]);
    const variants = expandSoundEvent(defs, 'a');
    expect(variants.map((v) => v.file)).toEqual(['minecraft:y', 'minecraft:x']);
    expect(pickSoundVariant(variants, 0)?.file).toBe('minecraft:y');
    expect(pickSoundVariant(variants, 0.99)?.file).toBe('minecraft:x');
    expect(pickSoundVariant([], 0.5)).toBeNull();
  });
});

describe('字体提供器（3.9）', () => {
  it('按顺序解析 bitmap、space、reference、unihex 和 ttf', async () => {
    const fonts: Record<string, string> = {
      'assets/minecraft/font/default.json': JSON.stringify({
        providers: [
          { type: 'reference', id: 'minecraft:include/space' },
          { type: 'bitmap', file: 'minecraft:font/ascii.png', ascent: 7, chars: ['AB', 'C\u0000'] },
          { type: 'unihex', hex_file: 'x.zip' },
          { type: 'ttf', file: 'x.ttf' },
        ],
      }),
      'assets/minecraft/font/include/space.json': JSON.stringify({ providers: [{ type: 'space', advances: { ' ': 4, '\u200c': 0 } }] }),
    };
    const resolved = await resolveFontProviders('minecraft:default', async (path) => (fonts[path] ? [parseFontJson(fonts[path])] : null));
    expect(resolved.providers.map((p) => p.type)).toEqual(['space', 'bitmap', 'unihex', 'ttf']);
    expect(resolved.skipped).toEqual([]);
    expect(findGlyph(resolved.providers, 'C'.codePointAt(0)!)).toMatchObject({ kind: 'bitmap', file: 'assets/minecraft/textures/font/ascii.png', row: 1, col: 0, rows: 2, cols: 2 });
    expect(findGlyph(resolved.providers, 0x20)).toEqual({ kind: 'space', advance: 4 });
    expect(findGlyph(resolved.providers, 0x4e2d)).toBeNull();
  });

  it('reference 成环不会死循环', async () => {
    const loop = JSON.stringify({ providers: [{ type: 'reference', id: 'minecraft:default' }] });
    const r = await resolveFontProviders('minecraft:default', async () => [parseFontJson(loop)]);
    expect(r.providers).toEqual([]);
    expect(r.skipped.some((s) => s.startsWith('reference-cycle'))).toBe(true);
  });

  it('字形宽度：最右侧不透明列 + 1，字间距 1，空格 4', () => {
    const ink = glyphInkWidth(8, 8, (x, y) => (x <= 4 && y === 3 ? 255 : 0));
    expect(ink).toBe(5);
    expect(glyphAdvance(0x41, ink)).toBe(6);
    expect(glyphAdvance(0x20, 0)).toBe(4);
    expect(glyphInkWidth(8, 8, () => 0)).toBe(0);
  });
});

describe('资源栈配置（M2b 接进设置）', () => {
  const layer = (id: string, kind: ResourceLayer['kind']): ResourceLayer => ({
    id,
    kind,
    name: id,
    enabled: true,
    revision: '1',
    has: () => false,
    read: async () => null,
    list: () => [],
  });

  it('按设置排好；没同意时不加原版层；打不开的包跳过', () => {
    const packs = new Map([['p1', layer('p1', 'pack')]]);
    const settings = {
      vanilla: { consent: true, enabled: false, dir: null },
      packs: [
        { id: 'p1', name: 'P1', source: { kind: 'folder' as const, path: 'D:/p1' }, enabled: true },
        { id: 'gone', name: 'Gone', source: { kind: 'folder' as const, path: 'D:/gone' }, enabled: true },
      ],
    };
    const stack = buildStack(layer('builtin', 'builtin'), layer('vanilla', 'vanilla'), packs, settings);
    expect(stack.map((l) => [l.id, l.enabled])).toEqual([
      ['builtin', true],
      ['vanilla', false],
      ['p1', true],
    ]);
    expect(buildStack(layer('builtin', 'builtin'), layer('vanilla', 'vanilla'), packs, DEFAULT_RESOURCE_STACK_SETTINGS).map((l) => l.id)).toEqual(['builtin']);
  });
});
