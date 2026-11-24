// test:engine 的测试页：用应用里同一份 EngineHost（Worker、Comlink、看门狗）驱动引擎，
// 在页面里算好统计量再交给 Playwright，避免把整帧像素序列化回 Node。
import builtins from 'virtual:builtin-templates';
import alphaRects from '../../fixtures/templates/alpha-rects.js?raw';
import movingRect from '../../fixtures/templates/moving-rect.js?raw';
import randomInUpdate from '../../fixtures/templates/random-in-update.js?raw';
import hangUpdate from '../../fixtures/templates/hang-update.js?raw';
import usesImport from '../../fixtures/templates/uses-import.js?raw';
import escapeAttempts from '../../fixtures/templates/escape-attempts.js?raw';
import m2Features from '../../fixtures/templates/m2-features.js?raw';
import m6bFeatures from '../../fixtures/templates/m6b-features.js?raw';
import partialCover from '../../fixtures/templates/partial-cover.js?raw';
// 渲染目标稳定性探针：裸 WebGL2，不经过引擎（docs/reference/intel-igpu-rt-corruption/）
import rtProbeSource from '../../../docs/reference/intel-igpu-rt-corruption/rt-probe.js?raw';
import devSyntaxError from '../../fixtures/templates/dev/syntax-error.js?raw';
import devSetupThrows from '../../fixtures/templates/dev/setup-throws.js?raw';
import devUpdateThrows from '../../fixtures/templates/dev/update-throws.js?raw';
import devRandomUpdate from '../../fixtures/templates/dev/random-update.js?raw';
import devOrderDependent from '../../fixtures/templates/dev/order-dependent.js?raw';
import { EngineHost, type WatchdogTimeouts } from '../../../apps/desktop/src/renderer/engine-host/EngineHost';
import { mixOffline } from '../../../apps/desktop/src/renderer/audio/mix';
import { SoundBank } from '../../../apps/desktop/src/renderer/audio/sound-bank';
import { encodeWav } from '../../../apps/desktop/src/renderer/audio/wav';
import { ANIM_COLORS, FAKE_STAMP, fakeColor, fakeResolveResource, setFakeVanillaFont } from './fake-resources';
import { animationManifest, animationTemplateCode } from '../../../apps/desktop/src/shared/animation/compile';
import { AnimationDocSchema, newAnimationDoc } from '../../../apps/desktop/src/shared/animation/schema';
import { frameCount } from '../../../packages/engine/src/frames';
import { diagnosticOf, TemplateManifestSchema, type AudioCue, type FrameQuality, type TemplateDiagnostic, type OutputSettings, type ParamValues, type TemplateManifest } from '../../../packages/template-sdk/src/index';

const fixture = (params: unknown[] = []) =>
  TemplateManifestSchema.parse({ formatVersion: 1, id: 'test.engine.fixture', version: '0.0.0', name: 'fixture', category: 'transition', params });

const T1_ID = 'allay.builtin.block-wipe';

/** 测试模板（源码 + manifest）。blockWipe 是内置的 T1，代码来自 pnpm templates:build 同一份打包函数 */
const SOURCES = {
  blockWipe: { code: builtins[T1_ID]!.code, manifest: TemplateManifestSchema.parse(builtins[T1_ID]!.manifest) },
  alphaRects: { code: alphaRects, manifest: fixture() },
  movingRect: { code: movingRect, manifest: fixture() },
  randomInUpdate: { code: randomInUpdate, manifest: fixture() },
  hangUpdate: { code: hangUpdate, manifest: fixture() },
  usesImport: { code: usesImport, manifest: fixture() },
  escapeAttempts: { code: escapeAttempts, manifest: fixture() },
  devSyntaxError: { code: devSyntaxError, manifest: fixture() },
  devSetupThrows: { code: devSetupThrows, manifest: fixture() },
  devUpdateThrows: { code: devUpdateThrows, manifest: fixture() },
  devRandomUpdate: { code: devRandomUpdate, manifest: fixture() },
  devOrderDependent: { code: devOrderDependent, manifest: fixture() },
  partialCover: { code: partialCover, manifest: fixture() },
  m2Features: {
    code: m2Features,
    manifest: fixture([
      { key: 'scenario', type: 'text', label: 'scenario', default: '' },
      { key: 'text', type: 'text', label: 'text', default: 'AB' },
      { key: 'font', type: 'font', label: 'font', default: { family: 'minecraft:default' } },
    ]),
  },
  m6bFeatures: {
    code: m6bFeatures,
    manifest: fixture([
      { key: 'scenario', type: 'text', label: 'scenario', default: '' },
      { key: 'block', type: 'text', label: 'block', default: 'minecraft:stone' },
      { key: 'face', type: 'text', label: 'face', default: 'south' },
      { key: 'seed', type: 'seed', label: 'seed', default: 1 },
    ]),
  },
} satisfies Record<string, { code: string; manifest: TemplateManifest }>;
export type TemplateName = keyof typeof SOURCES;

