// test:engine 的测试页：用应用里同一份 EngineHost（Worker、Comlink、看门狗）驱动引擎，
// 在页面里算好统计量再交给 Playwright，避免把整帧像素序列化回 Node。
import builtins from 'virtual:builtin-templates';
import { probeComposition } from './composition';
import { probeStudioObjects } from './studio-objects';
import { probeStudioPlayer } from './studio-player';
import alphaRects from '../../fixtures/templates/alpha-rects.js?raw';
import movingRect from '../../fixtures/templates/moving-rect.js?raw';
import randomInUpdate from '../../fixtures/templates/random-in-update.js?raw';
import hangUpdate from '../../fixtures/templates/hang-update.js?raw';
import usesImport from '../../fixtures/templates/uses-import.js?raw';
import escapeAttempts from '../../fixtures/templates/escape-attempts.js?raw';
import m2Features from '../../fixtures/templates/m2-features.js?raw';
import m6bFeatures from '../../fixtures/templates/m6b-features.js?raw';
import devSyntaxError from '../../fixtures/templates/dev/syntax-error.js?raw';
import devSetupThrows from '../../fixtures/templates/dev/setup-throws.js?raw';
import devUpdateThrows from '../../fixtures/templates/dev/update-throws.js?raw';
import devRandomUpdate from '../../fixtures/templates/dev/random-update.js?raw';
import devOrderDependent from '../../fixtures/templates/dev/order-dependent.js?raw';
import { EngineHost, type WatchdogTimeouts } from '../../../apps/desktop/src/renderer/engine-host/EngineHost';
import { mixOffline } from '../../../apps/desktop/src/renderer/audio/mix';
import { scheduleCues } from '../../../apps/desktop/src/renderer/audio/schedule';
import { SoundBank } from '../../../apps/desktop/src/renderer/audio/sound-bank';
import { encodeWav } from '../../../apps/desktop/src/renderer/audio/wav';
import { ANIM_COLORS, FAKE_STAMP, fakeColor, fakeResolveResource, setFakeVanillaFont } from './fake-resources';
import { versionedTexture } from './versioned-resources';
import { frameCount } from '../../../packages/engine/src/frames';
import { diagnosticOf, TemplateManifestSchema, type AudioCue, type CompositionLoadRequest, type FrameQuality, type TemplateDiagnostic, type OutputSettings, type ParamValues, type TemplateManifest } from '../../../packages/template-sdk/src/index';

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
  m2Features: {
    code: m2Features,
    manifest: fixture([
      { key: 'scenario', type: 'text', label: 'scenario', default: '' },
      { key: 'text', type: 'text', label: 'text', default: 'AB' },
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

async function exportEngine(name: TemplateKey, output: OutputSettings, params: ParamValues = {}, timeouts?: Partial<WatchdogTimeouts>, fixtures?: { missing?: string[] }) {
  const { code, manifest } = sourceOf(name);
  const requestedTextures = new Set<string>();
  const host = await EngineHost.create({ mode: 'export', strictDeterminism: true, timeouts, resolveResource: async (kind, id) => {
    if (!fixtures || kind !== 'texture') return fakeResolveResource(kind, id);
    requestedTextures.add(id);
    return fixtures.missing?.includes(id) ? null : versionedTexture(id);
  } });
  try {
    const loaded = await host.load({ manifest, code, params, output, resourceStamp: fixtures ? 'test-versioned' : FAKE_STAMP, ...(fixtures ? { locale: 'en' } : {}) });
    return { host, loaded, requestedTextures };
  } catch (error) {
    host.dispose();
    throw error;
  }
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

const harness = {
  probeComposition,
  probeStudioObjects,
  probeStudioPlayer,
  frameCount,
  /** 内置模板的 id 与 manifest */
  builtins: () => Object.fromEntries(Object.entries(builtins).map(([id, b]) => [id, b.manifest])),

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
  async tplCheck(name: TemplateKey, output: OutputSettings, quality: FrameQuality, params: ParamValues, hashes: boolean, fixtures?: { missing?: string[] }) {
    const { host, loaded, requestedTextures } = await exportEngine(name, output, params, undefined, fixtures);
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
        const other = await exportEngine(name, output, params, undefined, fixtures);
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
            for (let k = 0; k < a.length; k++) {
              const d = Math.abs(a[k]! - b[k]!);
              if (d) {
                diff++;
                if (first < 0) first = k;
              }
              if (d > maxd) maxd = d;
            }
            debug.push({ i, seq: seq[i]!.slice(0, 8), shuf: shuf[i]!.slice(0, 8), again1: (await sha256(a)).slice(0, 8), again2: (await sha256(b)).slice(0, 8), diff, maxd, firstPixel: first >> 2 });
          }
          deterministic = mismatched.length === 0;
        } finally {
          other.host.dispose();
        }
        distinct = new Set(seq).size;
      }
      return { warnings: loaded.warnings, textures: [...requestedTextures].sort(), duration: loaded.duration, cutTime: loaded.cutTime, cues: loaded.audioCues.length, total, cutIndex, first, last, cut, deterministic, mismatched, distinct, debug };
    } finally {
      host.dispose();
    }
  },

  async versionedPixels(name: TemplateKey, output: OutputSettings, params: ParamValues, indices: number[], points: [number, number][], missing: string[] = []) {
    const { host, loaded, requestedTextures } = await exportEngine(name, output, params, undefined, { missing });
    try {
      const frames = [];
      for (const index of indices) {
        const pixels = await host.renderFrame(index, { subframes: 1, shutterAngle: 0 });
        frames.push(points.map(([x, y]) => px(pixels, output.width, x, y)));
      }
      return { frames, textures: [...requestedTextures].sort(), warnings: loaded.warnings };
    } finally {
      host.dispose();
    }
  },

  async versionedComposition(name: TemplateKey, params: ParamValues) {
    const { manifest, code } = sourceOf(name);
    const template = { id: manifest.id, version: manifest.version };
    const output = { width: 160, height: 90, fps: 24 } as const;
    const request: CompositionLoadRequest = {
      output, locale: 'en', sources: [{ template, manifest, code, resourceStamp: 'versioned-composition' }],
      composition: { formatVersion: 1, fps: output.fps, durationFrames: 48, tracks: [{
        id: 'track', name: 'track', locked: false, muted: false, clips: [{
          id: 'end', template, params, startFrame: 6, sourceInFrame: 3, durationFrames: 31,
        }],
      }] },
    };
    const textures = new Set<string>();
    const resources = async (kind: Parameters<typeof fakeResolveResource>[0], id: string) => {
      if (kind !== 'texture') return fakeResolveResource(kind, id);
      textures.add(id);
      return versionedTexture(id);
    };
    const host = await EngineHost.create({ mode: 'export', strictDeterminism: true, resolveResource: resources });
    const quality = { subframes: 8, shutterAngle: 180 };
    try {
      const loaded = await host.loadComposition(request, [resources]);
      const before = await host.renderFrame(5, quality);
      const first = await host.renderFrame(12, quality);
      const later = await host.renderFrame(24, quality);
      const after = await host.renderFrame(37, quality);
      const deterministic = await host.checkDeterminism(12, [37, 24, 5], quality);
      const points = [[5, 5], [10, 45], [150, 75]] as const;
      return {
        textures: [...textures].sort(), warnings: loaded.warnings, deterministic,
        alpha: [before, first, later, after].map(alphaOf),
        background: [first, later].map((frame) => points.map(([x, y]) => px(frame, output.width, x, y))),
      };
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

  async templateAudio(name: TemplateKey, output: OutputSettings, params: ParamValues) {
    const { host, loaded } = await exportEngine(name, output, params);
    host.dispose();
    return loaded.audioCues;
  },

  async spatialMix(cue: AudioCue) {
    const fps = 48_000;
    const from = 0.125;
    const length = 12_000;
    const signal = Float32Array.from({ length: fps / 2 }, (_, index) => (index < fps / 8 ? 0.05 : 0.35) * Math.sin(2 * Math.PI * index / 120));
    const bank = new SoundBank(async () => encodeWav([signal, signal], fps));
    const voices = (await bank.prepare([cue])).voices;
    const previewGraph = new OfflineAudioContext(2, length, fps);
    scheduleCues(previewGraph, previewGraph.destination, voices, { from, startAt: 0, until: from + length / fps });
    const preview = await previewGraph.startRendering();
    const exported = await mixOffline([{ ...cue, at: 0, clip: { end: (cue.clip?.end ?? 1) - from, offset: from } }], length, bank);
    const view = exported.wav ? new DataView(exported.wav.buffer, exported.wav.byteOffset + 44) : null;
    const energy = (channel: number, start: number, end: number) => {
      let live = 0;
      let offline = 0;
      const samples = preview.getChannelData(channel);
      for (let index = start; index < end; index++) {
        live += samples[index]! ** 2;
        offline += ((view?.getInt16(index * 4 + channel * 2, true) ?? 0) / 32767) ** 2;
      }
      return { live, offline };
    };
    return { left: energy(0, 0, 4000), right: energy(1, 0, 4000), tail: energy(0, 6400, length).live + energy(1, 6400, length).offline };
  },

  /** 装载模板，返回 warnings（escape-attempts 用它报告结果） */
  async loadWarnings(name: TemplateKey, output: OutputSettings) {
    const { host, loaded } = await exportEngine(name, output);
    host.dispose();
    return loaded.warnings;
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
