// 引擎本体（docs/02-engine.md）。运行在 Dedicated Worker 里；宿主经 Comlink 调用（2.3）。
// 不依赖 DOM、React、Electron、Node，只用 Worker 里可用的 Web API。
import * as THREE from 'three';
import {
  applyExecutionTracePlan,
  CompositionLoadRequestSchema,
  CompositionLoadResultSchema,
  compositionSourceKey,
  studioMaterialKind,
  studioMaterialManifest,
  EffectiveTimingSchema,
  FrameQualitySchema,
  LoadRequestSchema,
  OpaqueSchema,
  ParamValuesSchema,
  ResizeSchema,
  ResourceNoticeCodeSchema,
  ThumbRequestSchema,
  EngineModeSchema,
  ExecutionTraceConfigSchema,
  originalTraceLocation,
  type AudioCue,
  type EffectiveTiming,
  type CompositionLoadRequest,
  type CompositionLoadResult,
  type EngineLoadRequest,
  type EngineMode,
  type ExecutionTraceConfig,
  type SetupTraceResult,
  type FrameQuality,
  type FrameStats,
  type FontUsage,
  type LoadRequest,
  type LoadResult,
  type Opaque,
  type ParamValues,
  type ResourceKind,
  type ResourcePayload,
  type SetupContext,
  type StageInfo,
  type TemplateInstance,
  type TemplateModule,
  type ThumbRequest,
  sanitizeParams,
  seedOf,
  type TemplateManifest,
  type TemplateDiagnostic,
} from '@allay/template-sdk';
import { pickSoundVariant } from '@allay/assets';
import { compileTransform, framePosition, localFrame, placeCue, type Clip } from './composition-timing';
import { createBlockHandle } from './blocks';
import { describeThrown, diagnosticFromError } from './diagnostics';
import { ease, math, segment } from './ease';
import { ExecutionTraceRecorder, type BindTraceRecorder } from './execution-trace';
import { frameTime, subframeTimes } from './frames';
import { DeterminismGuard, DeterminismViolation } from './harden';
import { createNoise2D, type Noise2D } from './noise';
import { createItemHandle } from './items';
import { FramePipeline, type CompositionRenderOptions } from './pipeline';
import { createRng } from './random';
import { EngineResources } from './resources';
import { createSprite } from './sprite';
import { computeStage, createDefaultCamera, createStageCamera } from './stage';
import { setupText } from './text';
import { buildThumbScene } from './thumbnail';
import objectMaterial from './studio/object';
import playerMaterial from './studio/player';

/** 宿主实现的回调，经 Comlink.proxy 传入（2.3） */
export interface HostCallbacks {
  resolveResource(kind: ResourceKind, id: string, source?: number): Promise<ResourcePayload | null>;
  log(level: 'debug' | 'warn' | 'error', message: string): void;
}

export interface InitOptions {
  /** 预览模式：主线程用 transferControlToOffscreen() 交来的画布 */
  canvas?: OffscreenCanvas;
  mode: EngineMode;
  /** 开发构建：update(t) 期间拦截 Math.random、Date.now、performance.now（2.4） */
  strictDeterminism?: boolean;
}

/** 引擎对外的接口（2.3） */
export interface EngineApi {
  init(opts: InitOptions, host: HostCallbacks): Promise<void>;
  load(req: EngineLoadRequest, trace?: ExecutionTraceConfig): Promise<LoadResult | CompositionLoadResult>;
  setParams(params: ParamValues, trace?: ExecutionTraceConfig): Promise<LoadResult>;
  resize(width: number, height: number): void;
  render(t: number, quality?: FrameQuality): Promise<FrameStats>;
  configureExecutionTrace(config: ExecutionTraceConfig): Promise<SetupTraceResult>;
  renderFrame(index: number, quality: FrameQuality, opaque?: Opaque): Promise<ArrayBuffer>;
  /** 方块、物品的缩略图（03-assets.md 3.10）；杂务和导出引擎可用 */
  renderThumbnail(req: ThumbRequest): Promise<ImageBitmap>;
  /** 诊断与测试用：按 t 画一帧预览（N = 1），并读回 canvas 上的像素（预乘 alpha，第一行是顶部） */
  readPreview(t: number): Promise<ArrayBuffer>;
  /**
   * 确定性自检（2.4）：渲染 probe 帧，再依次渲染 others，再渲染一次 probe，逐字节比较。
   * 一致时返回 null，不一致时返回 determinism 类诊断。杂务和导出引擎可用；像素不出 Worker。
   */
  checkDeterminism(probe: number, others: number[], quality: FrameQuality): Promise<TemplateDiagnostic | null>;
  dispose(): void;
}

/**
 * 模板的问题（装载、setup、update）。diagnostic 是结构化的诊断（H5），
 * 经 Worker 入口的 Comlink 错误序列化带给宿主；message 保留原来的文字，旧的调用方照常显示。
 */
export class TemplateError extends Error {
  constructor(
    message: string,
    readonly diagnostic: TemplateDiagnostic,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'TemplateError';
  }
}

/** 由诊断生成错误；message 沿用原来的写法（前缀 + 抛出的内容） */
function templateError(prefix: string, diagnostic: TemplateDiagnostic, cause: unknown): TemplateError {
  return new TemplateError(`${prefix}: ${diagnostic.message}`, diagnostic, { cause });
}

/** 契约不符（导出、返回值不对）：没有对应的源码位置 */
function contractError(kind: 'load' | 'setup', code: string, message: string): TemplateError {
  return new TemplateError(message, { kind, severity: 'error', code, message });
}

const DEFAULT_QUALITY: FrameQuality = { subframes: 1, shutterAngle: 180 };
const MAX_WARNINGS = 50;
const studioMaterials = { object: objectMaterial, player: playerMaterial };

