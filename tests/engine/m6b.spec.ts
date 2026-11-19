// pnpm test:engine 的 M6b 部分：BlockHandle.faceTexture、着色器编译失败的警告、音频 cue 的变体选择（02-engine.md 2.10）。
// 在 Electron 自带的 Chromium 里跑：窗口不显示、不抢焦点（docs/decisions.md“测试在后台运行”）。
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

const SMALL = { width: 256, height: 144, fps: 30 };

function near(actual: number[], expected: number[], tol: number, what: string): void {
  expect(actual.length, what).toBe(expected.length);
  actual.forEach((v, i) => expect(Math.abs(v - expected[i]!), `${what} channel ${i}: ${actual.join(',')} vs ${expected.join(',')}`).toBeLessThanOrEqual(tol));
}

test('M6b BlockHandle.faceTexture：每个面取方块目录里那一面的贴图（草方块的顶、侧、底各不相同，熔炉正面朝北（方块目录的约定））', async () => {
  const cases: [string, string, string][] = [
    ['minecraft:grass_block', 'up', 'minecraft:block/grass_block_top'],
    ['minecraft:grass_block', 'south', 'minecraft:block/grass_block_side'],
    ['minecraft:grass_block', 'down', 'minecraft:block/dirt'],
    ['minecraft:oak_log', 'up', 'minecraft:block/oak_log_top'],
    ['minecraft:oak_log', 'east', 'minecraft:block/oak_log'],
    ['minecraft:furnace', 'north', 'minecraft:block/furnace_front'],
    ['minecraft:furnace', 'south', 'minecraft:block/furnace_side'],
  ];
  for (const [block, face, texture] of cases) {
    const r = await call('m6b', { scenario: 'faceTexture', block, face }, SMALL, [[128, 72]]);
    const expected = await call('fakeColor', texture);
    // 贴图不带着色、不带面明暗：中心像素就是假资源栈给这张贴图的颜色（sRGB 往返的取整误差 ≤ 1）
    near(r.pixels[0]!, [...expected, 255], 1, `${block} ${face}`);
    expect(r.warnings).toEqual([]);
  }
});

test('M6b BlockHandle.faceTexture：不合法的面名抛错，方块目录里没有的方块返回占位贴图并记警告', async () => {
  const r =await call('m6b', { scenario: 'faceTexture', block: 'minecraft:stone', face: 'front' }, SMALL).catch((e: unknown) => ({ error: String(e) }));
  expect('error' in r && /invalid block face/.test(r.error)).toBe(true);
  const missing = await call('m6b', { scenario: 'faceTexture', block: 'minecraft:not_a_block', face: 'up' }, SMALL, [[128, 72]]);
  expect(missing.warnings.some((w) => /not in the block catalog/.test(w))).toBe(true);
});

test('M6b 着色器编译失败：装载结果里有一条模板警告（以前只在控制台出现）', async () => {
  const r = await call('m6b', { scenario: 'badShader' }, SMALL);
  expect(r.warnings.some((w) => w.startsWith('shader failed to compile'))).toBe(true);
  // 正常模板没有这条警告
  const ok = await call('m6b', { scenario: 'faceTexture', block: 'minecraft:stone', face: 'up' }, SMALL);
  expect(ok.warnings).toEqual([]);
});

test('M6b cue 变体：引擎按 random(sound:事件:序号) 选定并写进 cue；两次装载、改参数再改回，选到的完全相同', async () => {
  const a = await call('m6b', { scenario: 'cues', seed: 7 }, SMALL);
  const b = await call('m6b', { scenario: 'cues', seed: 7 }, SMALL);
  expect(b.audioCues).toEqual(a.audioCues);
  // null 的 cue 不进列表；资源栈里没有的事件 variant 为 null，不产生引擎警告（宿主静音并提示）
  expect(a.audioCues).toHaveLength(8);
  expect(a.warnings).toEqual([]);
  const multi = a.audioCues.filter((c) => c.sound === 'test:multi');
  expect(multi).toHaveLength(6);
  for (const c of multi) expect(['test:multi/a', 'test:multi/b', 'test:multi/c']).toContain(c.variant?.file);
  // 6 个 cue 不全是同一个变体（权重 1:2:1）
  expect(new Set(multi.map((c) => c.variant?.file)).size).toBeGreaterThan(1);
  const single = a.audioCues.find((c) => c.sound === 'test:single');
  expect(single).toEqual({ sound: 'test:single', at: 0.2, gain: 1, rate: 1.5, pan: -0.5, variant: { file: 'test:single/only', volume: 0.5, pitch: 1.2 } });
  expect(a.audioCues.find((c) => c.sound === 'minecraft:does_not_exist')?.variant).toBeNull();

  const r = await call('m6bReparam', { scenario: 'cues', seed: 7 }, { seed: 8 }, SMALL);
  expect(r.first).toEqual(a.audioCues);
  expect(r.back).toEqual(a.audioCues);
  // 种子变了，选择跟着变（同一个多变体事件 6 次全部相同的概率很小；这里种子固定，结果确定）
  expect(r.changed.map((c) => c.variant?.file)).not.toEqual(a.audioCues.map((c) => c.variant?.file));
});

