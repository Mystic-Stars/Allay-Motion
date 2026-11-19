// T-TPL-2：每种参数类型的默认值、越界值、错类型、缺失（docs/04-templates.md 4.4、4.11）。
// 规则：类型不对的回到默认值，越界的钳制，多余的键丢弃，缺的补默认值。
import { describe, expect, it } from 'vitest';
import {
  PARAM_TYPES,
  ParamDefSchema,
  defaultParams,
  diffFromDefaults,
  sanitizeParams,
  sanitizeValue,
  seedOf,
  type ParamDef,
  type ParamType,
  type ParamValue,
} from '../../packages/template-sdk/src/index';

const def = (raw: Record<string, unknown>): ParamDef => ParamDefSchema.parse({ label: 'x', ...raw });

interface Case {
  def: ParamDef;
  /** 默认值（缺失时得到的值） */
  expectedDefault: ParamValue;
  /** [输入, 期望] 越界的钳制 */
  outOfRange: [unknown, ParamValue][];
  /** 类型不对的输入：都回到默认值 */
  wrongType: unknown[];
  /** 合法的输入原样保留 */
  valid: ParamValue[];
}

const CASES: Record<ParamType, Case> = {
  number: {
    def: def({ key: 'n', type: 'number', default: 0.45, min: 0.1, max: 1 }),
    expectedDefault: 0.45,
    outOfRange: [[5, 1], [-3, 0.1], [1.0000001, 1]],
    wrongType: ['0.5', null, true, Number.NaN, Number.POSITIVE_INFINITY, [0.5], { v: 1 }],
    valid: [0.1, 1, 0.7321],
  },
  integer: {
    def: def({ key: 'i', type: 'integer', default: 12, min: 4, max: 40 }),
    expectedDefault: 12,
    outOfRange: [[100, 40], [0, 4], [-7, 4], [12.4, 12], [39.6, 40]],
    wrongType: ['12', null, false, Number.NaN, []],
    valid: [4, 40, 17],
  },
  boolean: {
    def: def({ key: 'b', type: 'boolean', default: true }),
    expectedDefault: true,
    outOfRange: [],
    wrongType: [1, 0, 'true', null, {}],
    valid: [true, false],
  },
  enum: {
    def: def({ key: 'e', type: 'enum', default: 'flipY', options: [{ value: 'none', label: 'n' }, { value: 'flipY', label: 'y' }] }),
    expectedDefault: 'flipY',
    outOfRange: [['twirl', 'flipY'], ['FLIPY', 'flipY']],
    wrongType: [1, null, true, ['none']],
    valid: ['none', 'flipY'],
  },
  color: {
    def: def({ key: 'c', type: 'color', default: '#2072D5' }),
    expectedDefault: '#2072D5',
    // 没开 alpha 时去掉 alpha 通道；小写统一成大写
    outOfRange: [['#2072d580', '#2072D5'], ['#abcdef', '#ABCDEF']],
    wrongType: ['blue', '#12345', '#GGGGGG', 0x2072d5, null, ['#FFFFFF']],
    valid: ['#FFFFFF', '#000000'],
  },
  text: {
    def: def({ key: 't', type: 'text', default: { 'zh-CN': '正在加载世界', en: 'Loading world' }, maxLength: 8 }),
    expectedDefault: 'Loading ',
    outOfRange: [['一二三四五六七八九十', '一二三四五六七八'], ['😀😀😀😀😀😀😀😀😀', '😀😀😀😀😀😀😀😀']],
    wrongType: [42, null, true, ['a'], { en: 'x' }],
    valid: ['', 'hello', '八个字以内'],
  },
  block: {
    def: def({ key: 'k', type: 'block', default: 'minecraft:dirt' }),
    expectedDefault: 'minecraft:dirt',
    outOfRange: [],
    wrongType: ['dirt block', 'Minecraft:Dirt', '', 7, null, { id: 'minecraft:stone' }, `minecraft:${'x'.repeat(300)}`],
    valid: ['minecraft:stone', 'mypack:custom_block'],
  },
  blockList: {
    def: def({ key: 'bl', type: 'blockList', default: [{ id: 'minecraft:diamond_block', weight: 1 }], max: 3 }),
    expectedDefault: [{ id: 'minecraft:diamond_block', weight: 1 }],
    outOfRange: [
      // 超过 max 的截掉；权重钳制到 [0, 1000]；形状不对的条目丢掉；缺权重的取 1
      [[{ id: 'minecraft:a', weight: 1 }, { id: 'minecraft:b', weight: 2 }, { id: 'minecraft:c', weight: 3 }, { id: 'minecraft:d', weight: 4 }], [{ id: 'minecraft:a', weight: 1 }, { id: 'minecraft:b', weight: 2 }, { id: 'minecraft:c', weight: 3 }]],
      [[{ id: 'minecraft:a', weight: 5000 }], [{ id: 'minecraft:a', weight: 1000 }]],
      [[{ id: 'minecraft:a', weight: -1 }, { id: 'minecraft:b', weight: 2 }], [{ id: 'minecraft:a', weight: 0 }, { id: 'minecraft:b', weight: 2 }]],
      [[{ id: 'bad id', weight: 1 }, 'minecraft:stone', { id: 'minecraft:c' }], [{ id: 'minecraft:c', weight: 1 }]],
    ],
    // 空列表、全部条目都坏、权重全为 0 也回到默认值
    wrongType: ['minecraft:stone', null, {}, [], [{ id: 'nope' }], [{ id: 'minecraft:a', weight: 0 }]],
    valid: [[{ id: 'minecraft:stone', weight: 3 }, { id: 'minecraft:cobblestone', weight: 1 }]],
  },
  item: {
    def: def({ key: 'it', type: 'item', default: 'minecraft:diamond_sword' }),
    expectedDefault: 'minecraft:diamond_sword',
    outOfRange: [],
    wrongType: ['sword', 3, null, ''],
    valid: ['minecraft:apple'],
  },
  font: {
    def: def({ key: 'font', type: 'font', default: 'minecraft:default' }),
    expectedDefault: 'minecraft:default',
    outOfRange: [],
    wrongType: ['C:/font.ttf', 'file:../font.ttf', 'pack:../font', 'user-font:unknown', 5, null],
    valid: ['allay:fallback', 'pack:titles/main', `user-font:${'a'.repeat(64)}`],
  },
  texture: {
    def: def({ key: 'img', type: 'texture', default: '', allowFile: true }),
    expectedDefault: '',
    outOfRange: [],
    // file: 只接受主进程签发的引用；asset: 路径不能穿越
    wrongType: ['C:\\x.png', 'file:C:/x.png', 'asset:../x.png', 'asset:/x.png', 'asset:a//b.png', 'http://x/y.png', 5, null],
    valid: ['', 'minecraft:block/stone', 'asset:logo.png', 'asset:img/logo-2.png', 'file:3f2504e0-4f89-41d3-9a0c-0305e82c3301'],
  },
  sound: {
    def: def({ key: 's', type: 'sound', default: 'minecraft:block.stone.place' }),
    expectedDefault: 'minecraft:block.stone.place',
    outOfRange: [],
    wrongType: ['stone place', 1, false, ['minecraft:x']],
    valid: [null, 'minecraft:ui.toast.in', 'allay:whoosh'],
  },
  easing: {
    def: def({ key: 'ea', type: 'easing', default: 'backOut' }),
    expectedDefault: 'backOut',
    // 贝塞尔的 x 钳制到 [0, 1]，y 不限
    outOfRange: [[[1.5, 2, -0.2, -1], [1, 2, 0, -1]]],
    wrongType: ['bouncy', 3, null, [0, 0, 1], [0, 0, 1, 1, 0], ['a', 0, 1, 1], [0, Number.NaN, 1, 1]],
    valid: ['linear', 'elasticOut', [0.25, 0.1, 0.25, 1]],
  },
  duration: {
    def: def({ key: 'd', type: 'duration', default: 0.5, min: 0.15, max: 2 }),
    expectedDefault: 0.5,
    outOfRange: [[0, 0.15], [9, 2], [-1, 0.15]],
    wrongType: ['0.5s', null, true, Number.NaN],
    valid: [0.15, 2, 0.75],
  },
  angle: {
    def: def({ key: 'a', type: 'angle', default: 0, snap: 15 }),
    expectedDefault: 0,
    // 角度没有上下限：折回 [0, 360)
    outOfRange: [[360, 0], [450, 90], [-90, 270], [720.5, 0.5]],
    wrongType: ['90deg', null, Number.NaN, [90]],
    valid: [0, 15, 359.5],
  },
  seed: {
    def: def({ key: 'seed', type: 'seed', default: 1 }),
    expectedDefault: 1,
    outOfRange: [[-5, 0], [3.7, 4], [1e12, 2_147_483_647]],
    wrongType: ['42', null, Number.NaN, true],
    valid: [0, 42, 2_147_483_647],
  },
};

