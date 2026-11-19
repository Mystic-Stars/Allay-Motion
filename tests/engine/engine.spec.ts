// pnpm test:engine：帧管线的验收测试（docs/02-engine.md 2.6 的 T-ENG-1 至 T-ENG-5），以及 Worker 里的隔离与看门狗。
// 在 Electron 自带的 Chromium 里跑真实的 WebGL2：窗口不显示、不抢焦点（docs/decisions.md“测试在后台运行”）。
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { Harness, TemplateName } from './harness/harness';
import { isSoftwareRenderer, SOFTWARE_LIMITS } from './software';

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
/** 在测试页里调用 window.harness 的方法 */
function call<K extends keyof Harness>(name: K, ...args: Parameters<Fn[K]>): Promise<Awaited<ReturnType<Fn[K]>>> {
  return page.evaluate(
    ([n, a]) => (window.harness[n as keyof Harness] as (...x: unknown[]) => unknown)(...(a as unknown[])),
    [name, args] as const,
  ) as Promise<Awaited<ReturnType<Fn[K]>>>;
}

const HD = { width: 1920, height: 1080, fps: 60 };
const N1 = { subframes: 1, shutterAngle: 180 };
const STANDARD = { subframes: 8, shutterAngle: 180 };
const BLOCK: TemplateName = 'blockWipe';

test('T-ENG-COMP-1 合成 Worker：独立来源与相机、线性透明混合、先合成再模糊、乱序、关闭', async () => {
  const result = await call('probeComposition');
  expect(result.loaded.totalFrames).toBe(4);
  expect(result.loaded.audioCues.map(({ at, clip }) => [at, clip?.end, clip?.offset, clip?.profile])).toEqual([
    [0, 2 / 30, 0, 'red'], [1 / 30, 3 / 30, 2 / 30, 'blue'],
  ]);
  expect(result.overlap).toEqual([156, 0, 213, 191]);
  expect(result.independent[2]).toBe(255);
  expect(result.independent[0]).toBe(0);
  for (const [channel, value] of result.previewPixel.entries()) {
    const expected = channel === 3 ? result.overlap[3]! : result.overlap[channel]! * result.overlap[3]! / 255;
    expect(Math.abs(value - expected)).toBeLessThanOrEqual(1);
  }
  expect(result.first.slice(0, 3)).toEqual([255, 0, 0]);
  expect(result.afterRed.slice(0, 3)).toEqual([0, 0, 255]);
  expect(result.transparent).toEqual([0, 0, 0, 0]);
  expect(result.opaque).toEqual([0, 255, 0, 255]);
  expect(result.shutter).toEqual([188, 0, 188, 255]);
  expect(result.seek).toBeNull();
  expect(result.invalid).toBe(true);
  expect(result.editTextureReads).toBe(0);
  expect(result.rejected).toBe(true);
  expect(result.afterReject).toEqual(result.shutter);
  expect(result.cleared).toEqual([0, 0, 0, 0]);
});

test('T-ENG-1 确定性：全部帧顺序渲染一遍、乱序渲染一遍，逐字节相同', async () => {
  const output = { width: 1280, height: 720, fps: 60 };
  const seq = await call('frameHashes', BLOCK, output, STANDARD, false);
  const shuf = await call('frameHashes', BLOCK, output, STANDARD, true);
  expect(seq.hashes.length).toBe(await call('frameCount', seq.duration, 60));
  expect(shuf.order).not.toEqual(seq.order);
  expect(shuf.hashes).toEqual(seq.hashes);
  // 不是所有帧都一样（确实在动）
  expect(new Set(seq.hashes).size).toBeGreaterThan(seq.hashes.length / 2);
});

test('T-ENG-1 同一个 Worker 里穿插渲染别的帧后，同一帧仍逐字节相同', async () => {
  const r = await call('selfCheck', BLOCK, { width: 960, height: 540, fps: 60 }, 20, [50, 3, 66, 0, 33]);
  expect(r.second).toBe(r.first);
});

test('T-ENG-2 alpha：50% 白为 (255,255,255,128±1)，不透明红为 (255,0,0,255)，矩形外 alpha 为 0', async () => {
  // 1920×1080 时 1 设计单位 = 1 像素；白矩形中心在 (−400, 0)，红矩形中心在 (400, 0)
  const points: [number, number][] = [
    [560, 540],
    [460, 440],
    [1360, 540],
    [1259, 640],
    [10, 10],
    [960, 540],
    [1900, 1070],
  ];
  for (const quality of [N1, STANDARD]) {
    const r = await call('samplePixels', 'alphaRects', HD, 30, quality, points);
    expect(r.length).toBe(1920 * 1080 * 4);
    for (const p of r.pixels.slice(0, 2)) {
      expect(p.slice(0, 3)).toEqual([255, 255, 255]);
      expect(Math.abs(p[3]! - 128)).toBeLessThanOrEqual(1);
    }
    for (const p of r.pixels.slice(2, 4)) expect(p).toEqual([255, 0, 0, 255]);
    for (const p of r.pixels.slice(4)) expect(p[3]).toBe(0);
  }
});

