// 官网独立的轻量化引擎宿主：直接复用 @allay/engine、@allay/assets 和 @allay/template-sdk，
// 不经 window.allay，不依赖 apps/desktop 的任何代码。
import { decodePng } from '@allay/assets';
import type { EngineApi, HostCallbacks } from '@allay/engine';
import {
  FrameStatsSchema,
  LoadResultSchema,
  defaultParams,
  type FrameQuality,
  type FrameStats,
  type LoadRequest,
  type LoadResult,
  type ParamValues,
  type ResourceKind,
  type ResourcePayload,
} from '@allay/template-sdk';
import * as Comlink from 'comlink';
import { demoTexture } from '../../host/demo-pack';
import { mcGameVersion, mcTexture } from '../../host/mc-pack';
import { showcaseBundle, type SiteTemplateEntry } from '../../host/templates';
import type { SiteLanguage } from '../prefs';

const WATCHDOG_MS = { load: 10_000, previewFrame: 5_000, exportFrame: 30_000 } as const;
export const SITE_RESOURCE_STAMP = mcGameVersion ? 'site-mc-v1' : 'site-demo-v1';

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

interface CachedTexture {
  width: number;
  height: number;
  data: Uint8Array;
  mcmeta: string | null;
}

const decodedCache = new Map<string, Promise<CachedTexture | null>>();

/** 官网资源解析：只提供贴图（官网原版贴图 → 网页演示纯色块），字体/音效返回 null 由引擎退回系统字体与静音 */
async function resolveSiteResource(kind: ResourceKind, id: string): Promise<ResourcePayload | null> {
  if (kind !== 'texture') return null;
  let pending = decodedCache.get(id);
  if (!pending) {
    pending = (async (): Promise<CachedTexture | null> => {
      const vanilla = await mcTexture(id);
      const raw = vanilla ?? (await demoTexture(id).then((png) => (png ? { png, mcmeta: null } : null)));
      if (!raw) return null;
      const img = await decodePng(raw.png, inflate);
      return { width: img.width, height: img.height, data: img.data, mcmeta: raw.mcmeta };
    })().catch((error: unknown) => {
      console.warn(`[site-engine] texture ${id} failed`, error);
      decodedCache.delete(id);
      return null;
    });
    decodedCache.set(id, pending);
  }
  const cached = await pending;
  if (!cached) return null;
  return {
    kind: 'rgba',
    width: cached.width,
    height: cached.height,
    data: cached.data.slice(),
    ...(cached.mcmeta !== null ? { mcmeta: cached.mcmeta } : {}),
  };
}

let workerSeq = 0;

/** 轻量化引擎宿主：创建独立 Worker、转移贴图缓冲、带看门狗超时和干净释放 */
export class SiteEngineHost {
  private readonly worker: Worker;
  private readonly api: Comlink.Remote<EngineApi>;
  private deadError: Error | null = null;
  private released = false;
  private rejectDeath!: (error: Error) => void;
  private readonly death: Promise<never>;

  private constructor(name: string) {
    this.death = new Promise<never>((_resolve, reject) => {
      this.rejectDeath = reject;
    });
    this.death.catch(() => undefined);
    this.worker = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module', name });
    this.worker.addEventListener('error', (event) => {
      event.preventDefault();
      this.die(new Error(`site engine worker error: ${event.message || 'unknown'}`));
    });
    this.worker.addEventListener('messageerror', () => {
      this.die(new Error('site engine worker sent an unreadable message'));
    });
    this.api = Comlink.wrap<EngineApi>(this.worker);
  }

  static async create(mode: 'preview' | 'export', canvasEl?: HTMLCanvasElement): Promise<SiteEngineHost> {
    const host = new SiteEngineHost(`site-engine-${mode}-${++workerSeq}`);
    const callbacks: HostCallbacks = {
      resolveResource: async (kind, id) => {
        const payload = await resolveSiteResource(kind, id);
        if (!payload) return null;
        if (payload.kind === 'rgba' && payload.data.buffer instanceof ArrayBuffer) {
          return Comlink.transfer(payload, [payload.data.buffer]);
        }
        return payload;
      },
      log: () => undefined,
    };
    const offscreen = mode === 'preview' ? canvasEl?.transferControlToOffscreen() : undefined;
    if (mode === 'preview' && !offscreen) throw new Error('preview engine requires a canvas');
    try {
      await host.call('init', WATCHDOG_MS.load, () =>
        host.api.init(Comlink.transfer({ canvas: offscreen, mode, strictDeterminism: false }, offscreen ? [offscreen] : []), Comlink.proxy(callbacks)),
      );
    } catch (error) {
      host.dispose();
      throw error;
    }
    return host;
  }