/** 测试模板的名字，或内置模板的 id */
export type TemplateKey = TemplateName | (string & {});

function sourceOf(key: TemplateKey): { code: string; manifest: TemplateManifest } {
  if (Object.hasOwn(SOURCES, key)) return SOURCES[key as TemplateName];
  const b = builtins[key];
  if (!b) throw new Error(`unknown template ${key}`);
  return { code: b.code, manifest: TemplateManifestSchema.parse(b.manifest) };
}

async function exportEngine(name: TemplateKey, output: OutputSettings, params: ParamValues = {}, timeouts?: Partial<WatchdogTimeouts>) {
  const { code, manifest } = sourceOf(name);
  const host = await EngineHost.create({ mode: 'export', resolveResource: fakeResolveResource, strictDeterminism: true, timeouts });
  const loaded = await host.load({ manifest, code, params, output, resourceStamp: FAKE_STAMP });
  return { host, loaded };
}

function alphaOf(buf: Uint8Array): { min: number; max: number } {
  let min = 255;
  let max = 0;
  for (let k = 3; k < buf.length; k += 4) {
    if (buf[k]! < min) min = buf[k]!;
    if (buf[k]! > max) max = buf[k]!;
  }
  return { min, max };
}

/**
 * 剪辑点那一帧里没盖满（alpha < 255）的像素：数量和前 24 个的位置（docs/decisions.md M8：软件渲染下剪辑点 alpha 254 的诊断，
 * 看它们是方块接缝上的边缘像素还是方块内部）
 */
