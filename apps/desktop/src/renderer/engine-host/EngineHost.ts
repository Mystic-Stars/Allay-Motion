// 宿主一侧的引擎封装（docs/02-engine.md 2.3）：创建 Worker、Comlink 调用、看门狗、资源回调。
// 看门狗：load 10 秒，预览单帧 5 秒，导出单帧 30 秒。超时就 terminate()，交给调用方重建 Worker。
import type { EngineApi, HostCallbacks } from '@allay/engine';
import {
  CompositionLoadRequestSchema,
  CompositionLoadResultSchema,
  CompositionSourceKeySchema,
  compositionSourceKey,
  ExecutionTraceTargetSchema,
  SetupTraceResultSchema,
  FrameStatsSchema,
  LoadResultSchema,
  TemplateDiagnosticSchema,
  diagnosticOf,
  type TemplateDiagnostic,
  type EngineMode,
  type ExecutionTraceConfig,
  type ExecutionTraceTarget,
  type FrameQuality,
  type FrameStats,
  type LoadRequest,
  type LoadResult,
  type CompositionLoadRequest,
  type CompositionLoadResult,
  type Opaque,
  type ParamValues,
  type ResourceKind,
  type ResourcePayload,
  type ThumbRequest,
} from '@allay/template-sdk';
import * as Comlink from 'comlink';
import { createEngineWorker } from './create-worker';
import { analyzeTemplateCode } from '../../shared/template-code';
import { planExecutionTrace } from '../../shared/execution-trace';

export const WATCHDOG_MS = { load: 10_000, previewFrame: 5_000, exportFrame: 30_000 } as const;
export type WatchdogTimeouts = { [K in keyof typeof WATCHDOG_MS]: number };

/** 模板在时限内没有返回：Worker 已被终止 */
export class EngineUnresponsiveError extends Error {
  /** watchdog 类诊断（H5）。Worker 已被终止，拿不到卡在哪一行 */
  readonly diagnostic: TemplateDiagnostic;

  constructor(
    readonly operation: string,
    timeoutMs = 0,
  ) {
    super(`engine did not respond to ${operation} in time`);
    this.name = 'EngineUnresponsiveError';
    this.diagnostic = { kind: 'watchdog', severity: 'error', code: 'unresponsive', message: this.message, operation, timeoutMs };
  }
}

/** Worker 自己挂了（脚本错误、显卡丢失等），或者已经被销毁 */
export class EngineCrashedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineCrashedError';
  }
}

export interface EngineHostOptions {
  mode: EngineMode;
  /** 预览模式：页面上的 <canvas>，由这里 transferControlToOffscreen() 交给 Worker */
  canvas?: HTMLCanvasElement;
  resolveResource(kind: ResourceKind, id: string): Promise<ResourcePayload | null>;
  log?(level: 'debug' | 'warn' | 'error', message: string): void;
  timeouts?: Partial<WatchdogTimeouts>;
  /** 开发构建里打开（2.4） */
  strictDeterminism?: boolean;
  /** Worker 被看门狗终止或自己崩溃时调用一次 */
  onDead?(error: EngineUnresponsiveError | EngineCrashedError): void;
}

export type ResourceResolver = EngineHostOptions['resolveResource'];
type PreviewLoad = LoadRequest | CompositionLoadRequest;
type PreviewFrameStats = FrameStats & { traceSource?: string };
export interface SetupTraceSample extends ExecutionTraceTarget {
  source: string;
  lines: number[];
}
type TraceSelection = { target: ExecutionTraceTarget; source: string; config: ExecutionTraceConfig };

let workerSeq = 0;

/** 载荷里所有可以零拷贝转移的缓冲（去重：同一个 ArrayBuffer 只能列一次） */
export function payloadBuffers(payload: ResourcePayload): ArrayBuffer[] {
  const views: ArrayBufferView[] = [];
  if (payload.kind === 'rgba') views.push(payload.data);
  else if (payload.kind === 'font') {
    for (const provider of payload.providers) {
      if (provider.type === 'bitmap') views.push(provider.image.data);
      else if (provider.type === 'ttf') views.push(provider.bytes);
      else if (provider.type === 'unihex') views.push(provider.tables.codepoints, provider.tables.metrics, provider.tables.offsets, provider.tables.bits);
    }
  }
  // 'sound'（音效变体表）是普通对象，没有可转移的缓冲
  const set = new Set<ArrayBuffer>();
  for (const v of views) if (v.buffer instanceof ArrayBuffer) set.add(v.buffer);
  return [...set];
}