  get dead(): boolean {
    return this.deadError !== null;
  }

  async load(req: LoadRequest): Promise<LoadResult> {
    return LoadResultSchema.parse(await this.call('load', WATCHDOG_MS.load, () => this.api.load(req)));
  }

  async setParams(params: ParamValues): Promise<LoadResult> {
    return LoadResultSchema.parse(await this.call('setParams', WATCHDOG_MS.load, () => this.api.setParams(params)));
  }

  async resize(width: number, height: number): Promise<void> {
    await this.call('resize', WATCHDOG_MS.previewFrame, () => this.api.resize(width, height));
  }

  async render(t: number, quality?: FrameQuality): Promise<FrameStats> {
    return FrameStatsSchema.parse(await this.call('render', WATCHDOG_MS.previewFrame, () => this.api.render(t, quality)));
  }

  async renderFrame(index: number, quality: FrameQuality): Promise<Uint8Array<ArrayBuffer>> {
    const buf = await this.call('renderFrame', WATCHDOG_MS.exportFrame, () => this.api.renderFrame(index, quality));
    if (!(buf instanceof ArrayBuffer)) throw new Error('renderFrame returned no pixels');
    return new Uint8Array(buf);
  }

  dispose(): void {
    if (!this.deadError) {
      void this.api.dispose().catch(() => undefined);
      this.deadError = new Error('site engine disposed');
      this.rejectDeath(this.deadError);
    }
    if (this.released) return;
    this.released = true;
    try {
      this.api[Comlink.releaseProxy]();
    } catch {
      // Worker 已经关闭
    }
    this.worker.terminate();
  }

  private die(error: Error): void {
    if (this.deadError) return;
    this.deadError = error;
    this.worker.terminate();
    this.rejectDeath(error);
  }

  private async call<T>(operation: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
    if (this.deadError) throw this.deadError;
    const timer = window.setTimeout(() => this.die(new Error(`site engine timeout: ${operation}`)), timeoutMs);
    try {
      return await Promise.race([fn(), this.death]);
    } finally {
      window.clearTimeout(timer);
    }
  }
}

let webgl2: boolean | null = null;
/** 探测浏览器是否支持 WebGL2 并立即释放试探上下文 */
export function hasWebgl2(): boolean {
  if (webgl2 !== null) return webgl2;
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    webgl2 = gl !== null;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    webgl2 = false;
  }
  return webgl2;
}

export interface LiveState {
  duration: number;
  cutTime: number | null;
  time: number;
  playing: boolean;
}

/**
 * 实时预览画布：预览模式 SiteEngineHost，按需调度 requestAnimationFrame
 * （不可见或暂停且无待画帧时立刻停转，不空耗 GPU/CPU）。
 */
export class LivePreview {
  private host: SiteEngineHost | null = null;
  private duration = 1;
  private cutTime: number | null = null;
  private time = 0;
  private playing = true;
  private visible = true;
  private raf = 0;
  private last = 0;
  private busy = false;
  private dirty = true;
  private loading: Promise<void> = Promise.resolve();
  private disposed = false;
  private params: ParamValues = {};
  private pendingParams: ParamValues | null = null;
  private loadedId: string | null = null;
  private lastW = 0;
  private lastH = 0;
  private listeners = new Set<(s: LiveState) => void>();

  userPaused = false;
  loop = true;
  onLoop: (() => void) | null = null;

  private constructor() {}

  static async create(canvas: HTMLCanvasElement): Promise<LivePreview> {
    const live = new LivePreview();
    live.host = await SiteEngineHost.create('preview', canvas);
    live.tick = live.tick.bind(live);
    live.scheduleTick();
    return live;
  }

  subscribe(fn: (s: LiveState) => void): () => void {
    this.listeners.add(fn);
    fn(this.state());
    return () => this.listeners.delete(fn);
  }

  private state(): LiveState {
    return { duration: this.duration, cutTime: this.cutTime, time: this.time, playing: this.playing };
  }

  private emit(): void {
    const s = this.state();
    for (const l of this.listeners) l(s);
  }

  private scheduleTick(): void {
    if (this.disposed || this.raf !== 0) return;
    if (!this.visible || (!this.playing && !this.dirty)) return;
    this.raf = requestAnimationFrame(this.tick);
  }