function belowOpaque(buf: Uint8Array, width: number): { below: number; samples: [number, number, number][] } {
  let below = 0;
  const samples: [number, number, number][] = [];
  for (let k = 3; k < buf.length; k += 4) {
    if (buf[k]! >= 255) continue;
    below++;
    if (samples.length < 24) {
      const p = (k - 3) / 4;
      samples.push([p % width, Math.floor(p / width), buf[k]!]);
    }
  }
  return { below, samples };
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

function px(buf: Uint8Array, width: number, x: number, y: number): number[] {
  const o = (y * width + x) * 4;
  return [buf[o]!, buf[o + 1]!, buf[o + 2]!, buf[o + 3]!];
}

/** 确定性的洗牌（不用 Math.random，测试本身也要可复现） */
function shuffled(n: number): number[] {
  const order = Array.from({ length: n }, (_, i) => i);
  let s = 12345;
  for (let i = n - 1; i > 0; i--) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    const j = s % (i + 1);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}

/** rt-probe.js 的结果 */
interface RtProbeResult {
  renderer: string;
  frames: number;
  bad: number;
  distinct: number;
  ms: number;
  events: { frame: number; count: number; pixels: number; sample: { x: number; y: number; expected: number[]; got: number[] } | null }[];
  glError: number;
  errors: string[];
  calls: number;
}

const harness = {
  frameCount,
  /** 内置模板的 id 与 manifest */
  builtins: () => Object.fromEntries(Object.entries(builtins).map(([id, b]) => [id, b.manifest])),

  /**
   * 渲染目标稳定性探针（docs/decisions.md“Intel 核显上渲染目标偶发被写坏”）：几个 Worker 同时跑裸 WebGL2 的最小复现，
   * 同一个静止场景反复渲染，看读回的整帧是不是每次都一样。任何一个 Worker 的 distinct > 1 说明这块显卡（驱动）会写坏渲染目标。
   * 默认两个 Worker 并行：实测核显上单个 Worker 偶尔整整 1.5 秒一帧都不坏（另一个同时跑的 89 ms 就看到了）。
   */
  async rtProbe(options: { budgetMs?: number; stopAfter?: number; workers?: number } = {}) {
    const url = URL.createObjectURL(
      new Blob(
        [`${rtProbeSource}\nself.onmessage = (e) => { try { self.postMessage({ ok: true, r: self.allayRtProbe(e.data) }); } catch (err) { self.postMessage({ ok: false, error: String((err && err.stack) || err) }); } };`],
        { type: 'text/javascript' },
      ),
    );
    const one = () =>
      new Promise<RtProbeResult>((resolve, reject) => {
        const worker = new Worker(url);
        const done = (res: { ok: boolean; r?: RtProbeResult; error?: string }) => {
          worker.terminate();
          if (res.ok && res.r) resolve(res.r);
          else reject(new Error(`rt probe failed: ${res.error ?? 'no result'}`));
        };
        worker.onmessage = (e: MessageEvent<{ ok: boolean; r?: RtProbeResult; error?: string }>) => done(e.data);
        worker.onerror = (e) => done({ ok: false, error: e.message });
        worker.postMessage({ budgetMs: options.budgetMs, stopAfter: options.stopAfter });
      });
    try {
      const results = await Promise.all(Array.from({ length: Math.max(1, options.workers ?? 2) }, one));
      const unstable = results.find((r) => r.distinct > 1);
      return {
        ...(unstable ?? results[0]!),
        frames: results.reduce((n, r) => n + r.frames, 0),
        bad: results.reduce((n, r) => n + r.bad, 0),
        distinct: Math.max(...results.map((r) => r.distinct)),
        ms: Math.max(...results.map((r) => r.ms)),
        errors: results.flatMap((r) => r.errors),
        workers: results.map((r) => ({ frames: r.frames, bad: r.bad, distinct: r.distinct, ms: r.ms })),
      };
    } finally {
      URL.revokeObjectURL(url);
    }
  },

  /** 渲染器的名字（判断是不是软件渲染，T-TPL-5 的放宽，4.11） */
  gpu() {
    const gl = new OffscreenCanvas(1, 1).getContext('webgl2');
    if (!gl) return 'none';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  },

  /**
   * T-TPL-3/4：装载一个模板，返回 warnings、时长、剪辑点，首帧、剪辑点那一帧（round(cutTime × fps)）、末帧的 alpha 极值。
   * hashes 为真时另做 T-ENG-1：全部帧顺序渲染一遍、在另一个 Worker 里乱序渲染一遍，逐帧比较 SHA-256。
   */
  async tplCheck(name: TemplateKey, output: OutputSettings, quality: FrameQuality, params: ParamValues, hashes: boolean) {
    const { host, loaded } = await exportEngine(name, output, params);
    try {
      const total = frameCount(loaded.duration, output.fps);
      const cutIndex = loaded.cutTime === null ? null : Math.round(loaded.cutTime * output.fps);
      const first = alphaOf(await host.renderFrame(0, quality));
      const last = alphaOf(await host.renderFrame(total - 1, quality));
      const cutPixels = cutIndex === null ? null : await host.renderFrame(cutIndex, quality);
      const cut = cutPixels === null ? null : { ...alphaOf(cutPixels), ...belowOpaque(cutPixels, output.width) };
      let deterministic: boolean | null = null;
      let distinct = 0;
      let mismatched: number[] = [];
      // 不一致时的诊断：两个 Worker 各重渲染一次，看是哪一边、差多少（docs/decisions.md M3“引擎里两处确定性问题”）
      const debug: unknown[] = [];
      if (hashes) {
        const seq: string[] = [];
        for (let i = 0; i < total; i++) seq.push(await sha256(await host.renderFrame(i, quality)));
        const other = await exportEngine(name, output, params);
        try {
          const shuf: string[] = new Array<string>(total);
          for (const i of shuffled(total)) shuf[i] = await sha256(await other.host.renderFrame(i, quality));
          mismatched = seq.flatMap((h, i) => (h === shuf[i] ? [] : [i]));
          for (const i of mismatched) {
            const a = await host.renderFrame(i, quality);
            const b = await other.host.renderFrame(i, quality);
            let diff = 0;
            let maxd = 0;
            let first = -1;
            // 两边再各渲染一次之后仍不同的像素：(x, y, 顺序那一边的 RGBA, 乱序那一边的 RGBA)，最多 4 个
            const pixels: [number, number, number[], number[]][] = [];
            for (let k = 0; k < a.length; k++) {
              const d = Math.abs(a[k]! - b[k]!);
              if (d) {
                diff++;
                if (first < 0) first = k;
                const p = k >> 2;
                if (pixels.length < 4 && (pixels.length === 0 || pixels[pixels.length - 1]![0] + pixels[pixels.length - 1]![1] * output.width !== p)) {
                  pixels.push([p % output.width, Math.floor(p / output.width), Array.from(a.subarray(p * 4, p * 4 + 4)), Array.from(b.subarray(p * 4, p * 4 + 4))]);
                }
              }
              if (d > maxd) maxd = d;
            }
            debug.push({ i, seq: seq[i]!.slice(0, 8), shuf: shuf[i]!.slice(0, 8), again1: (await sha256(a)).slice(0, 8), again2: (await sha256(b)).slice(0, 8), diff, maxd, firstPixel: first >> 2, pixels });
          }
          deterministic = mismatched.length === 0;
        } finally {
          other.host.dispose();
        }
        distinct = new Set(seq).size;
      }
      return { warnings: loaded.warnings, duration: loaded.duration, cutTime: loaded.cutTime, cues: loaded.audioCues.length, total, cutIndex, first, last, cut, deterministic, mismatched, distinct, debug };
    } finally {
      host.dispose();
    }
  },

  /** T-TPL-5：0%、25%、cutTime、75%、100% 五帧（直通 alpha 的 RGBA8，base64） */
  async tplKeyFrames(name: TemplateKey, output: OutputSettings, quality: FrameQuality) {
    const { host, loaded } = await exportEngine(name, output);
    try {
      const last = frameCount(loaded.duration, output.fps) - 1;
      const cut = loaded.cutTime === null ? Math.round(last / 2) : Math.round(loaded.cutTime * output.fps);
      const indices = { p0: 0, p25: Math.round(last * 0.25), cut, p75: Math.round(last * 0.75), p100: last };
      const frames: Record<string, string> = {};
      for (const [k, i] of Object.entries(indices)) frames[k] = toBase64(await host.renderFrame(i, quality));
      return { indices, frames, warnings: loaded.warnings };
    } finally {
      host.dispose();
    }
  },
  fakeColor,
  animColors: () => ANIM_COLORS,
  setFakeVanillaFont,

  /** M2 的场景（方块、物品、文字、精灵、动画贴图、缺失资源）：取若干帧的若干像素，以及 warnings */
  async scenario(scenario: string, extra: ParamValues, output: OutputSettings, indices: number[], points: [number, number][]) {
    const { host, loaded } = await exportEngine('m2Features', output, { scenario, ...extra });
    try {
      const frames: number[][][] = [];
      for (const i of indices) {
        const buf = await host.renderFrame(i, { subframes: 1, shutterAngle: 180 });
        frames.push(points.map(([x, y]) => px(buf, output.width, x, y)));
      }
      return { warnings: loaded.warnings, frames };
    } finally {
      host.dispose();
    }
  },

  /**
   * 文字缓存（docs/animation-editor.md 第 8 节）：同一个 Worker 里装载文字场景、渲染，再用同样的参数 setParams（命中缓存）、
   * 换一段文字再换回来，各渲染一帧。返回每次的整帧哈希和 warnings
   */
  async textCache(text: string, other: string, output: OutputSettings) {
    const { host, loaded } = await exportEngine('m2Features', output, { scenario: 'text', text });
    const hash = async () => {
      const buf = new Uint8Array(await host.renderFrame(0, { subframes: 1, shutterAngle: 180 }));
      let h = 2166136261;
      for (let i = 0; i < buf.length; i++) h = Math.imul(h ^ buf[i]!, 16777619);
      return (h >>> 0).toString(16);
    };
    try {
      const first = { hash: await hash(), warnings: loaded.warnings };
      const again = await host.setParams({ scenario: 'text', text });
      const second = { hash: await hash(), warnings: again.warnings };
      const changed = await host.setParams({ scenario: 'text', text: other });
      const third = { hash: await hash(), warnings: changed.warnings };
      const back = await host.setParams({ scenario: 'text', text });
      const fourth = { hash: await hash(), warnings: back.warnings };
      return { first, second, third, fourth };
    } finally {
      host.dispose();
    }
  },

  /**
   * 逐字动画的排版（docs/animation-editor.md 3.8，第三轮补）：同一段文字整段画一次、逐字（不错开、没有动画）画一次，
   * 比较两帧：不一样的像素数、有墨迹的像素数。用测试字体（位图字体，和 unihex 的中文字形）
   */
  async charsLayout(text: string, align: 'left' | 'center' | 'right', output: OutputSettings) {
    const frame = async (chars: boolean) => {
      const doc = AnimationDocSchema.parse({
        ...newAnimationDoc('Chars', 'B'),
        layers: [{ id: 't', name: 'T', type: 'text', text, size: 10, shadow: false, align, props: { x: -200 }, ...(chars ? { chars: { stagger: 0 } } : {}) }],
      });
      const host = await EngineHost.create({ mode: 'export', resolveResource: fakeResolveResource, strictDeterminism: true });
      try {
        const loaded = await host.load({ manifest: animationManifest(doc, { id: 'user.abcdef.chars', version: '1.0.0' }), code: animationTemplateCode(doc), params: {}, output, resourceStamp: FAKE_STAMP });
        return { buf: new Uint8Array(await host.renderFrame(0, { subframes: 1, shutterAngle: 180 })), warnings: loaded.warnings };
      } finally {
        host.dispose();
      }
    };
    const whole = await frame(false);
    const split = await frame(true);
    let diff = 0;
    let ink = 0;
    for (let i = 0; i < whole.buf.length; i += 4) {
      if (whole.buf[i + 3]! > 0) ink++;
      if (Math.abs(whole.buf[i + 3]! - split.buf[i + 3]!) > 8) diff++;
    }
    return { diff, ink, warnings: [...whole.warnings, ...split.warnings] };
  },

  /** 缩略图（3.10）：尺寸、不透明像素比例、中心像素 */
  async thumbnail(kind: 'block' | 'item', id: string, size: 64 | 128) {
    const host = await EngineHost.create({ mode: 'utility', resolveResource: fakeResolveResource, strictDeterminism: true });
    try {
      const bitmap = await host.renderThumbnail({ kind, id, size, resourceStamp: FAKE_STAMP });
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const g = canvas.getContext('2d')!;
      g.drawImage(bitmap, 0, 0);
      const d = g.getImageData(0, 0, bitmap.width, bitmap.height).data;
      let opaque = 0;
      for (let k = 3; k < d.length; k += 4) if (d[k]! > 200) opaque++;
      const c = ((bitmap.height >> 1) * bitmap.width + (bitmap.width >> 1)) * 4;
      return { width: bitmap.width, height: bitmap.height, opaqueFraction: opaque / (bitmap.width * bitmap.height), center: [d[c]!, d[c + 1]!, d[c + 2]!, d[c + 3]!], corner: d[3]! };
    } finally {
      host.dispose();
    }
  },

  /** T-ENG-1：每帧的 SHA-256；order 是渲染顺序，结果按帧号排列 */
  async frameHashes(name: TemplateKey, output: OutputSettings, quality: FrameQuality, shuffle: boolean, params: ParamValues = {}) {
    const { host, loaded } = await exportEngine(name, output, params);
    try {
      const total = frameCount(loaded.duration, output.fps);
      const order = shuffle ? shuffled(total) : Array.from({ length: total }, (_, i) => i);
      const hashes: string[] = new Array<string>(total);
      for (const i of order) hashes[i] = await sha256(await host.renderFrame(i, quality));
      return { duration: loaded.duration, cutTime: loaded.cutTime, order, hashes };
    } finally {
      host.dispose();
    }
  },

  /** 取一帧里若干像素 */
  async samplePixels(name: TemplateKey, output: OutputSettings, index: number, quality: FrameQuality, points: [number, number][]) {
    const { host } = await exportEngine(name, output);
    try {
      const buf = await host.renderFrame(index, quality);
      return { length: buf.length, pixels: points.map(([x, y]) => px(buf, output.width, x, y)) };
    } finally {
      host.dispose();
    }
  },

  /** 一行的 alpha（T-ENG-3） */
  async rowAlpha(name: TemplateKey, output: OutputSettings, index: number, quality: FrameQuality, y: number) {
    const { host } = await exportEngine(name, output);
    try {
      const buf = await host.renderFrame(index, quality);
      return Array.from({ length: output.width }, (_, x) => buf[(y * output.width + x) * 4 + 3]!);
    } finally {
      host.dispose();
    }
  },

  /** 帧的 alpha 极值（首末帧透明、剪辑点不透明） */
  async alphaRange(name: TemplateKey, output: OutputSettings, indices: number[], quality: FrameQuality) {
    const { host, loaded } = await exportEngine(name, output);
    try {
      const out: { index: number; min: number; max: number }[] = [];
      for (const i of indices) {
        const idx = i < 0 ? frameCount(loaded.duration, output.fps) + i : i;
        const buf = await host.renderFrame(idx, quality);
        let min = 255;
        let max = 0;
        for (let k = 3; k < buf.length; k += 4) {
          if (buf[k]! < min) min = buf[k]!;
          if (buf[k]! > max) max = buf[k]!;
        }
        out.push({ index: idx, min, max });
      }
      return { duration: loaded.duration, cutTime: loaded.cutTime, frames: out };
    } finally {
      host.dispose();
    }
  },

  /**
   * T-ENG-4：同一 t、同一分辨率、N = 1，预览画布读回（预乘 alpha）换算成直通 alpha，与 renderFrame 比较。
   * 返回 alpha 的最大差、按 alpha 分档的颜色最大差，以及预乘域里的最大差。
   */
  async previewVsExport(name: TemplateKey, output: OutputSettings, indices: number[]) {
    const canvas = document.createElement('canvas');
    document.body.append(canvas);
    const preview = await EngineHost.create({ mode: 'preview', canvas, resolveResource: fakeResolveResource, strictDeterminism: true });
    const { host } = await exportEngine(name, output);
    try {
      await preview.resize(output.width, output.height);
      const src = sourceOf(name);
      await preview.load({ manifest: src.manifest, code: src.code, params: {}, output, resourceStamp: FAKE_STAMP });
      const results = [];
      for (const index of indices) {
        const t = index / output.fps;
        const p = await preview.readPreview(t);
        const e = await host.renderFrame(index, { subframes: 1, shutterAngle: 180 });
        let alpha = 0;
        let colorOpaque = 0; // alpha = 255
        let colorHigh = 0; // alpha ≥ 128
        let colorAny = 0; // alpha > 0
        let premul = 0;
        let partial = 0;
        let nonEmpty = 0;
        // alpha ≥ 128 里差得最多的那个像素：导出的 alpha 与颜色、预览的 alpha 与（预乘的）颜色（docs/decisions.md M8 的诊断）
        let worstHigh: { a: number; pa: number; e: number; p: number; straight: number } | null = null;
        for (let k = 0; k < e.length; k += 4) {
          const a = e[k + 3]!;
          const pa = p[k + 3]!;
          alpha = Math.max(alpha, Math.abs(a - pa));
          if (a > 0) nonEmpty++;
          if (a > 0 && a < 255) partial++;
          for (let c = 0; c < 3; c++) {
            premul = Math.max(premul, Math.abs(Math.round((e[k + c]! * a) / 255) - p[k + c]!));
            if (pa === 0) continue;
            const straight = Math.min(255, Math.round((p[k + c]! * 255) / pa));
            const d = Math.abs(straight - e[k + c]!);
            colorAny = Math.max(colorAny, d);
            if (a >= 128 && d > colorHigh) worstHigh = { a, pa, e: e[k + c]!, p: p[k + c]!, straight };
            if (a >= 128) colorHigh = Math.max(colorHigh, d);
            if (a === 255) colorOpaque = Math.max(colorOpaque, d);
          }
        }
        results.push({ index, alpha, colorOpaque, colorHigh, worstHigh, colorAny, premul, partial, nonEmpty, length: p.length === e.length });
      }
      return results;
    } finally {
      preview.dispose();
      host.dispose();
      canvas.remove();
    }
  },

  /** T-ENG-5：同一帧按 1× 和 2× 分辨率渲染，后者 2×2 平均缩小一半（预乘域），比较平均绝对误差 */
  async resolutionIndependence(name: TemplateKey, base: OutputSettings, index: number, quality: FrameQuality) {
    const big: OutputSettings = { ...base, width: base.width * 2, height: base.height * 2 };
    const a = await exportEngine(name, base);
    const b = await exportEngine(name, big);
    try {
      const small = await a.host.renderFrame(index, quality);
      const large = await b.host.renderFrame(index, quality);
      const W = base.width;
      const premulAt = (buf: Uint8Array, w: number, x: number, y: number, c: number) => {
        const o = (y * w + x) * 4;
        return c === 3 ? buf[o + 3]! : (buf[o + c]! * buf[o + 3]!) / 255;
      };
      let sum = 0;
      let opaque = 0;
      for (let y = 0; y < base.height; y++) {
        for (let x = 0; x < W; x++) {
          if (small[(y * W + x) * 4 + 3] === 255) opaque++;
          for (let c = 0; c < 4; c++) {
            const s = premulAt(small, W, x, y, c);
            let l = 0;
            for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) l += premulAt(large, big.width, 2 * x + dx, 2 * y + dy, c);
            sum += Math.abs(s - l / 4);
          }
        }
      }
      return { mae: sum / (W * base.height * 4), opaqueFraction: opaque / (W * base.height) };
    } finally {
      a.host.dispose();
      b.host.dispose();
    }
  },

  /** 装载或渲染应当失败的模板：返回错误信息 */
  async expectFailure(name: TemplateKey, output: OutputSettings, timeouts?: Partial<WatchdogTimeouts>) {
    const started = performance.now();
    try {
      const { host } = await exportEngine(name, output, {}, timeouts);
      try {
        await host.renderFrame(0, { subframes: 1, shutterAngle: 180 });
        return { failed: false, name: '', message: '', ms: performance.now() - started, dead: host.dead };
      } catch (error) {
        return { failed: true, name: (error as Error).name, message: (error as Error).message, ms: performance.now() - started, dead: host.dead };
      } finally {
        host.dispose();
      }
    } catch (error) {
      return { failed: true, name: (error as Error).name, message: (error as Error).message, ms: performance.now() - started, dead: true };
    }
  },

  /**
   * T-DEV-2（引擎层）：装载并渲染一帧（check 给了时改做确定性自检），返回结构化诊断。
   * phase 说明诊断出在哪一步；rules 是装载结果里附带的静态规则提示。
   */
  async diagnose(name: TemplateKey, output: OutputSettings, opts: { timeouts?: Partial<WatchdogTimeouts>; check?: { probe: number; others: number[] } } = {}) {
    const { code, manifest } = sourceOf(name);
    const host = await EngineHost.create({ mode: 'export', resolveResource: fakeResolveResource, strictDeterminism: true, timeouts: opts.timeouts });
    const q = { subframes: 1, shutterAngle: 180 };
    const failed = (phase: 'load' | 'render', error: unknown, rules: TemplateDiagnostic[]) => ({
      phase,
      diagnostic: diagnosticOf(error),
      rules,
      name: (error as Error).name,
      message: (error as Error).message,
      dead: host.dead,
    });
    try {
      let rules: TemplateDiagnostic[];
      try {
        rules = (await host.load({ manifest, code, params: {}, output, resourceStamp: FAKE_STAMP })).diagnostics ?? [];
      } catch (error) {
        return failed('load', error, []);
      }
      if (opts.check) {
        const diagnostic = await host.checkDeterminism(opts.check.probe, opts.check.others, q);
        return { phase: 'check' as const, diagnostic, rules, name: '', message: '', dead: host.dead };
      }
      try {
        await host.renderFrame(Math.round(output.fps / 2), q);
      } catch (error) {
        return failed('render', error, rules);
      }
      return { phase: 'ok' as const, diagnostic: null, rules, name: '', message: '', dead: host.dead };
    } finally {
      host.dispose();
    }
  },

  /** M6b：装载 m6b-features 的某个场景，返回 warnings、audioCues 和若干像素（第 0 帧） */
  async m6b(extra: ParamValues, output: OutputSettings, points: [number, number][] = []) {
    const { host, loaded } = await exportEngine('m6bFeatures', output, extra);
    try {
      const buf = points.length > 0 ? await host.renderFrame(0, { subframes: 1, shutterAngle: 180 }) : null;
      return { warnings: loaded.warnings, audioCues: loaded.audioCues, pixels: buf ? points.map(([x, y]) => px(buf, output.width, x, y)) : [] };
    } finally {
      host.dispose();
    }
  },

  /** M6b：同一个导出 Worker 里先装载再改参数（setParams）回到原参数，两次的 audioCues */
  async m6bReparam(params: ParamValues, other: ParamValues, output: OutputSettings) {
    const { host, loaded } = await exportEngine('m6bFeatures', output, params);
    try {
      const changed = await host.setParams({ ...params, ...other });
      const back = await host.setParams(params);
      return { first: loaded.audioCues, changed: changed.audioCues, back: back.audioCues };
    } finally {
      host.dispose();
    }
  },

  /**
   * M6b 离线混音（与导出同一个函数，真实的 OfflineAudioContext）。音效是脚本生成的正弦波 WAV（测试数据）：
   * 文件名 test:sine/<频率>/<毫秒>。每次用新的音效库（重新解码），返回 WAV 的哈希、长度、峰值和第一个非零样本的位置。
   */
  async audioMix(cues: AudioCue[], length: number) {
    const loads: string[] = [];
    const bank = new SoundBank(async (file) => {
      loads.push(file);
      const m = /^test:sine\/(\d+)\/(\d+)$/.exec(file);
      if (!m) return null;
      const n = Math.round((Number(m[2]) / 1000) * 44_100);
      const data = new Float32Array(n);
      for (let i = 0; i < n; i++) data[i] = 0.9 * Math.sin((2 * Math.PI * Number(m[1]) * i) / 44_100);
      // 44.1 kHz 的源：解码时重采样到 48 kHz，确认重采样也是确定的
      return encodeWav([data, data], 44_100);
    });
    const r = await mixOffline(cues, length, bank);
    let firstNonZero = -1;
    let peak = 0;
    if (r.wav) {
      const view = new DataView(r.wav.buffer, r.wav.byteOffset + 44);
      for (let i = 0; i < view.byteLength / 2; i++) {
        const v = Math.abs(view.getInt16(i * 2, true));
        if (v > 0 && firstNonZero < 0) firstNonZero = Math.floor(i / 2);
        peak = Math.max(peak, v);
      }
    }
    const lastFrame = r.wav ? [new DataView(r.wav.buffer, r.wav.byteLength - 4).getInt16(0, true), new DataView(r.wav.buffer, r.wav.byteLength - 2).getInt16(0, true)] : null;
    return {
      hash: r.wav ? await sha256(new Uint8Array(r.wav)) : null,
      bytes: r.wav?.byteLength ?? null,
      peak,
      firstNonZero,
      lastFrame,
      peakNormalized: r.peakNormalized,
      missing: r.missing,
      loads,
    };
  },

  /** 装载模板，返回 warnings（escape-attempts 用它报告结果） */
  async loadWarnings(name: TemplateKey, output: OutputSettings) {
    const { host, loaded } = await exportEngine(name, output);
    host.dispose();
    return loaded.warnings;
  },

  /**
   * T-ENG-1（反复渲染）：同一个 Worker 里把同一帧渲染 times 次，按 SHA-256 分组。
   * 和第一次不同的渲染（最多 4 次）报出不同的像素数和前几个像素（x, y, 第一次的 RGBA, 这一次的 RGBA）。
   */
  async repeatFrame(name: TemplateKey, output: OutputSettings, quality: FrameQuality, index: number, times: number) {
    const { host } = await exportEngine(name, output);
    try {
      let first: Uint8Array | null = null;
      let firstHash = '';
      const counts: Record<string, number> = {};
      const differing: { n: number; pixels: number; samples: [number, number, number[], number[]][] }[] = [];
      for (let n = 0; n < times; n++) {
        const buf = await host.renderFrame(index, quality);
        const h = await sha256(buf);
        counts[h] = (counts[h] ?? 0) + 1;
        if (!first) {
          first = buf;
          firstHash = h;
          continue;
        }
        if (h === firstHash || differing.length >= 4) continue;
        let pixels = 0;
        const samples: [number, number, number[], number[]][] = [];
        for (let p = 0; p < buf.length / 4; p++) {
          const o = p * 4;
          if (buf[o] === first[o] && buf[o + 1] === first[o + 1] && buf[o + 2] === first[o + 2] && buf[o + 3] === first[o + 3]) continue;
          pixels++;
          if (samples.length < 6) samples.push([p % output.width, Math.floor(p / output.width), Array.from(first.subarray(o, o + 4)), Array.from(buf.subarray(o, o + 4))]);
        }
        differing.push({ n, pixels, samples });
      }
      return { distinct: Object.keys(counts).length, counts: Object.values(counts), differing };
    } finally {
      host.dispose();
    }
  },

  /** 一个 Worker 实例重复用：渲染两次同一帧，中间穿插别的帧（2.4 的确定性自检） */
  async selfCheck(name: TemplateKey, output: OutputSettings, index: number, other: number[]) {
    const { host } = await exportEngine(name, output);
    try {
      const q = { subframes: 8, shutterAngle: 180 };
      const first = await sha256(await host.renderFrame(index, q));
      for (const o of other) await host.renderFrame(o, q);
      const second = await sha256(await host.renderFrame(index, q));
      return { first, second };
    } finally {
      host.dispose();
    }
  },
};

export type Harness = typeof harness;
declare global {
  interface Window {
    harness: Harness;
    harnessReady: boolean;
  }
}
window.harness = harness;
window.harnessReady = true;