export class EngineHost {
  readonly mode: EngineMode;
  private readonly worker: Worker;
  private readonly api: Comlink.Remote<EngineApi>;
  private readonly timeouts: WatchdogTimeouts;
  private deadError: EngineUnresponsiveError | EngineCrashedError | null = null;
  private released = false;
  private readonly pending = new Set<(error: Error) => void>();
  private compositionResolvers: readonly ResourceResolver[] = [];
  private loadingComposition = false;
  private previewLoad: PreviewLoad | null = null;
  private traceSelection: TraceSelection | null = null;
  private sentTrace: ExecutionTraceConfig = null;
  private setupTrace: SetupTraceSample | null = null;

  private constructor(private readonly opts: EngineHostOptions) {
    this.mode = opts.mode;
    this.timeouts = { ...WATCHDOG_MS, ...opts.timeouts };
    this.worker = createEngineWorker(`engine-${opts.mode}-${++workerSeq}`);
    this.worker.addEventListener('error', (event) => {
      event.preventDefault();
      this.die(new EngineCrashedError(`engine worker error: ${event.message || 'unknown'}`));
    });
    this.worker.addEventListener('messageerror', () => this.die(new EngineCrashedError('engine worker sent an unreadable message')));
    this.api = Comlink.wrap<EngineApi>(this.worker);
  }

  /** 建 Worker 并 init；预览模式要传 canvas */
  static async create(opts: EngineHostOptions): Promise<EngineHost> {
    const host = new EngineHost(opts);
    const callbacks: HostCallbacks = {
      resolveResource: async (kind, id, source) => {
        const resolve = source === undefined ? opts.resolveResource : host.compositionResolvers[CompositionSourceKeySchema.parse(source)];
        const payload = resolve ? await resolve(kind, id) : null;
        // 载荷交给 Worker 后在这里就不能再用了：调用方每次都要给一份新的（缓存里的要先复制）
        return payload ? Comlink.transfer(payload, payloadBuffers(payload)) : null;
      },
      log: (level, message) => opts.log?.(level, String(message).slice(0, 2000)),
    };
    const canvas = opts.mode === 'preview' ? opts.canvas?.transferControlToOffscreen() : undefined;
    if (opts.mode === 'preview' && !canvas) throw new Error('preview engine needs a canvas');
    const init = { canvas, mode: opts.mode, strictDeterminism: opts.strictDeterminism === true };
    try {
      await host.call('init', host.timeouts.load, () => host.api.init(Comlink.transfer(init, canvas ? [canvas] : []), Comlink.proxy(callbacks)));
    } catch (error) {
      host.dispose();
      throw error;
    }
    return host;
  }

  get dead(): boolean {
    return this.deadError !== null;
  }

  /**
   * 预检源码（语法、不含 import），再装载模板并完成 setup。
   * 预检不过时抛 TemplateCodeError（带 compile 类诊断）；静态规则的提示附在结果的 diagnostics 里（H12）。
   */
  async load(req: LoadRequest, target?: ExecutionTraceTarget): Promise<LoadResult> {
    const rules = await analyzeTemplateCode(req.code);
    this.sentTrace = null;
    this.setupTrace = null;
    const trace = this.mode === 'preview' && target ? this.planTrace(target, req) : null;
    const result = LoadResultSchema.parse(await this.call('load', this.timeouts.load, () => trace?.config ? this.api.load(req, trace.config) : this.api.load(req)));
    this.compositionResolvers = [];
    this.rememberPreviewLoad(req);
    this.traceSelection = trace;
    return { ...result, diagnostics: rules };
  }