interface ImportedTemplate {
  module: TemplateModule;
  /** 装载时用的 Blob URL（已撤销），用来在调用栈里认出模板自己的栈帧 */
  moduleUrl: string;
  bindTrace?: BindTraceRecorder;
  tracePlan?: NonNullable<ExecutionTraceConfig>;
}

interface Loaded extends ImportedTemplate {
  code: string;
  resourceStamp: string;
  manifest: TemplateManifest;
  locale: string;
  output: LoadRequest['output'];
  stage: StageInfo;
  params: ParamValues;
}

interface Active {
  moduleUrl: string;
  trace?: { code: string; plan: NonNullable<ExecutionTraceConfig>; recorder: ExecutionTraceRecorder; setup: SetupTraceResult };
  instance: TemplateInstance;
  takeFontUsage?: () => number;
  scene: THREE.Scene;
  /** 这次 setup 自己建的贴图（文字），实例销毁时释放 */
  owned: THREE.Texture[];
  /** setup 之后模板还可能经 setCamera 换相机：渲染时取最新的 */
  camera(): THREE.Camera;
  duration: number;
  cutTime: number | null;
}

interface CompositionLayer {
  clip: Clip;
  active: Active;
  resources: EngineResources;
  moduleUrl: string;
  transform: ReturnType<typeof compileTransform>;
  source: CompositionLoadRequest['sources'][number];
  sourceSlot: { index: number };
  result: LoadResult;
  params: ParamValues;
}

interface ActiveComposition {
  duration: number;
  totalFrames: number;
  output: LoadRequest['output'];
  stage: StageInfo;
  locale: string;
  layers: CompositionLayer[];
}

interface TraceVariant {
  base: Active;
  active: Active;
  resources: EngineResources;
}

function matchesTrace(config: ExecutionTraceConfig, template: { id: string; version: string }, clipId?: string): config is NonNullable<ExecutionTraceConfig> {
  return !!config && config.target.id === template.id && config.target.version === template.version && config.target.clipId === clipId;
}

/** sRGB 编码的 #RRGGBB → 线性 RGB */
function hexToLinear(hex: string): [number, number, number] {
  const c = new THREE.Color().setStyle(hex, THREE.SRGBColorSpace);
  return [c.r, c.g, c.b];
}

/**
 * 把模板源码当作 ESM 装载（2.4）：Blob URL + 动态 import。
 * 语法错误在宿主交来之前已经用解析器预检过（带位置）；动态 import 报的 SyntaxError 拿不到可用位置，不带。
 */
async function importTemplate(code: string, traceBinding?: string): Promise<ImportedTemplate> {
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  let mod: unknown;
  try {
    mod = await import(/* @vite-ignore */ url);
  } catch (error) {
    const diagnostic: TemplateDiagnostic =
      error instanceof SyntaxError
        ? { kind: 'compile', severity: 'error', code: 'syntax-error', message: describeThrown(error) }
        : diagnosticFromError('load', 'evaluate-failed', error, url);
    throw templateError('template failed to load', diagnostic, error);
  } finally {
    URL.revokeObjectURL(url);
  }
  const def = (mod as { default?: unknown }).default;
  if (!def || typeof (def as { setup?: unknown }).setup !== 'function') {
    throw contractError('load', 'bad-export', 'template must default-export an object with a setup(ctx) function');
  }
  const bind = traceBinding === undefined ? undefined : (mod as Record<string, unknown>)[traceBinding];
  return { module: def as TemplateModule, moduleUrl: url, ...(typeof bind === 'function' ? { bindTrace: bind as BindTraceRecorder } : {}) };
}

function validateInstance(value: unknown): Active['instance'] {
  const bad = (message: string) => contractError('setup', 'bad-instance', message);
  if (!value || typeof value !== 'object') throw bad('setup() must return an object');
  const inst = value as Partial<TemplateInstance>;
  if (typeof inst.update !== 'function') throw bad('instance.update must be a function');
  if (typeof inst.duration !== 'number' || !Number.isFinite(inst.duration) || inst.duration < 0.1 || inst.duration > 30) {
    throw bad(`instance.duration must be between 0.1 and 30 seconds, got ${String(inst.duration)}`);
  }
  const cut = inst.cutTime;
  if (cut !== undefined && cut !== null && (typeof cut !== 'number' || !Number.isFinite(cut) || cut < 0 || cut > inst.duration)) {
    throw bad(`instance.cutTime must be within [0, duration], got ${String(cut)}`);
  }
  if (inst.dispose !== undefined && typeof inst.dispose !== 'function') throw bad('instance.dispose must be a function');
  return inst as TemplateInstance;
}

/** manifest 有参数定义时按定义清洗；派生模板交来的是生效 manifest（4.7），也带参数定义 */
function cleanParams(manifest: TemplateManifest, params: ParamValues, locale: string): ParamValues {
  return manifest.params ? sanitizeParams(manifest.params, params, { locale }) : params;
}

/** 释放场景里模板创建的几何体和材质。贴图属于引擎的缓存，不在这里释放 */
function disposeScene(scene: THREE.Scene): void {
  scene.traverse((obj) => {
    const mesh = obj as Partial<THREE.Mesh>;
    mesh.geometry?.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) for (const m of material) m.dispose();
    else material?.dispose();
  });
  scene.clear();
}

export class Engine implements EngineApi {
  private mode: EngineMode = 'preview';
  private host: HostCallbacks | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private pipeline: FramePipeline | null = null;
  private guard = new DeterminismGuard(false);