describe('T-TPL-2 参数类型的校验与清洗', () => {
  it('每种参数类型都有用例', () => {
    expect(Object.keys(CASES).sort()).toEqual([...PARAM_TYPES].sort());
  });

  for (const [type, c] of Object.entries(CASES)) {
    describe(type, () => {
      it('缺失时取默认值', () => {
        expect(sanitizeParams([c.def], {})).toEqual({ [c.def.key]: c.expectedDefault });
        expect(defaultParams([c.def])).toEqual({ [c.def.key]: c.expectedDefault });
      });
      it('合法的值原样保留', () => {
        for (const v of c.valid) expect(sanitizeValue(c.def, v), JSON.stringify(v)).toEqual(v);
      });
      it('越界的值钳制', () => {
        for (const [input, out] of c.outOfRange) expect(sanitizeValue(c.def, input), JSON.stringify(input)).toEqual(out);
      });
      it('类型不对的回到默认值', () => {
        for (const v of c.wrongType) expect(sanitizeValue(c.def, v), String(JSON.stringify(v))).toEqual(c.expectedDefault);
      });
    });
  }

  it('text 的多语言默认值按界面语言取一次', () => {
    const t = CASES.text.def;
    expect(defaultParams([t], { locale: 'zh-CN' })).toEqual({ t: '正在加载世界' });
    expect(defaultParams([t], { locale: 'en' })).toEqual({ t: 'Loading ' });
  });

  it('多余的键丢弃，缺的补默认值，整组一起清洗', () => {
    const defs = Object.values(CASES).map((c) => c.def);
    const out = sanitizeParams(defs, { n: 7, extra: 1, __proto__: { polluted: true }, seed: 'x' });
    expect(Object.keys(out).sort()).toEqual(defs.map((d) => d.key).sort());
    expect(out.n).toBe(1);
    expect(out.seed).toBe(1);
    expect('extra' in out).toBe(false);
    // 不是对象的整组输入也不抛错
    expect(sanitizeParams(defs, null)).toEqual(defaultParams(defs));
    expect(sanitizeParams(defs, [1, 2] as unknown as Record<string, unknown>)).toEqual(defaultParams(defs));
  });

  it('只存与默认值不同的参数', () => {
    const defs = [CASES.number.def, CASES.integer.def, CASES.text.def, CASES.blockList.def];
    expect(diffFromDefaults(defs, { n: 0.45, i: 20, t: 'Loading ', bl: [{ id: 'minecraft:diamond_block', weight: 1 }] })).toEqual({ i: 20 });
    // 与任一语言的默认值相同都算没改
    expect(diffFromDefaults(defs, { t: '正在加载世界' })).toEqual({});
    expect(diffFromDefaults(defs, { t: '正在加载' })).toEqual({ t: '正在加载' });
  });

  it('seed 类型参数作为 ctx.random 的种子', () => {
    expect(seedOf([CASES.number.def, CASES.seed.def], { n: 0.5, seed: 9 })).toBe(9);
    expect(seedOf([CASES.number.def], { seed: 9 })).toBeNull();
  });
});