  async loadComposition(req: CompositionLoadRequest, resources: readonly ResourceResolver[], target?: ExecutionTraceTarget): Promise<CompositionLoadResult> {
    if (this.loadingComposition) throw new Error('composition load already in progress');
    const parsed = CompositionLoadRequestSchema.parse(req);
    if (resources.length !== parsed.sources.length) throw new Error('composition source count mismatch');
    this.loadingComposition = true;
    const previous = this.compositionResolvers;
    try {
      for (const code of new Set(parsed.sources.flatMap((source) => 'code' in source ? [source.code] : []))) await analyzeTemplateCode(code);
      this.sentTrace = null;
      this.setupTrace = null;
      this.compositionResolvers = [...resources];
      const trace = this.mode === 'preview' && target ? this.planTrace(target, parsed) : null;
      const result = CompositionLoadResultSchema.parse(await this.call('loadComposition', this.timeouts.load, () => trace?.config ? this.api.load(parsed, trace.config) : this.api.load(parsed)));
      if (result.totalFrames !== parsed.composition.durationFrames || result.duration !== result.totalFrames / parsed.output.fps) {
        throw new EngineCrashedError('engine returned inconsistent composition frame boundaries');
      }
      this.rememberPreviewLoad(parsed);
      this.traceSelection = trace;
      return result;
    } catch (error) {
      this.compositionResolvers = previous;
      throw error;
    } finally {
      this.loadingComposition = false;
    }
  }

  async clear(): Promise<void> {
    await this.call('clear', this.timeouts.load, () => this.api.load(null));
    this.compositionResolvers = [];
    this.rememberPreviewLoad(null);
  }

  async setParams(params: ParamValues, target?: ExecutionTraceTarget): Promise<LoadResult> {
    this.sentTrace = null;
    this.setupTrace = null;
    const trace = this.mode === 'preview' && target ? this.selectTrace(target) : null;
    return LoadResultSchema.parse(await this.call('setParams', this.timeouts.load, () => trace?.config ? this.api.setParams(params, trace.config) : this.api.setParams(params)));
  }

  async resize(width: number, height: number): Promise<void> {
    await this.call('resize', this.timeouts.previewFrame, () => this.api.resize(width, height));
  }

  async render(t: number, quality?: FrameQuality, target: ExecutionTraceTarget | null = null, onSetup?: (sample: SetupTraceSample | null) => void): Promise<PreviewFrameStats> {
    const selection = this.mode === 'preview' && target ? this.selectTrace(target) : null;
    if (!target) this.traceSelection = null;
    const config = selection?.config ?? null;
    if (this.sentTrace !== config) {
      const lines = SetupTraceResultSchema.parse(await this.call('configureExecutionTrace', this.timeouts.load, () => this.api.configureExecutionTrace(config)));
      this.setupTrace = lines?.length && selection ? { ...selection.target, source: selection.source, lines } : null;
      this.sentTrace = config;
    }
    onSetup?.(this.setupTrace);
    const stats = FrameStatsSchema.parse(await this.call('render', this.timeouts.previewFrame, () => this.api.render(t, quality)));
    return stats.trace && selection ? { ...stats, traceSource: selection.source } : stats;
  }

  private rememberPreviewLoad(request: PreviewLoad | null): void {
    if (this.mode !== 'preview') return;
    this.previewLoad = request;
    this.sentTrace = null;
    this.traceSelection = null;
    this.setupTrace = null;
  }

  private selectTrace(target: ExecutionTraceTarget) {
    const previous = this.traceSelection;
    if (previous?.target.id === target.id && previous.target.version === target.version && previous.target.clipId === target.clipId) return previous;
    const loaded = this.previewLoad;
    if (!loaded) return null;
    return this.traceSelection = this.planTrace(target, loaded);
  }

  private planTrace(target: ExecutionTraceTarget, loaded: PreviewLoad): TraceSelection | null {
    const parsed = ExecutionTraceTargetSchema.safeParse(target);
    if (!parsed.success) return null;
    let source: string | undefined;
    if ('composition' in loaded) {
      const { composition } = loaded;
      const clip = composition.tracks.filter((track) => !track.muted).flatMap((track) => track.clips).find((entry) => entry.id === target.clipId);
      if (clip?.template.id === target.id && clip.template.version === target.version && clip.startFrame < composition.durationFrames) {
        const key = compositionSourceKey(clip.template, clip.profile ?? composition.defaultProfile);
        const entry = loaded.sources.find((candidate) => compositionSourceKey(candidate.template, candidate.profile) === key);
        if (entry && 'code' in entry) source = entry.code;
      }
    } else if (target.clipId === undefined && loaded.manifest.id === target.id && loaded.manifest.version === target.version) {
      source = loaded.code;
    }
    if (source === undefined) return null;
    const plan = planExecutionTrace(source);
    return { target: parsed.data, source, config: plan ? { ...plan, target: parsed.data } : null };
  }

