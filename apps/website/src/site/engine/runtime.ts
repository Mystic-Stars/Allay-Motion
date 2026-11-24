// 落地页上的实时画面（首屏预览、模板卡片、窄屏仿真器）用的都是桌面版渲染进程的真实代码：
// EngineHost（Worker、Comlink、看门狗）、resource-client（贴图解码、字体）、gallery/covers（模板封面和帧网格）。
// 它们经 window.allay 取模板和资源，所以落地页自己的窗口里也装一份浏览器宿主。
// 这个模块是懒加载的：首屏的文字先出来，引擎和 three 的代码块随后才下载。
import { defaultParams, type ParamValues } from '@allay/template-sdk';
import { EngineHost } from '../../../../desktop/src/renderer/engine-host/EngineHost';
import { createResolver, loadStamp } from '../../../../desktop/src/renderer/engine-host/resource-client';
import { covers, useCoverStore, coverKey, COVER_FPS, COVER_W, COVER_H } from '../../../../desktop/src/renderer/features/gallery/covers';
import { useResourceStore } from '../../../../desktop/src/renderer/stores/resourceStore';
import { sourceFromBundle, type TemplateSource } from '../../../../desktop/src/renderer/templates/catalog';
import type { TemplateEntry } from '../../../../desktop/src/shared/templates';
import type { SiteLanguage } from '../../host/bridge';
import { createBrowserHost, installBrowserHost } from '../../host/browser-host';
import { builtinBundle, builtinEntries } from '../../host/templates';
import { getPrefs, subscribePrefs } from '../prefs';
import { hostMessages } from '../i18n';

export { covers, useCoverStore, coverKey, COVER_FPS, COVER_W, COVER_H };

let ready: Promise<void> | null = null;

/** 装上浏览器宿主（只装一次），把资源栈状态交给渲染进程的 resourceStore */
export function ensureRuntime(): Promise<void> {
  ready ??= (async () => {
    const prefs = getPrefs();
    const host = createBrowserHost({ settings: { theme: prefs.theme, language: prefs.language }, messages: hostMessages() });
    installBrowserHost(host.api);
    subscribePrefs(() => {
      const p = getPrefs();
      host.applySettings({ theme: p.theme, language: p.language });
    });
    useResourceStore.getState().replace(await window.allay.resources.layers());
  })();
  return ready;
}

export function templateEntries(): TemplateEntry[] {
  return builtinEntries();
}

export function templateSource(entry: TemplateEntry): TemplateSource | null {
  const bundle = builtinBundle(entry.id, entry.version);
  return bundle ? sourceFromBundle(bundle) : null;
}

/**
 * 浏览器有没有 WebGL2（引擎需要它；没有时页面给一句说明，不白屏）。
 * 只试一次，并且马上释放试探用的上下文：浏览器同时活着的 WebGL 上下文有上限，超出时最早的会被丢掉。
 */
let webgl2: boolean | null = null;
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
 * 一块实时预览画布：预览模式的 EngineHost，自己的 requestAnimationFrame 循环。
 * 和应用的预览一样：按输出规格（1920×1080、60 fps）装载，画布按显示尺寸 × 设备像素比 resize。
 */
export class LivePreview {
  private host: EngineHost | null = null;
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
  private source: TemplateSource | null = null;
  private params: ParamValues = {};
  private pendingParams: ParamValues | null = null;
  private loadedId: string | null = null;
  locale: SiteLanguage = 'en';
  /** 播完一遍后不循环，停在片尾（剪辑点的整幅转场由滚动驱动，不自己播） */
  loop = true;
  private listeners = new Set<(s: LiveState) => void>();
  /** 每播完一遍调用（首屏用它自动换下一个模板） */
  onLoop: (() => void) | null = null;

  private constructor(private readonly canvas: HTMLCanvasElement) {}

