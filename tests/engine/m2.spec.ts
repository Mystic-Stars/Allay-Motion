// pnpm test:engine：M2 的引擎部分（docs/02-engine.md 2.8、03-assets.md）：贴图缺失、动画贴图、方块、物品、文字、精灵、缩略图。
// 资源来自测试页里的假资源栈（tests/engine/harness/fake-resources.ts）。
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { Harness } from './harness/harness';

const ROOT = resolve(import.meta.dirname, '../..');
const ELECTRON = createRequire(join(ROOT, 'apps/desktop/package.json'))('electron') as string;

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE' && k !== 'NODE_OPTIONS') env[k] = v;
  app = await electron.launch({ executablePath: ELECTRON, args: [join(import.meta.dirname, 'electron-main.mjs')], env });
  page = await app.firstWindow();
  await page.waitForFunction(() => window.harnessReady === true);
});

test.afterAll(async () => {
  await app?.close();
});

type Fn = { [K in keyof Harness]: Harness[K] extends (...a: infer A) => infer R ? (...a: A) => R : never };
function call<K extends keyof Harness>(name: K, ...args: Parameters<Fn[K]>): Promise<Awaited<ReturnType<Fn[K]>>> {
  return page.evaluate(
    ([n, a]) => (window.harness[n as keyof Harness] as (...x: unknown[]) => unknown)(...(a as unknown[])),
    [name, args] as const,
  ) as Promise<Awaited<ReturnType<Fn[K]>>>;
}

const HD = { width: 1920, height: 1080, fps: 20 };

function near(actual: number[], expected: number[], tol: number): void {
  expect(actual.length).toBe(expected.length);
  actual.forEach((v, i) => expect(Math.abs(v - expected[i]!), `channel ${i}: ${actual.join(',')} vs ${expected.join(',')}`).toBeLessThanOrEqual(tol));
}

/** 和引擎里一样：sRGB 系数先换到线性空间再乘，近似等于 sRGB 里直接乘 */
const shade = (c: [number, number, number], k: number) => c.map((v) => Math.round(v * k));

test('T-AST-3 引用不存在的贴图、方块、物品：得到占位图和警告，不抛错', async () => {
  const r = await call('scenario', 'missing', {}, HD, [0], [[900, 480], [1000, 480]]);
  expect(r.warnings.some((w) => w.includes('minecraft:block/does_not_exist') && w.includes('placeholder'))).toBe(true);
  expect(r.warnings.some((w) => w.includes('minecraft:not_a_block'))).toBe(true);
  expect(r.warnings.some((w) => w.includes('minecraft:not_an_item'))).toBe(true);
  // 品红与黑的棋盘
  near(r.frames[0]![0]!, [248, 0, 248, 255], 1);
  near(r.frames[0]![1]!, [0, 0, 0, 255], 1);
});

test('T-AST-4（引擎）4 帧动画贴图、frametime 2：t = 0, 0.1, 0.2, 0.3, 0.4 依次显示第 0, 1, 2, 3, 0 帧', async () => {
  const colors = await call('animColors');
  // 20 fps：第 0、2、4、6、8 帧就是 t = 0 … 0.4
  const r = await call('scenario', 'anim', {}, HD, [0, 2, 4, 6, 8], [[960, 540]]);
  expect(r.warnings).toEqual([]);
  const seq = [0, 1, 2, 3, 0];
  r.frames.forEach((f, i) => near(f[0]!, [...colors[seq[i]!]!, 255], 1));
});

test('方块：面明暗、shading: false、着色、逐实例不透明度与染色', async () => {
  const stone = await call('fakeColor', 'minecraft:block/stone');
  const grassTop = await call('fakeColor', 'minecraft:block/grass_block_top');
  const wool = await call('fakeColor', 'minecraft:block/white_wool');
  const r = await call('scenario', 'block', {}, HD, [0], [[360, 540], [660, 540], [960, 540], [1260, 540], [1560, 540], [100, 100]]);
  expect(r.warnings).toEqual([]);
  const [south, flat, grass, half, red, empty] = r.frames[0]!;
  near(south!, [...shade(stone, 0.8), 255], 3);
  near(flat!, [...stone, 255], 1);
  // 草的着色 #91BD59 乘在贴图上（顶面明暗 1.0）。游戏在 sRGB 里相乘，引擎在线性空间里乘（顶点色），
  // 两者只在 sRGB 曲线偏离幂函数的地方差一点：暗色上差到 4–5（decisions.md M2b）
  near(grass!, [Math.round((grassTop[0] * 0x91) / 255), Math.round((grassTop[1] * 0xbd) / 255), Math.round((grassTop[2] * 0x59) / 255), 255], 6);
  near(half!, [...shade(wool, 0.8), 128], 3);
  near(red!, [Math.round(wool[0] * 0.8), 0, 0, 255], 3);
  expect(empty![3]).toBe(0);
});