  /** 导出一帧：直通 alpha 的 RGBA8，第一行是顶部 */
  async renderFrame(index: number, quality: FrameQuality, opaque?: Opaque): Promise<Uint8Array<ArrayBuffer>> {
    const buf = await this.call('renderFrame', this.timeouts.exportFrame, () => this.api.renderFrame(index, quality, opaque));
    if (!(buf instanceof ArrayBuffer)) throw new EngineCrashedError('renderFrame returned no pixels');
    return new Uint8Array(buf);
  }

  /** 方块、物品的缩略图（杂务或导出引擎） */
  async renderThumbnail(req: ThumbRequest): Promise<ImageBitmap> {
    const bitmap = await this.call('renderThumbnail', this.timeouts.exportFrame, () => this.api.renderThumbnail(req));
    if (!(bitmap instanceof ImageBitmap)) throw new EngineCrashedError('renderThumbnail returned no image');
    return bitmap;
  }

  /** 诊断与测试用：画一帧预览并读回画布像素（预乘 alpha） */
  async readPreview(t: number): Promise<Uint8Array<ArrayBuffer>> {
    const buf = await this.call('readPreview', this.timeouts.previewFrame, () => this.api.readPreview(t));
    if (!(buf instanceof ArrayBuffer)) throw new EngineCrashedError('readPreview returned no pixels');
    return new Uint8Array(buf);
  }

  /**
   * 确定性自检（2.4）：probe 帧渲染两次，中间穿插渲染 others。一致时为 null，否则是 determinism 类诊断。
   * 杂务或导出引擎；时限按每帧的导出时限累计。
   */
  async checkDeterminism(probe: number, others: number[], quality: FrameQuality): Promise<TemplateDiagnostic | null> {
    const budget = this.timeouts.exportFrame * (others.length + 2);
    const result: unknown = await this.call('checkDeterminism', budget, async (): Promise<unknown> => this.api.checkDeterminism(probe, others, quality));
    return result === null ? null : TemplateDiagnosticSchema.parse(result);
  }

  /** 释放 GPU 资源并终止 Worker。可以重复调用 */
  dispose(): void {
    if (!this.deadError) {
      void this.api.dispose().catch(() => undefined);
      this.deadError = new EngineCrashedError('engine disposed');
      this.rejectPending(this.deadError);
    }
    if (this.released) return;
    this.released = true;
    try {
      this.api[Comlink.releaseProxy]();
    } catch {
      // Worker 已经没了
    }
    this.worker.terminate();
  }

  private die(error: EngineUnresponsiveError | EngineCrashedError): void {
    if (this.deadError) return;
    this.deadError = error;
    this.worker.terminate();
    this.rejectPending(error);
    this.opts.onDead?.(error);
  }

  private rejectPending(error: Error): void {
    for (const reject of this.pending) reject(error);
    this.pending.clear();
  }

  /** 带看门狗的调用：超时就终止 Worker */
  private async call<T>(operation: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
    if (this.deadError) throw this.deadError;
    const timer = setTimeout(() => this.die(new EngineUnresponsiveError(operation, timeoutMs)), timeoutMs);
    let rejectCall!: (error: Error) => void;
    const death = new Promise<never>((_resolve, reject) => { rejectCall = reject; });
    this.pending.add(rejectCall);
    try {
      return await Promise.race([death, fn()]);
    } catch (error) {
      // Worker 交来的诊断是线程边界外的数据：不合 schema 就去掉（2.3 的校验约定）
      if (error && typeof error === 'object' && 'diagnostic' in error && !(error instanceof EngineUnresponsiveError)) {
        const valid = diagnosticOf(error);
        if (valid) (error as { diagnostic: unknown }).diagnostic = valid;
        else delete (error as { diagnostic?: unknown }).diagnostic;
      }
      throw error;
    } finally {
      clearTimeout(timer);
      this.pending.delete(rejectCall);
    }
  }
}