test('T-ENG-3 运动模糊守恒：N = 16、A = 180，行 alpha 之和 = 宽度 × 255（误差 ≤ 1%），两端单调过渡', async () => {
  const row = await call('rowAlpha', 'movingRect', HD, 3, { subframes: 16, shutterAngle: 180 }, 540);
  const sum = row.reduce((a, b) => a + b, 0);
  const expected = 300 * 255;
  expect(Math.abs(sum - expected) / expected).toBeLessThanOrEqual(0.01);
  // 先单调不减到 255，保持，再单调不增
  const first = row.findIndex((a) => a > 0);
  const last = row.length - 1 - [...row].reverse().findIndex((a) => a > 0);
  const peak = row.indexOf(255);
  expect(peak).toBeGreaterThan(first);
  let i = first;
  for (; i < row.length - 1 && row[i + 1]! >= row[i]!; i++);
  for (; i < last; i++) expect(row[i + 1]!, `x=${i + 1}`).toBeLessThanOrEqual(row[i]!);
  // 快门 180° = 半帧 = 100 设计单位的拖影：左右各约 100 像素的过渡
  const ramp = row.slice(first, peak).length;
  expect(ramp).toBeGreaterThan(80);
  expect(ramp).toBeLessThan(120);
});

test('T-ENG-4 预览与导出一致：同一 t、同一分辨率、N = 1', async () => {
  const gpu = await call('gpu');
  // 软件渲染（CI）的 8 位预乘画布按截断取整，alpha ≥ 128 的像素放宽到 ≤ 2（tests/engine/software.ts）
  const highLimit = isSoftwareRenderer(gpu) ? SOFTWARE_LIMITS.previewColorHigh : 1;
  test.info().annotations.push({ type: 'renderer', description: `${gpu}（alpha ≥ 128 判定 ≤ ${highLimit}）` });
  const results = await call('previewVsExport', BLOCK, { width: 960, height: 540, fps: 60 }, [6, 12, 20, 33, 50, 60]);
  for (const r of results) {
    // 诊断（docs/decisions.md M8）：alpha ≥ 128 里差得最多的像素，打进日志
    if (r.colorHigh > 1) console.log(`[T-ENG-4] ${gpu} frame ${r.index} colorHigh=${r.colorHigh} worst=${JSON.stringify(r.worstHigh)}`);
    expect(r.length).toBe(true);
    expect(r.nonEmpty, `frame ${r.index} draws something`).toBeGreaterThan(0);
    expect(r.alpha, `frame ${r.index} alpha`).toBeLessThanOrEqual(1);
    // 预览画布是 8 位预乘：换算回直通 alpha 后，alpha 越小量化误差越大（±0.5 × 255 / a）。
    // 不透明和 alpha ≥ 128 的像素按规格要求 ≤ 1；全部像素在预乘域里比较也 ≤ 1（见 docs/decisions.md M1）。
    expect(r.colorOpaque, `frame ${r.index} opaque colour`).toBeLessThanOrEqual(1);
    expect(r.colorHigh, `frame ${r.index} colour where a ≥ 128`).toBeLessThanOrEqual(highLimit);
    expect(r.premul, `frame ${r.index} premultiplied`).toBeLessThanOrEqual(1);
  }
});

test('T-ENG-5 分辨率无关：1080p 与 2160p 缩小一半的平均绝对误差 ≤ 2/255', async () => {
  for (const index of [12, 20, 33]) {
    const r = await call('resolutionIndependence', BLOCK, HD, index, STANDARD);
    expect(r.opaqueFraction).toBeGreaterThan(0.05);
    expect(r.mae, `frame ${index}`).toBeLessThanOrEqual(2);
  }
});

test('T1 默认参数：首末帧全透明，剪辑点完全不透明（04-templates.md 4.6）', async () => {
  for (const output of [HD, { width: 1080, height: 1920, fps: 60 }, { width: 1080, height: 1080, fps: 60 }]) {
    const r = await call('alphaRange', BLOCK, output, [0, 33, -1], STANDARD);
    expect(r.cutTime).toBeCloseTo(0.55, 6);
    const [first, cut, last] = r.frames;
    expect(first!.max).toBe(0);
    expect(cut!.index).toBe(Math.round(0.55 * 60));
    expect(cut!.min).toBe(255);
    expect(last!.max).toBe(0);
  }
});

test('开发构建里 update 期间调用 Math.random 会抛错（2.4）', async () => {
  const r = await call('expectFailure', 'randomInUpdate', { width: 256, height: 144, fps: 30 });
  expect(r.failed).toBe(true);
  expect(r.message).toMatch(/Math\.random\(\) is not allowed/);
  expect(r.dead).toBe(false);
});

test('T-ARC-4 源码里有 import() 的模板在装载前被拒绝', async () => {
  const r = await call('expectFailure', 'usesImport', { width: 256, height: 144, fps: 30 });
  expect(r.failed).toBe(true);
  expect(r.name).toBe('TemplateCodeError');
});

test('T-ARC-4 模板拿不到 window、self.allay、fetch、indexedDB，也不能经 Function/eval 做动态 import()', async () => {
  const warnings = await call('loadWarnings', 'escapeAttempts', { width: 256, height: 144, fps: 30 });
  const got = Object.fromEntries(warnings.map((w) => w.split('=') as [string, string]));
  expect(got).toMatchObject({
    window: 'undefined',
    document: 'undefined',
    allay: 'undefined',
    selfAllay: 'undefined',
    fetch: 'undefined',
    XMLHttpRequest: 'undefined',
    WebSocket: 'undefined',
    EventSource: 'undefined',
    indexedDB: 'undefined',
    caches: 'undefined',
    importScripts: 'undefined',
    BroadcastChannel: 'undefined',
  });
  expect(got.dynamicImport).toMatch(/^blocked/);
  expect(got.eval).toMatch(/^blocked/);
});

test('T-ARC-5（引擎层）update 死循环：看门狗在时限内终止 Worker', async () => {
  const r = await call('expectFailure', 'hangUpdate', { width: 256, height: 144, fps: 30 }, { exportFrame: 2000 });
  expect(r.failed).toBe(true);
  expect(r.name).toBe('EngineUnresponsiveError');
  expect(r.dead).toBe(true);
  expect(r.ms).toBeLessThan(2000 + 1500);
});
