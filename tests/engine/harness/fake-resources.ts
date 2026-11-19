// test:engine 的假资源栈：纯色色块和几张拼出来的测试图，只是测试数据，不是产品素材（docs/09-compliance.md 9.6）。
import { DEFAULT_FONT_ID, type ResourceKind, type ResourcePayload } from '../../../packages/template-sdk/src/index';
import { TEST_SKIN_REF, testSkinRgba } from '../../fixtures/builtin-template-names';

export const FAKE_STAMP = 'test-fake-1';

/** 由 ID 散列出的颜色（RGB），测试据此核对“这张贴图来自假资源栈” */
export function fakeColor(id: string): [number, number, number] {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h >>>= 0;
  return [64 + (h & 127), 64 + ((h >> 8) & 127), 64 + ((h >> 16) & 127)];
}

function image(width: number, height: number, at: (x: number, y: number) => [number, number, number, number]): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(at(x, y), (y * width + x) * 4);
  return data;
}

/** 动画测试图的四帧颜色 */
export const ANIM_COLORS: [number, number, number][] = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [255, 255, 255],
];

let vanillaFont = false;
/** 打开后 minecraft:default 返回一套拼出来的测试字体（每个字形是宽度不同的实心矩形） */
export function setFakeVanillaFont(on: boolean): void {
  vanillaFont = on;
}

/** 测试字体：2×2 个 8×8 的格子，A B C D 的墨水宽度分别是 2、3、4、5 列，高 7 行 */
function testFont(): ResourcePayload {
  const widths = [2, 3, 4, 5];
  const data = image(16, 16, (x, y) => {
    const cell = (y >> 3) * 2 + (x >> 3);
    return (x & 7) < widths[cell]! && (y & 7) < 7 ? [255, 255, 255, 255] : [0, 0, 0, 0];
  });
  return {
    kind: 'font',
    providers: [
      { type: 'space', advances: [[0x20, 4]] },
      { type: 'bitmap', ascent: 7, height: 8, rows: [[0x41, 0x42], [0x43, 0x44]], image: { width: 16, height: 16, data } },
    ],
    skipped: [],
  };
}

export async function fakeResolveResource(kind: ResourceKind, id: string): Promise<ResourcePayload | null> {
  if (kind === 'font') return vanillaFont && id === DEFAULT_FONT_ID ? testFont() : null;
  if (kind === 'sound-meta') {
    // M6b：多变体事件（权重 1、2、1）和单变体事件；其余事件没有定义
    if (id === 'test:multi') {
      return {
        kind: 'sound',
        variants: [
          { file: 'test:multi/a', volume: 1, pitch: 1, weight: 1 },
          { file: 'test:multi/b', volume: 0.8, pitch: 1.1, weight: 2 },
          { file: 'test:multi/c', volume: 1, pitch: 0.9, weight: 1 },
        ],
      };
    }
    if (id === 'test:single') return { kind: 'sound', variants: [{ file: 'test:single/only', volume: 0.5, pitch: 1.2, weight: 1 }] };
    return null;
  }
  if (kind !== 'texture') return null;
  if (id === TEST_SKIN_REF) return { kind: 'rgba', width: 64, height: 64, data: testSkinRgba() };
  if (id.includes('does_not_exist') || id.includes('missing')) return null;
  if (id === 'minecraft:ui/loading_bar') {
    return { kind: 'rgba', width: 640, height: 8, data: image(640, 8, (x) => [30 + Math.floor(x / 64) * 20, 20, 30, 255]) };
  }
  if (id === 'test:anim') {
    const data = image(16, 64, (_x, y) => [...ANIM_COLORS[y >> 4]!, 255]);
    return { kind: 'rgba', width: 16, height: 64, data, mcmeta: JSON.stringify({ animation: { frametime: 2 } }) };
  }
  if (id === 'test:panel') {
    // 4 像素宽的红边框，中间绿色（九宫格测试）
    const data = image(16, 16, (x, y) => (x < 4 || y < 4 || x >= 12 || y >= 12 ? [255, 0, 0, 255] : [0, 255, 0, 255]));
    return { kind: 'rgba', width: 16, height: 16, data };
  }
  if (id === 'minecraft:item/diamond') {
    // 左半边透明，右半边不透明（物品挤出测试）
    const c = fakeColor(id);
    const data = image(16, 16, (x) => (x < 8 ? [0, 0, 0, 0] : [...c, 255]));
    return { kind: 'rgba', width: 16, height: 16, data };
  }
  const c = fakeColor(id);
  return { kind: 'rgba', width: 16, height: 16, data: image(16, 16, () => [...c, 255]) };
}