// ---- 离线混音（05-export.md 5.5）：真实的 OfflineAudioContext；音效是脚本生成的正弦波 ----

const cue = (at: number, file: string | null, extra: Partial<{ gain: number; rate: number; pan: number }> = {}) => ({
  sound: file ? `test:${file}` : 'test:missing',
  at,
  gain: 1,
  rate: 1,
  pan: 0,
  ...extra,
  variant: file ? { file, volume: 1, pitch: 1 } : null,
});

test('M6b 离线混音的确定性：同一组 cue 混两次（各自重新解码），WAV 逐字节相同；长度与视频严格相等', async () => {
  const cues = [cue(0.1, 'test:sine/440/200', { gain: 0.3, pan: -0.5 }), cue(0.25, 'test:sine/660/300', { gain: 0.2, rate: 1.5 }), cue(0.9, 'test:sine/880/500', { gain: 0.3 })];
  // 45 帧 / 30 fps = 1.5 秒 = 72000 个样本
  const length = 72_000;
  const a = await call('audioMix', cues, length);
  const b = await call('audioMix', cues, length);
  expect(a.hash).not.toBeNull();
  expect(b.hash).toBe(a.hash);
  expect(a.bytes).toBe(44 + length * 4);
  // 第一个声音在 0.1 s（4800 个样本）开始，之前是静音
  expect(a.firstNonZero).toBeGreaterThanOrEqual(4800);
  expect(a.firstNonZero).toBeLessThan(4800 + 48);
  // 结尾 10 ms 淡出：最后一个样本是 0
  expect(a.lastFrame).toEqual([0, 0]);
  expect(a.peakNormalized).toBe(false);
  expect(a.missing).toEqual([]);
});

test('M6b 离线混音：没有 cue、或全部缺失时不产生音频；缺失的事件列出来；峰值超过 0 dBFS 时整体压到 −1 dBFS', async () => {
  expect((await call('audioMix', [], 48_000)).hash).toBeNull();
  const missing = await call('audioMix', [cue(0, null), cue(0.1, 'test:nothing/here')], 48_000);
  expect(missing.hash).toBeNull();
  expect(missing.missing).toEqual(['test:missing', 'test:test:nothing/here']);
  // 三个满幅正弦叠在一起，峰值远超 0 dBFS
  const loud = await call('audioMix', [cue(0, 'test:sine/440/400'), cue(0, 'test:sine/440/400'), cue(0, 'test:sine/440/400')], 48_000);
  expect(loud.peakNormalized).toBe(true);
  // −1 dBFS ≈ 0.891 × 32767 = 29204
  expect(loud.peak).toBeLessThanOrEqual(29_205);
  expect(loud.peak).toBeGreaterThan(29_000);
});

test('T-EXP-4 T1/T2 只在开启时定位方块声音，背景音乐单独播放一次', async () => {
  for (const template of ['allay.builtin.block-wipe', 'allay.builtin.block-fall']) {
    const original = await call('templateAudio', template, SMALL, {});
    const enabled = await call('templateAudio', template, SMALL, { spatialAudio: true, music: 'minecraft:music.menu' });
    const effects = enabled.filter((entry) => entry.sound !== 'minecraft:music.menu');
    expect(original.length).toBeGreaterThan(0);
    expect(original.every((entry) => entry.spatial === undefined)).toBe(true);
    expect(effects.map(({ at }) => at)).toEqual(original.map(({ at }) => at));
    const spatial = effects.map((entry) => entry.spatial);
    expect(spatial.some((entry) => (entry?.pan ?? 0) > 0.2)).toBe(true);
    expect(spatial.some((entry) => (entry?.pan ?? 0) < -0.2)).toBe(true);
    expect(spatial.some((entry) => (entry?.gain ?? 1) < 0.99)).toBe(true);
    const music = enabled.filter((entry) => entry.sound === 'minecraft:music.menu');
    expect(music).toHaveLength(1);
    expect(music[0]?.at).toBe(0);
    expect(music[0]?.spatial).toBeUndefined();
  }
});

test('T-EXP-4 空间声道能量、距离和裁切：预览调度与导出使用同一图', async () => {
  const input = { ...cue(0, 'test:sine/440/500'), clip: { offset: 0, end: 0.25 } };
  const left = await call('spatialMix', { ...input, spatial: { pan: -1, gain: 1 } });
  const right = await call('spatialMix', { ...input, spatial: { pan: 1, gain: 0.5 } });
  const music = await call('spatialMix', { ...input, variant: { ...input.variant!, kind: 'music' }, spatial: { pan: 1, gain: 0.5 } });
  expect(left.left.live).toBeGreaterThan(100);
  expect(left.right.live).toBeCloseTo(0, 5);
  expect(right.left.live).toBeCloseTo(0, 5);
  expect(right.right.live / left.left.live).toBeCloseTo(0.25, 5);
  expect(music.right.live).toBeCloseTo(music.left.live, 5);
  for (const result of [left, right, music]) {
    expect(result.left.live).toBeCloseTo(result.left.offline, 2);
    expect(result.right.live).toBeCloseTo(result.right.offline, 2);
    expect(result.tail).toBeCloseTo(0, 5);
  }
});