  private loaded: Loaded | null = null;
  private active: Active | null = null;
  private composition: ActiveComposition | null = null;
  private traceVariant: TraceVariant | null = null;
  private readonly stagedTraces = new WeakMap<Active, TraceVariant>();
  private loading = false;
  private lifetime = 0;
  private resources: EngineResources | null = null;
  private readonly times: number[] = [];
  /** setup 期间预编译着色器时，编译失败记到这次装载的警告里 */
  private shaderWarn: ((message: string) => void) | null = null;

  async init(opts: InitOptions, host: HostCallbacks): Promise<void> {
    if (this.renderer) throw new Error('engine already initialised');
    this.mode = EngineModeSchema.parse(opts.mode);
    this.host = host;
    this.resources = new EngineResources(
      (kind, id) => host.resolveResource(kind, id),
      (level, message) => host.log(level, message),
    );
    this.guard = new DeterminismGuard(opts.strictDeterminism === true);
    THREE.ColorManagement.enabled = true;

    let canvas: OffscreenCanvas;
    if (this.mode === 'preview') {
      if (!(opts.canvas instanceof OffscreenCanvas)) throw new Error('preview mode needs an OffscreenCanvas');
      canvas = opts.canvas;
    } else {
      // 导出和杂务只渲染到离屏目标，默认帧缓冲用不到
      canvas = new OffscreenCanvas(1, 1);
    }
    const renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: true,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(1);
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x000000, 0);
    // 着色器编译、链接失败：Three 默认只打到控制台，画面就是空的。改成记一条模板警告（装载时预编译能抓到的进
    // LoadResult.warnings，之后渲染时才出现的经 host.log 报出），见 docs/decisions.md M6b
    renderer.debug.onShaderError = (glc, _program, vertexShader, fragmentShader) => {
      const log = (s: WebGLShader) => (glc.getShaderParameter(s, glc.COMPILE_STATUS) ? '' : (glc.getShaderInfoLog(s) ?? '').trim());
      const detail = [log(fragmentShader) && `fragment: ${log(fragmentShader)}`, log(vertexShader) && `vertex: ${log(vertexShader)}`].filter(Boolean).join(' | ');
      const message = `shader failed to compile${detail ? `: ${detail}` : ' or link'}`.replace(/\s+/g, ' ').slice(0, 480);
      if (this.shaderWarn) this.shaderWarn(message);
      else this.host?.log('warn', `template ${message}`);
    };
    const gl = renderer.getContext();
    if (!(gl instanceof WebGL2RenderingContext)) throw new Error('WebGL2 is required');
    if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) {
      throw new Error('half-float render targets are not supported');
    }
    this.renderer = renderer;
    this.pipeline = new FramePipeline(renderer, Math.max(1, canvas.width), Math.max(1, canvas.height), this.mode !== 'preview');
  }

  async load(req: EngineLoadRequest, trace?: ExecutionTraceConfig): Promise<LoadResult | CompositionLoadResult> {
    this.requireInit();
    const config = trace !== undefined && this.mode === 'preview' ? ExecutionTraceConfigSchema.parse(trace) : null;
    return this.duringLoad(async (assertCurrent) => {
      this.disposeTraceVariant();
      if (req === null) {
        this.disposeComposition();
        this.disposeActive();
        this.loaded = null;
        this.resources!.dispose();
        this.renderer!.setRenderTarget(null);
        this.renderer!.setClearColor(0, 0);
        this.renderer!.clear(true, true, false);
        return { duration: 0, cutTime: null, audioCues: [], warnings: [], totalFrames: 0 };
      }
      if ('composition' in req) return this.loadComposition(CompositionLoadRequestSchema.parse(req), assertCurrent, config);
      return this.loadSingle(LoadRequestSchema.parse(req), assertCurrent, config);
    });
  }

  private async duringLoad<T>(load: (assertCurrent: () => void) => Promise<T>): Promise<T> {
    if (this.loading) throw new Error('engine load already in progress');
    this.loading = true;
    const lifetime = this.lifetime;
    try {
      return await load(() => {
        if (lifetime !== this.lifetime) throw new Error('engine disposed during load');
      });
    } finally {
      this.loading = false;
    }
  }

  private async loadSingle(parsed: LoadRequest, assertCurrent: () => void, config: ExecutionTraceConfig): Promise<LoadResult> {
    this.disposeComposition();
    this.resources!.setStamp(parsed.resourceStamp);
    const trace = matchesTrace(config, parsed.manifest) ? config : null;
    const previous = this.loaded;
    const imported = !trace && previous && !previous.tracePlan && previous.code === parsed.code ? previous : await this.importForSetup(parsed.code, trace);
    assertCurrent();
    const stage = computeStage(parsed.output, parsed.referenceSize);
    const locale = parsed.locale ?? 'en';
    // 参数经 template-sdk 的校验函数清洗（4.4）：缺的补默认值，多的丢弃，类型不对的回到默认值，越界的钳制
    const params = cleanParams(parsed.manifest, parsed.params, locale);
    this.loaded = { ...imported, code: parsed.code, resourceStamp: parsed.resourceStamp, manifest: parsed.manifest, locale, output: parsed.output, stage, params };
    if (this.mode !== 'preview') this.pipeline!.setSize(parsed.output.width, parsed.output.height);
    return this.setup();
  }

  private async loadComposition(req: CompositionLoadRequest, assertCurrent: () => void, config: ExecutionTraceConfig): Promise<CompositionLoadResult> {
    const { composition, output } = req;
    const stage = computeStage(output);
    const totalFrames = composition.durationFrames;
    const duration = totalFrames / output.fps;
    const sourceIndexes = new Map(req.sources.map((source, index) => [compositionSourceKey(source.template, source.profile), index]));
    if (sourceIndexes.size !== req.sources.length) throw new Error('duplicate composition source');
    const layers: CompositionLayer[] = [];
    const staged: CompositionLayer[] = [];
    const previous = this.composition;
    const audioCues: AudioCue[] = [];
    const warnings: string[] = [];
    const locale = req.locale ?? 'en';
    const reuse = previous && previous.locale === locale && previous.output.width === output.width &&
      previous.output.height === output.height && previous.output.fps === output.fps;
    const previousById = new Map(reuse ? previous.layers.map((layer) => [layer.clip.id, layer]) : []);
    const host = this.host!;
    let result: CompositionLoadResult;
    try {
      for (const track of composition.tracks) {
        if (track.muted) continue;
        for (const clip of track.clips) {
          if (clip.startFrame >= totalFrames) continue;
          const profile = clip.profile ?? composition.defaultProfile;
          const index = sourceIndexes.get(compositionSourceKey(clip.template, profile));
          if (index === undefined) throw new Error(`missing composition source: ${clip.template.id}@${clip.template.version}`);
          const source = req.sources[index]!;
          const script = 'code' in source ? source : undefined;
          const native = studioMaterialKind(source.template);
          const manifest = script?.manifest ?? studioMaterialManifest(source.template)!;
          const code = script?.code ?? '';
          const params = cleanParams(manifest, clip.params, locale);
          const old = previousById.get(clip.id);
          const transform = compileTransform(clip);
          let layer: CompositionLayer;
          const oldScript = old && 'code' in old.source ? old.source : undefined;
          if (old && old.source.resourceStamp === source.resourceStamp && oldScript?.code === script?.code &&
              compositionSourceKey(old.source.template, old.source.profile) === compositionSourceKey(source.template, profile) &&
              JSON.stringify(oldScript?.manifest) === JSON.stringify(script?.manifest) && JSON.stringify(old.params) === JSON.stringify(params)) {
            layer = { ...old, clip, transform };
          } else {
            const imported = native ? { module: studioMaterials[native], moduleUrl: '' }
              : await this.importForSetup(code, matchesTrace(config, source.template, clip.id) ? config : null);
            assertCurrent();
            const sourceSlot = { index };
            const resources = new EngineResources((kind, id) => host.resolveResource(kind, id, sourceSlot.index), (level, message) => host.log(level, message));
            try {
              const { active, result } = await this.setupInstance({ ...imported, code, manifest, resourceStamp: source.resourceStamp, locale, output, stage, params }, resources, true);
              layer = { clip, active, resources, moduleUrl: imported.moduleUrl, transform, source, sourceSlot, result, params };
            } catch (error) {
              resources.dispose();
              throw error;
            }
            staged.push(layer);
            assertCurrent();
          }
          layers.push(layer);
          for (const cue of layer.result.audioCues) {
            const placed = placeCue(cue, clip, output.fps, totalFrames, profile);
            if (placed) audioCues.push(placed);
          }
          warnings.push(...layer.result.warnings.slice(0, MAX_WARNINGS - warnings.length));
        }
      }
      audioCues.sort((left, right) => left.at - right.at);
      const clipTiming = layers.flatMap(({ clip, result }) => result.timing ? [{ id: clip.id, timing: result.timing }] : []);
      const clipResourceNotices = layers.flatMap(({ clip, result }) => result.resourceNotices?.length ? [{ id: clip.id, notices: result.resourceNotices }] : []);
      result = CompositionLoadResultSchema.parse({ duration, cutTime: null, audioCues, warnings, totalFrames,
        ...(clipTiming.length ? { clipTiming } : {}), ...(clipResourceNotices.length ? { clipResourceNotices } : {}) });
      if (this.mode !== 'preview') this.pipeline!.setSize(output.width, output.height);
    } catch (error) {
      this.disposeLayers(staged);
      throw error;
    }
    this.disposeActive();
    const retained = new Set(layers.map((layer) => layer.active));
    this.disposeLayers(previous?.layers.filter((layer) => !retained.has(layer.active)) ?? []);
    for (const layer of layers) layer.sourceSlot.index = sourceIndexes.get(compositionSourceKey(layer.source.template, layer.source.profile))!;
    this.loaded = null;
    this.composition = { duration, totalFrames, output, stage, layers, locale };
    return result;
  }

  async setParams(params: ParamValues, trace?: ExecutionTraceConfig): Promise<LoadResult> {
    const parsed = ParamValuesSchema.parse(params);
    if (!this.loaded) throw new Error('no template loaded');
    return this.duringLoad(async (assertCurrent) => {
      this.disposeTraceVariant();
      const { module, moduleUrl, tracePlan, ...loaded } = this.loaded!;
      const config = trace !== undefined && this.mode === 'preview' ? ExecutionTraceConfigSchema.parse(trace) : null;
      const selected = matchesTrace(config, loaded.manifest) ? config : null;
      const imported = !tracePlan && !selected ? { module, moduleUrl } : await this.importForSetup(loaded.code, selected);
      assertCurrent();
      this.loaded = { ...loaded, ...imported, params: cleanParams(loaded.manifest, parsed, loaded.locale) };
      return this.setup();
    });
  }

  resize(width: number, height: number): void {
    const [w, h] = ResizeSchema.parse([width, height]);
    if (this.mode !== 'preview') throw new Error('resize() is only for the preview engine');
    this.renderer!.setSize(w, h, false);
    this.pipeline!.setSize(w, h);
  }

  async render(t: number, quality: FrameQuality = DEFAULT_QUALITY): Promise<FrameStats> {
    const q = FrameQualitySchema.parse(quality);
    if (this.mode !== 'preview') throw new Error('render() is only for the preview engine');
    const start = performance.now();
    const variant = this.traceVariant;
    variant?.active.trace?.recorder.begin();
    let fontUsage: FontUsage[] | undefined;
    let tc = t;
    if (this.composition) {
      tc = Math.min(this.composition.duration, Math.max(0, Number.isFinite(t) ? t : 0));
      const byClip = new Map<string, number>();
      this.pipeline!.renderToCanvas(this.compositionOptions(this.composition, tc, q, variant, byClip));
      if (byClip.size) fontUsage = Array.from(byClip, ([clipId, flags]) => ({ clipId, flags }));
    } else if (this.active) {
      tc = Math.min(this.active.duration, Math.max(0, Number.isFinite(t) ? t : 0));
      const active = variant?.active ?? this.active;
      active.takeFontUsage?.();
      this.pipeline!.renderToCanvas(this.passOptions(this.active, tc, q, variant));
      const flags = active.takeFontUsage?.();
      if (flags) fontUsage = [{ flags }];
    } else {
      this.renderer!.setRenderTarget(null);
      this.renderer!.setClearColor(0, 0);
      this.renderer!.clear(true, true, false);
    }
    const trace = variant?.active.trace?.recorder.finish();
    return { t: tc, ms: performance.now() - start, ...(trace ? { trace } : {}), ...(fontUsage ? { fontUsage } : {}) };
  }

  async renderFrame(index: number, quality: FrameQuality, opaque?: Opaque): Promise<ArrayBuffer> {
    const q = FrameQualitySchema.parse(quality);
    const o = opaque === undefined ? undefined : OpaqueSchema.parse(opaque);
    if (!Number.isInteger(index) || index < 0) throw new Error('frame index must be a non-negative integer');
    if (this.mode === 'preview') throw new Error('renderFrame() is for export and utility engines');
    const pixels = this.pipeline!.renderToPixels(this.optionsForFrame(index, q), o ? 'opaque' : 'straight', o ? hexToLinear(o.key) : [0, 0, 0]);
    return pixels.buffer;
  }

  async readPreview(t: number): Promise<ArrayBuffer> {
    if (this.mode !== 'preview') throw new Error('readPreview() is only for the preview engine');
    await this.render(t, DEFAULT_QUALITY);
    // 同一个任务里读，画布还没被提交和清掉
    const gl = this.renderer!.getContext();
    const { width, height } = this.pipeline!.size;
    const raw = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    // 默认帧缓冲的第一行是底部，翻成顶部在前
    const out = new Uint8Array(raw.length);
    const row = width * 4;
    for (let y = 0; y < height; y++) out.set(raw.subarray((height - 1 - y) * row, (height - y) * row), y * row);
    return out.buffer;
  }

  async checkDeterminism(probe: number, others: number[], quality: FrameQuality): Promise<TemplateDiagnostic | null> {
    const q = FrameQualitySchema.parse(quality);
    if (others.length > 64 || [probe, ...others].some((i) => !Number.isInteger(i) || i < 0)) throw new Error('frame indices must be non-negative integers (at most 64 others)');
    if (this.mode === 'preview') throw new Error('checkDeterminism() is for export and utility engines');
    const timeline = this.composition ?? this.requireActive();
    const fps = (this.composition?.output ?? this.loaded!.output).fps;
    const render = (index: number) => this.pipeline!.renderToPixels(this.optionsForFrame(index, q), 'straight', [0, 0, 0]);
    // 第一次的结果复制出来：读回缓冲可能被后面的渲染复用
    const first = new Uint8Array(render(probe));
    for (const i of others) render(i);
    const second = render(probe);
    let differing = first.length === second.length ? 0 : Math.max(first.length, second.length);
    for (let k = 0; k < Math.min(first.length, second.length); k++) if (first[k] !== second[k]) differing++;
    if (differing === 0) return null;
    const t = frameTime(probe, fps, timeline.duration);
    return {
      kind: 'determinism',
      severity: 'warning',
      code: 'render-mismatch',
      message: `frame ${probe} (t = ${t.toFixed(4)} s) changed after rendering frames ${others.join(', ')} in between (${differing} of ${first.length} bytes differ); update(t) must depend only on t`,
      t,
    };
  }

  async renderThumbnail(req: ThumbRequest): Promise<ImageBitmap> {
    const r = ThumbRequestSchema.parse(req);
    if (this.mode === 'preview') throw new Error('renderThumbnail() is for utility and export engines');
    this.requireInit();
    const resources = this.resources!;
    resources.setStamp(r.resourceStamp);
    const { scene, camera } = await buildThumbScene(resources, r.kind, r.id, () => undefined);
    try {
      const pipeline = this.pipeline!;
      pipeline.setSize(r.size, r.size);
      const pixels = pipeline.renderToPixels({ scene, camera, times: [0], update: (t) => resources.applyAnimations(t) }, 'straight', [0, 0, 0]);
      return await createImageBitmap(new ImageData(new Uint8ClampedArray(pixels.buffer as ArrayBuffer), r.size, r.size), { premultiplyAlpha: 'none' });
    } finally {
      disposeScene(scene);
      // 导出引擎上的模板仍按原来的输出尺寸渲染
      const output = this.composition?.output ?? this.loaded?.output;
      if (output) this.pipeline!.setSize(output.width, output.height);
    }
  }

  dispose(): void {
    this.lifetime++;
    this.disposeTraceVariant();
    this.disposeComposition();
    this.disposeActive();
    this.resources?.dispose();
    this.pipeline?.dispose();
    this.renderer?.dispose();
    this.renderer = null;
    this.pipeline = null;
    this.loaded = null;
  }

  // ---- 内部 ----

  private optionsForFrame(index: number, quality: FrameQuality) {
    const composition = this.composition;
    if (composition) {
      if (index >= composition.totalFrames) throw new RangeError('frame index outside composition');
      return this.compositionOptions(composition, index / composition.output.fps, quality);
    }
    const active = this.requireActive();
    return this.passOptions(active, frameTime(index, this.loaded!.output.fps, active.duration), quality);
  }

  private compositionOptions(composition: ActiveComposition, time: number, quality: FrameQuality, traced: TraceVariant | null = null, fontUsage?: Map<string, number>): CompositionRenderOptions {
    const { output: { fps }, stage, layers, duration } = composition;
    return {
      stage,
      times: subframeTimes(time, quality.subframes, quality.shutterAngle, fps, duration, this.times),
      layersAt: (seconds, draw) => {
        const frame = framePosition(seconds, fps);
        if (frame >= composition.totalFrames) return;
        for (const layer of layers) {
          const local = localFrame(layer.clip, frame);
          if (local === null) continue;
          const transform = layer.transform(local);
          if (transform.opacity <= 0 || transform.scale <= 0) continue;
          const sourceTime = Math.min(layer.active.duration, (layer.clip.sourceInFrame + local) / fps);
          const variant = traced?.base === layer.active ? traced : null;
          const active = variant?.active ?? layer.active;
          if (variant) this.updateTraced(variant, sourceTime);
          else this.update(active, layer.resources, layer.moduleUrl, sourceTime);
          if (fontUsage) active.takeFontUsage?.();
          draw({ scene: active.scene, camera: active.camera(), transform });
          if (fontUsage) {
            const flags = active.takeFontUsage?.();
            if (flags) fontUsage.set(layer.clip.id, (fontUsage.get(layer.clip.id) ?? 0) | flags);
          }
        }
      },
    };
  }

  private passOptions(active: Active, t: number, q: FrameQuality, traced: TraceVariant | null = null) {
    const fps = this.loaded!.output.fps;
    if (traced) return {
      scene: traced.active.scene,
      camera: traced.active.camera(),
      times: subframeTimes(t, q.subframes, q.shutterAngle, fps, active.duration, this.times),
      update: (tk: number) => this.updateTraced(traced, tk),
    };
    return {
      scene: active.scene,
      camera: active.camera(),
      times: subframeTimes(t, q.subframes, q.shutterAngle, fps, active.duration, this.times),
      update: (tk: number) => this.update(active, this.resources!, this.loaded!.moduleUrl, tk),
    };
  }

  async configureExecutionTrace(raw: ExecutionTraceConfig): Promise<SetupTraceResult> {
    if (this.mode !== 'preview') throw new Error('trace is only for the preview engine');
    const config = ExecutionTraceConfigSchema.parse(raw);
    return this.duringLoad(async (assertCurrent) => {
      this.traceVariant = null;
      return config ? this.stageTraceVariant(config, assertCurrent) : null;
    });
  }

  private async importForSetup(code: string, trace: ExecutionTraceConfig): Promise<ImportedTemplate> {
    if (trace) {
      try {
        const imported = await importTemplate(applyExecutionTracePlan(code, trace), `${trace.stem}Bind`);
        if (imported.bindTrace) return { ...imported, tracePlan: trace };
      } catch {
        // 插桩不可用时照常装载原始模板。
      }
    }
    return importTemplate(code);
  }

  private async stageTraceVariant(config: NonNullable<ExecutionTraceConfig>, assertCurrent: () => void): Promise<SetupTraceResult> {
    const { target } = config;
    let base: Active;
    let baseResources: EngineResources;
    let seed: Omit<Loaded, keyof ImportedTemplate>;
    let resolve: HostCallbacks['resolveResource'];
    const host = this.host!;
    if (this.composition) {
      const clip = this.composition.layers.find((layer) => matchesTrace(config, layer.source.template, layer.clip.id));
      if (!clip || !('code' in clip.source)) return null;
      base = clip.active;
      baseResources = clip.resources;
      const { code, manifest, resourceStamp } = clip.source;
      const { output, stage, locale } = this.composition;
      seed = { code, manifest, resourceStamp, output, stage, locale, params: clip.params };
      resolve = (kind, id) => host.resolveResource(kind, id, clip.sourceSlot.index);
    } else {
      if (target.clipId !== undefined || !this.active || !this.loaded || !matchesTrace(config, this.loaded.manifest)) return null;
      base = this.active;
      baseResources = this.resources!;
      seed = this.loaded;
      resolve = (kind, id) => host.resolveResource(kind, id);
    }
    if (base.trace) {
      this.traceVariant = { base, active: base, resources: baseResources };
      return base.trace.setup;
    }
    const cached = this.stagedTraces.get(base);
    if (cached) {
      this.traceVariant = cached;
      return cached.active.trace?.setup ?? null;
    }
    const resources = new EngineResources(resolve, (level, message) => host.log(level, message));
    let active: Active | undefined;
    try {
      const imported = await importTemplate(applyExecutionTracePlan(seed.code, config), `${config.stem}Bind`);
      assertCurrent();
      if (!imported.bindTrace) return null;
      const loaded = { ...seed, ...imported, tracePlan: config };
      resources.setStamp(seed.resourceStamp);
      ({ active } = await this.setupInstance(loaded, resources, this.composition !== null));
      assertCurrent();
      if (active.duration !== base.duration || active.cutTime !== base.cutTime) return null;
      this.traceVariant = { base, active, resources };
      this.stagedTraces.set(base, this.traceVariant);
      return active.trace?.setup ?? null;
    } catch {
      return null;
    } finally {
      if (this.traceVariant?.resources !== resources) {
        if (active) this.disposeInstance(active);
        resources.dispose();
      }
    }
  }

  private updateTraced(variant: TraceVariant, t: number): void {
    const { active, resources } = variant;
    this.update(active, resources, active.moduleUrl, t, active.trace?.recorder);
  }

  private disposeTraceVariant(): void {
    this.traceVariant = null;
  }

  /** update(t) 抛出的东西 → 带诊断的 TemplateError */
  private update(active: Active, resources: EngineResources, url: string, t: number, recorder?: ExecutionTraceRecorder): void {
    resources.applyAnimations(t);
    try {
      if (recorder) this.guard.run(() => recorder.run(() => active.instance.update(t)));
      else this.guard.run(() => active.instance.update(t));
    } catch (error) {
      if (error instanceof TemplateError && !active.trace) throw error;
      const diagnostic = error instanceof TemplateError ? error.diagnostic : error instanceof DeterminismViolation
        ? diagnosticFromError('determinism', 'forbidden-api', error, url, { t })
        : diagnosticFromError('update', 'update-threw', error, url, { t });
      if (active.trace && diagnostic.line !== undefined && diagnostic.column !== undefined) {
        Object.assign(diagnostic, originalTraceLocation(active.trace.code, active.trace.plan, { line: diagnostic.line, column: diagnostic.column }));
      }
      if (error instanceof TemplateError) throw error;
      throw templateError(`template update(${t}) failed`, diagnostic, error);
    }
  }

  private requireInit(): void {
    if (!this.renderer || !this.pipeline || !this.host) throw new Error('engine not initialised');
  }

  private requireActive(): Active {
    if (!this.active) throw new Error('no template loaded');
    return this.active;
  }

  private disposeActive(): void {
    const active = this.active;
    this.active = null;
    if (active) this.disposeInstance(active);
  }

  private disposeLayers(layers: readonly CompositionLayer[]): void {
    for (const { active, resources } of layers) {
      this.disposeInstance(active);
      resources.dispose();
    }
  }

  private disposeComposition(): void {
    if (!this.composition) return;
    this.disposeLayers(this.composition.layers);
    this.composition = null;
    this.pipeline?.clearComposition();
  }

  private disposeInstance(active: Active): void {
    const staged = this.stagedTraces.get(active);
    if (staged) {
      this.stagedTraces.delete(active);
      this.disposeInstance(staged.active);
      staged.resources.dispose();
    }
    try {
      active.instance.dispose?.();
    } catch (error) {
      this.host?.log('warn', `template dispose() threw: ${error instanceof Error ? error.message : String(error)}`);
    }
    disposeScene(active.scene);
    for (const t of active.owned) t.dispose();
  }

  private async setup(): Promise<LoadResult> {
    const loaded = this.loaded!;
    this.disposeActive();
    const lifetime = this.lifetime;
    const { active, result } = await this.setupInstance(loaded, this.resources!);
    if (lifetime !== this.lifetime) {
      this.disposeInstance(active);
      throw new Error('engine disposed during setup');
    }
    this.active = active;
    return result;
  }

  private async setupInstance(loaded: Loaded, resources: EngineResources, setupOnly = false): Promise<{ active: Active; result: LoadResult }> {
    const warnings: string[] = [];
    const warn = (message: string, code?: 'catalog-placeholder') => {
      if (warnings.length < MAX_WARNINGS) warnings.push(String(message).slice(0, 500));
      if (code) resourceNotices.add(code);
    };
    const cues: AudioCue[] = [];
    const resourceNotices = new Set<NonNullable<LoadResult['resourceNotices']>[number]>();
    let setupDone = false;
    const setupResource = <T,>(load: () => Promise<T>): Promise<T> => {
      if (setupOnly && setupDone) throw new Error('composition resources may only be loaded during setup');
      return load();
    };
    const owned: THREE.Texture[] = [];
    // text.create 是同步的，字体要在 setup 之前载好
    const fontIds = (loaded.manifest.params ?? []).flatMap((def) => {
      const value = loaded.params[def.key];
      return def.type === 'font' && typeof value === 'string' ? [value] : [];
    });
    let fontUsage = 0;
    const report = this.mode === 'preview' ? (flags: number) => { fontUsage |= flags; } : undefined;
    const text = await setupText(fontIds, (id) => resources.fonts(id), warn, owned, () => !setupDone, report);

    const scene = new THREE.Scene();
    let camera: THREE.Camera = createDefaultCamera(loaded.stage);
    // 模板有 seed 类型的参数时以它为种子（4.4）；没有参数定义的测试模板沿用 params.seed
    const seedParam = loaded.manifest.params ? seedOf(loaded.manifest.params, loaded.params) : loaded.params.seed;
    const seed = typeof seedParam === 'number' && Number.isFinite(seedParam) ? seedParam : 0;
    const noises = new Map<string, Noise2D>();

    const ctx: SetupContext = {
      THREE,
      locale: loaded.locale,
      params: Object.freeze({ ...loaded.params }),
      stage: Object.freeze({ ...loaded.stage }),
      scene,
      get camera() {
        return camera;
      },
      setCamera(next) {
        if (!(next instanceof THREE.Camera)) throw new TypeError('setCamera() expects a THREE.Camera');
        camera = next;
      },
      createStageCamera: (opts) => createStageCamera(loaded.stage, opts.fov),
      resources: {
        texture: (id) => setupResource(() => resources.texture(id, warn)),
        optionalTexture: (id) => setupResource(() => resources.optionalTexture(id)),
        block: (id, opts) => setupResource(() => createBlockHandle(resources, id, opts, warn)),
        item: (id) => setupResource(() => createItemHandle(resources, id, warn)),
      },
      text,
      sprite: { create: (texture, opts) => createSprite(texture, opts) },
      random: (key = '') => createRng(seed, String(key)),
      noise2D: (x, y, key = '') => {
        const k = String(key);
        let fn = noises.get(k);
        if (!fn) {
          fn = createNoise2D(seed, k);
          noises.set(k, fn);
        }
        return fn(x, y);
      },
      ease,
      math,
      time: { segment },
      audio: {
        cue(sound, at, opts = {}) {
          if (setupDone) {
            const message = 'ctx.audio.cue() may only be called during setup()';
            // 这个 Error 的调用栈里有模板调用它的那一行
            throw new TemplateError(message, diagnosticFromError('update', 'audio-cue-outside-setup', new Error(message), loaded.moduleUrl, { message }));
          }
          if (sound === null) return;
          if (typeof sound !== 'string' || typeof at !== 'number' || !Number.isFinite(at)) throw new TypeError('invalid audio cue');
          let spatial: AudioCue['spatial'];
          if (opts.position) {
            const [x, y, z] = opts.position;
            if (![x, y, z].every(Number.isFinite)) throw new TypeError('invalid audio cue position');
            const world = new THREE.Vector3(x, y, z);
            camera.updateWorldMatrix(true, false);
            const local = camera.worldToLocal(world.clone());
            const screen = world.project(camera);
            const reference = loaded.stage.width / 2;
            const distance = Math.hypot(local.x, local.y, local.z) / reference;
            const center = camera.worldToLocal(new THREE.Vector3()).length() / reference;
            const excess = Math.max(0, distance - center);
            spatial = { pan: Math.max(-1, Math.min(1, Number.isFinite(screen.x) ? screen.x : 0)), gain: 1 / (1 + 2 * excess) };
          }
          cues.push({ sound, at, gain: opts.gain ?? 1, rate: opts.rate ?? 1, pan: opts.pan ?? 0, variant: null, ...(spatial ? { spatial } : {}) });
        },
      },
      warn(message, code) {
        warn(message);
        if (!setupDone && code === 'panorama-fallback') {
          const parsed = ResourceNoticeCodeSchema.safeParse(code);
          if (parsed.success) resourceNotices.add(parsed.data);
        }
      },
    };

    let instance: TemplateInstance;
    let timing: EffectiveTiming | undefined;
    const plan = loaded.tracePlan;
    const recorder = plan && loaded.bindTrace ? new ExecutionTraceRecorder(loaded.bindTrace) : null;
    try {
      instance = validateInstance(recorder ? await recorder.runSetup(() => loaded.module.setup(ctx)) : await loaded.module.setup(ctx));
      const declared = instance.timing;
      if (declared !== undefined) {
        const parsed = EffectiveTimingSchema.safeParse(declared);
        const segments = loaded.manifest.timeline?.segments ?? [];
        if (!parsed.success || segments.length !== Object.keys(parsed.data.durations).length ||
            segments.some(({ param }) => !Object.hasOwn(parsed.data.durations, param)) ||
            Math.abs(Object.values(parsed.data.durations).reduce((sum, duration) => sum + duration, 0) - instance.duration) >= 1e-6) {
          throw contractError('setup', 'bad-instance', 'instance.timing must match manifest timeline segments and sum to instance.duration');
        }
        timing = parsed.data;
      }
    } catch (error) {
      disposeScene(scene);
      for (const t of owned) t.dispose();
      if (error instanceof TemplateError) throw error;
      const diagnostic = diagnosticFromError('setup', 'setup-threw', error, loaded.moduleUrl);
      if (plan && diagnostic.line !== undefined && diagnostic.column !== undefined) {
        Object.assign(diagnostic, originalTraceLocation(loaded.code, plan, { line: diagnostic.line, column: diagnostic.column }));
      }
      throw templateError('template setup() failed', diagnostic, error);
    } finally {
      setupDone = true;
    }
    const cutTime = instance.cutTime ?? null;
    const active: Active = { instance, scene, owned, moduleUrl: loaded.moduleUrl, camera: () => camera, duration: instance.duration, cutTime,
      ...(report && { takeFontUsage: () => { const flags = fontUsage; fontUsage = 0; return flags; } }),
      ...(recorder && plan ? { trace: { code: loaded.code, recorder, plan, setup: recorder.finish() ?? null } } : {}) };
    // 预编译着色器：编译失败在这次装载的警告里出现，而不是只在控制台
    this.shaderWarn = warn;
    try {
      this.pipeline!.compileScene(scene, camera);
    } catch (error) {
      this.host?.log('warn', `shader precompile failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.shaderWarn = null;
    }
    try {
      const audioCues = await this.pickVariants(cues, seed, resources);
      return { active, result: { duration: instance.duration, cutTime, audioCues, warnings,
        ...(timing ? { timing } : {}), ...(resourceNotices.size ? { resourceNotices: [...resourceNotices] } : {}) } };
    } catch (error) {
      this.disposeInstance(active);
      throw error;
    }
  }

  /**
   * 给每个 cue 选定音效变体（02-engine.md 2.10）：同一事件的第 n 个 cue 用 random('sound:' + 事件 + ':' + n)，
   * 和模板的 ctx.random 是同一个生成器，所以预览和导出（以及两次装载）选到同一个。资源栈里没有这个事件时 variant 为 null。
   */
  private async pickVariants(cues: readonly AudioCue[], seed: number, resources: EngineResources): Promise<AudioCue[]> {
    const ordinal = new Map<string, number>();
    const out: AudioCue[] = [];
    for (const cue of cues) {
      const n = ordinal.get(cue.sound) ?? 0;
      ordinal.set(cue.sound, n + 1);
      const variants = await resources.soundVariants(cue.sound);
      const picked = pickSoundVariant(variants, createRng(seed, `sound:${cue.sound}:${n}`).next());
      out.push({ ...cue, variant: picked ? { file: picked.file, volume: picked.volume, pitch: picked.pitch, ...(picked.kind ? { kind: picked.kind } : {}) } : null });
    }
    return out;
  }
}