  show(
    entry: SiteTemplateEntry,
    locale: SiteLanguage,
    overrides?: ParamValues,
    opts?: boolean | { startAtCut?: boolean; width?: number; height?: number },
  ): Promise<void> {
    this.pendingParams = null;
    const startAtCut = typeof opts === 'boolean' ? opts : Boolean(opts?.startAtCut);
    const width = typeof opts === 'object' && opts?.width ? opts.width : 1920;
    const height = typeof opts === 'object' && opts?.height ? opts.height : 1080;
    return this.queue(async () => {
      const host = this.host;
      const bundle = showcaseBundle(entry.id);
      if (!host || !bundle || this.disposed) return;
      const params = { ...defaultParams(bundle.entry.manifest.params ?? [], { locale }), ...overrides };
      const result = await host.load({
        manifest: bundle.entry.manifest,
        code: bundle.code,
        params,
        output: { width, height, fps: 60 },
        resourceStamp: SITE_RESOURCE_STAMP,
        locale,
      });
      if (this.disposed) return;
      this.params = params;
      this.loadedId = entry.id;
      this.duration = result.duration;
      this.cutTime = result.cutTime;
      this.time = startAtCut ? (result.cutTime ?? result.duration * 0.5) : Math.min(this.time, this.duration);
      this.dirty = true;
      this.emit();
      this.scheduleTick();
    });
  }

  get currentTime(): number {
    return this.time;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get templateId(): string | null {
    return this.loadedId;
  }

  setParams(overrides: ParamValues): void {
    const first = this.pendingParams === null;
    this.pendingParams = { ...this.params, ...overrides };
    if (!first) return;
    void this.queue(async () => {
      const next = this.pendingParams;
      this.pendingParams = null;
      if (!next || !this.host || this.disposed) return;
      const result = await this.host.setParams(next);
      if (this.disposed) return;
      this.params = next;
      this.duration = result.duration;
      this.cutTime = result.cutTime;
      this.time = Math.min(this.time, this.duration);
      this.dirty = true;
      this.emit();
      this.scheduleTick();
    });
  }

  resize(width: number, height: number): void {
    const w = Math.max(16, Math.round(width));
    const h = Math.max(16, Math.round(height));
    if (w === this.lastW && h === this.lastH) return;
    this.lastW = w;
    this.lastH = h;
    void this.queue(async () => {
      if (!this.host || this.disposed) return;
      await this.host.resize(w, h);
      this.dirty = true;
      this.scheduleTick();
    });
  }

  setPlaying(playing: boolean, byUser = false): void {
    this.playing = playing;
    if (byUser) this.userPaused = !playing;
    this.last = performance.now();
    this.emit();
    this.scheduleTick();
  }

  seek(t: number): void {
    this.time = Math.min(this.duration, Math.max(0, t));
    this.dirty = true;
    this.emit();
    this.scheduleTick();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.last = performance.now();
    this.scheduleTick();
  }

  private queue(fn: () => Promise<void>): Promise<void> {
    const run = this.loading.then(() => (this.disposed ? undefined : fn()));
    this.loading = run.catch((error: unknown) => {
      if (!this.disposed) console.warn('[site-engine] call failed', error);
    });
    return this.loading;
  }

  private tick(now: number): void {
    this.raf = 0;
    if (this.disposed || !this.visible) return;
    const dt = Math.min(0.1, Math.max(0, (now - (this.last || now)) / 1000));
    this.last = now;
    if (this.playing) {
      if (!this.loop) {
        const next = this.time + dt;
        if (next >= this.duration) {
          this.time = this.duration;
          this.playing = false;
        } else {
          this.time = next;
        }
      } else {
        const span = this.duration + 0.35;
        let t = this.time + dt;
        if (t >= span) {
          t %= span;
          this.onLoop?.();
        }
        this.time = t;
      }
      this.dirty = true;
      this.emit();
    }
    if (this.dirty && !this.busy && this.host && !this.host.dead) {
      this.busy = true;
      this.dirty = false;
      const t = Math.min(this.duration, this.time);
      void this.queue(async () => {
        await this.host?.render(t);
      }).finally(() => {
        this.busy = false;
        this.scheduleTick();
      });
    }
    this.scheduleTick();
  }

  dispose(): void {
    this.disposed = true;
    if (this.raf !== 0) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.host?.dispose();
    this.host = null;
    this.listeners.clear();
  }
}