  static async create(canvas: HTMLCanvasElement): Promise<LivePreview> {
    await ensureRuntime();
    const live = new LivePreview(canvas);
    const source = (): TemplateSource['assets'] => live.source?.assets ?? null;
    live.host = await EngineHost.create({ mode: 'preview', canvas, resolveResource: createResolver(source) });
    live.tick = live.tick.bind(live);
    live.raf = requestAnimationFrame(live.tick);
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

  /**
   * 换模板（参数取默认值，overrides 覆盖其中几项；语言影响带文字的模板）。
   * output 默认是应用的 1920×1080、60 fps；剪辑点的整幅转场按视口的宽高比装载。
   */
  show(entry: TemplateEntry, locale: SiteLanguage, overrides?: ParamValues, output?: { width: number; height: number }): Promise<void> {
    this.pendingParams = null;
    return this.queue(async () => {
      const host = this.host;
      const source = templateSource(entry);
      if (!host || !source || this.disposed) return;
      this.source = source;
      this.locale = locale;
      const params = { ...defaultParams(source.params, { locale }), ...overrides };
      const result = await host.load({
        manifest: source.manifest,
        code: source.code,
        params,
        output: { width: output?.width ?? 1920, height: output?.height ?? 1080, fps: 60 },
        resourceStamp: loadStamp(source.assets),
        locale,
      });
      this.params = params;
      this.loadedId = entry.id;
      this.duration = result.duration;
      this.cutTime = result.cutTime;
      this.time = Math.min(this.time, this.duration);
      this.dirty = true;
      this.emit();
    });
  }

  /** 当前播放头的时刻（秒） */
  get currentTime(): number {
    return this.time;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /** 当前装着的模板 */
  get templateId(): string | null {
    return this.loadedId;
  }

  /**
   * 改几项参数（不换模板）：和应用里拖属性面板一样走引擎的 setParams。
   * 滚动驱动时调用得很密，这里只保留最新的一份，前一次没做完的不排队。
   */
  setParams(overrides: ParamValues): void {
    const first = this.pendingParams === null;
    this.pendingParams = { ...this.params, ...overrides };
    if (!first) return;
    void this.queue(async () => {
      const next = this.pendingParams;
      this.pendingParams = null;
      if (!next || !this.host) return;
      const result = await this.host.setParams(next);
      this.params = next;
      this.duration = result.duration;
      this.cutTime = result.cutTime;
      this.time = Math.min(this.time, this.duration);
      this.dirty = true;
      this.emit();
    });
  }

  /** 读预览画布在 t 时刻的像素（测试用：整幅转场在剪辑点是不是铺满） */
  async readPixels(t: number): Promise<Uint8Array | null> {
    let out: Uint8Array | null = null;
    await this.queue(async () => {
      out = (await this.host?.readPreview(t)) ?? null;
    });
    return out;
  }

  /** 引擎调用排成一队（装载、resize、渲染不交错）；一步失败不连累后面的 */
  private queue(fn: () => Promise<void>): Promise<void> {
    const run = this.loading.then(() => (this.disposed ? undefined : fn()));
    this.loading = run.catch((error: unknown) => {
      if (!this.disposed) console.warn('[live] engine call failed', error);
    });
    return this.loading;
  }

  /** 画布的设备像素尺寸 */
  resize(width: number, height: number): void {
    const w = Math.max(16, Math.round(width));
    const h = Math.max(16, Math.round(height));
    void this.queue(async () => {
      await this.host?.resize(w, h);
      this.dirty = true;
    });
  }

  /** 用户自己按了暂停（外面的驱动不再替他恢复播放） */
  userPaused = false;

  setPlaying(playing: boolean, byUser = false): void {
    this.playing = playing;
    if (byUser) this.userPaused = !playing;
    this.last = performance.now();
    this.emit();
  }

  seek(t: number): void {
    this.time = Math.min(this.duration, Math.max(0, t));
    this.dirty = true;
    this.emit();
  }

  /** 不在视口里时不画（不占显卡） */
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.last = performance.now();
  }

  private tick(now: number): void {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.tick);
    const dt = Math.min(0.1, Math.max(0, (now - (this.last || now)) / 1000));
    this.last = now;
    if (!this.visible || !this.host || this.host.dead) return;
    if (this.playing) {
      // 片尾留 0.35 秒的空，循环的接缝看得清
      const span = this.duration + 0.35;
      let t = this.time + dt;
      if (t >= span) {
        t %= span;
        this.onLoop?.();
      }
      if (!this.loop && t >= this.duration) {
        // 不循环的（剪辑点的转场）：播到片尾就停
        t = this.duration;
        this.playing = false;
      }
      this.time = t;
      this.dirty = true;
      this.emit();
    }
    if (!this.dirty || this.busy) return;
    this.busy = true;
    this.dirty = false;
    const t = Math.min(this.duration, this.time);
    void this.queue(async () => {
      await this.host?.render(t);
    }).finally(() => {
      this.busy = false;
    });
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.host?.dispose();
    this.host = null;
    this.listeners.clear();
  }
}