test('物品：按不透明像素挤出，透明的部分没有几何', async () => {
  const diamond = await call('fakeColor', 'minecraft:item/diamond');
  const r = await call('scenario', 'item', {}, HD, [0], [[880, 540], [1040, 540], [1040, 400]]);
  expect(r.warnings).toEqual([]);
  const [left, right, upper] = r.frames[0]!;
  expect(left![3]).toBe(0);
  near(right!, [...diamond, 255], 1);
  near(upper!, [...diamond, 255], 1);
});

test('文字：资源栈的位图字体（墨水宽度 + 1 像素间距）、阴影为正文颜色 × 0.25', async () => {
  await call('setFakeVanillaFont', true);
  try {
    // A、B 的墨水宽度 2、3 → 前进 3、4，共 7 个字体像素；高 8。size 10 → 70×80
    const r = await call('scenario', 'text', { text: 'AB' }, HD, [0], [[65, 205], [85, 205], [85, 215]]);
    expect(r.warnings).toEqual(['text-size:70x80']);
    const [ink, gap, shadow] = r.frames[0]!;
    near(ink!, [255, 255, 255, 255], 1);
    expect(gap![3]).toBe(0);
    near(shadow!, [64, 64, 64, 255], 1);
  } finally {
    await call('setFakeVanillaFont', false);
  }
});

test('T-AST-FONT 空资源栈使用系统字体，真正缺字时报警告', async () => {
  const ok = await call('scenario', 'text', { text: 'A中あ한' }, HD, [0], []);
  expect(ok.warnings).toHaveLength(1);
  const [w, h] = ok.warnings[0]!.replace('text-size:', '').split('x').map(Number);
  expect(w).toBeGreaterThan(100);
  expect(h).toBeGreaterThan(40);
  expect(h).toBeLessThan(130);
  const missing = await call('scenario', 'text', { text: 'A\u{10FFFD}' }, HD, [0], []);
  expect(missing.warnings.some((m) => m.includes('no glyph') && m.includes('U+10FFFD'))).toBe(true);
});

test('精灵：九宫格的边框不拉伸，中间拉伸', async () => {
  // 800×400、边框 4 像素 × pixelSize 10 = 40：x 560–1360，y 340–740
  const r = await call('scenario', 'sprite', {}, HD, [0], [[570, 540], [590, 540], [610, 540], [960, 540], [1350, 540], [960, 350], [960, 730], [550, 540]]);
  expect(r.warnings).toEqual([]);
  const [l1, l2, inner, center, right, top, bottom, outside] = r.frames[0]!;
  for (const p of [l1, l2, right, top, bottom]) near(p!, [255, 0, 0, 255], 1);
  for (const p of [inner, center]) near(p!, [0, 255, 0, 255], 1);
  expect(outside![3]).toBe(0);
});

test('缩略图：方块（等轴视角、面明暗）和物品，64 与 128 两档', async () => {
  for (const size of [64, 128] as const) {
    const block = await call('thumbnail', 'block', 'minecraft:stone', size);
    expect(block.width).toBe(size);
    expect(block.height).toBe(size);
    expect(block.center[3]).toBe(255);
    expect(block.corner).toBe(0);
    expect(block.opaqueFraction).toBeGreaterThan(0.4);
    expect(block.opaqueFraction).toBeLessThan(0.9);
  }
  const item = await call('thumbnail', 'item', 'minecraft:diamond', 64);
  expect(item.opaqueFraction).toBeGreaterThan(0.2);
  expect(item.opaqueFraction).toBeLessThan(0.6);
});
