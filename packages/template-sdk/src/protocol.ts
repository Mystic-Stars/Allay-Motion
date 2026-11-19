// 宿主与引擎 Worker 之间的协议数据（docs/02-engine.md 2.3）。
// 线程边界两侧都用这些 schema 校验：Worker 校验宿主发来的请求，宿主校验 Worker 交回的结果。
// 放在 template-sdk 是因为引擎只能依赖 three、template-sdk、assets（1.4），而这些 schema 需要 zod。
import { z } from 'zod';
import { COMPOSITION_MAX_CLIPS, COMPOSITION_MAX_SECONDS, CompositionIdSchema, CompositionSchema, CompositionTemplateSchema } from './composition';
import { TemplateManifestSchema } from './manifest';
import { studioMaterialKind } from './studio';
import type { ParamValue } from './runtime';

export const MAX_EXECUTION_TRACE_LINES = 4096;
export const MAX_EXECUTION_TRACE_EDITS = 50_000;

export const ParamValueSchema: z.ZodType<ParamValue> = z.lazy(() =>
  z.union([z.number(), z.string(), z.boolean(), z.null(), z.array(ParamValueSchema), z.record(z.string(), ParamValueSchema)]),
);
export const ParamValuesSchema = z.record(z.string(), ParamValueSchema);

export { TemplateManifestSchema, type TemplateManifest } from './manifest';

export const OutputSettingsSchema = z.strictObject({
  width: z.int().min(16).max(8192),
  height: z.int().min(16).max(8192),
  fps: z.int().min(1).max(240),
});
export type OutputSettings = z.infer<typeof OutputSettingsSchema>;

/** 模板源码上限（04-templates.md 4.8 第 3 步） */
export const MAX_TEMPLATE_CODE_BYTES = 1024 * 1024;
const TraceLineSchema = z.int().min(1).max(MAX_TEMPLATE_CODE_BYTES + 1);
export const ExecutionTraceLinesSchema = z.array(TraceLineSchema).max(MAX_EXECUTION_TRACE_LINES);

export const LoadRequestSchema = z.strictObject({
  manifest: TemplateManifestSchema,
  code: z.string().min(1).max(MAX_TEMPLATE_CODE_BYTES),
  params: ParamValuesSchema,
  output: OutputSettingsSchema,
  referenceSize: OutputSettingsSchema.pick({ width: true, height: true }).optional(),
  resourceStamp: z.string().max(256),
  /** text 参数缺值时按这个语言取默认值（4.4）；缺省英文 */
  locale: z.string().max(16).optional(),
});
export type LoadRequest = z.infer<typeof LoadRequestSchema>;

export const CompositionSourceKeySchema = z.int().min(0).max(COMPOSITION_MAX_CLIPS - 1);
const CompositionSourceBaseSchema = z.strictObject({
  resourceStamp: z.string().max(1024),
  template: CompositionTemplateSchema,
  profile: z.string().min(1).max(256).optional(),
});
const CompositionSourceSchema = z.union([
  CompositionSourceBaseSchema.extend(LoadRequestSchema.pick({ manifest: true, code: true }).shape)
    .refine(({ template }) => !studioMaterialKind(template), { message: 'native material cannot provide script code' }),
  CompositionSourceBaseSchema.refine(({ template }) => !!studioMaterialKind(template), { message: 'unknown native material' }),
]);

export const CompositionLoadRequestSchema = z.strictObject({
  composition: CompositionSchema,
  output: OutputSettingsSchema,
  sources: z.array(CompositionSourceSchema).max(COMPOSITION_MAX_CLIPS),
  locale: z.string().max(16).optional(),
}).refine(({ composition, output }) => composition.fps === output.fps, { message: 'composition frame rate must match output' });
export type CompositionLoadRequest = z.infer<typeof CompositionLoadRequestSchema>;
export type EngineLoadRequest = LoadRequest | CompositionLoadRequest | null;

export function compositionSourceKey(template: { id: string; version: string }, profile?: string): string {
  return JSON.stringify([template.id, template.version, profile ?? null]);
}

/**
 * 引擎替一个 cue 选定的音效变体（02-engine.md 2.10）：file 是带命名空间的音效名（sounds.json 里的 name），
 * volume、pitch 是 sounds.json 给这个变体的系数（播放时分别乘到 gain、rate 上）。
 */
export const AudioCueVariantSchema = z.strictObject({
  file: z.string().min(1).max(256),
  volume: z.number().min(0).max(16),
  pitch: z.number().min(0).max(16),
  kind: z.enum(['effect', 'music']).optional(),
});
export type AudioCueVariant = z.infer<typeof AudioCueVariantSchema>;

export const AudioCueSchema = z.strictObject({
  sound: z.string(),
  at: z.number(),
  gain: z.number(),
  rate: z.number(),
  pan: z.number(),
  spatial: z.strictObject({ pan: z.number().min(-1).max(1), gain: z.number().min(0).max(1) }).optional(),
  /** 选定的变体；资源栈里没有这个音效事件时为 null（宿主静音并给警告） */
  variant: AudioCueVariantSchema.nullable(),
  /** 合成 cue：at 是裁切后的起点，offset 是已越过的播放秒数（尚未乘播放速率）。 */
  clip: z.strictObject({
    end: z.number().min(0).max(COMPOSITION_MAX_SECONDS),
    offset: z.number().min(0),
    profile: z.string().min(1).max(256).optional(),
  }).optional(),
});
export type AudioCue = z.infer<typeof AudioCueSchema>;

// ---- 结构化诊断（docs/code-editing-and-mcp-plan.md H5、H12） ----

/**
 * 诊断的种类：
 * - compile：装载前的预检（语法错误、出现 import、源码过大）
 * - load：模块求值失败、默认导出不对
 * - setup / update：模板的 setup()、update(t) 抛错，或 setup() 的返回值不合契约
 * - watchdog：在时限内没有返回，Worker 已被终止
 * - determinism：开发构建在 update(t) 里拦到 Math.random 等；同一帧穿插渲染后不一致
 * - rule：静态规则检查的提示（不替代运行时的拦截与比对）
 */
export const DIAGNOSTIC_KINDS = ['compile', 'load', 'setup', 'update', 'watchdog', 'determinism', 'rule'] as const;
export type DiagnosticKind = (typeof DIAGNOSTIC_KINDS)[number];

export const DiagnosticSeveritySchema = z.enum(['error', 'warning']);
export type DiagnosticSeverity = z.infer<typeof DiagnosticSeveritySchema>;

/** 诊断里文字的上限：错误信息来自模板代码，限长后才交给界面 */
export const MAX_DIAGNOSTIC_MESSAGE = 2000;

const diagnosticBase = {
  severity: DiagnosticSeveritySchema,
  /** 稳定的错误码（小写、连字符），界面和测试按它判断，不解析 message */
  code: z.string().regex(/^[a-z][a-z0-9-]*$/).max(64),
  /** 给人看的细节（英文，来自引擎或模板抛出的错误） */
  message: z.string().max(MAX_DIAGNOSTIC_MESSAGE),
  /** 模板源码里的位置，从 1 开始数；拿不到可靠位置时不带（不编造） */
  line: z.int().min(1).optional(),
  column: z.int().min(1).optional(),
};
/** 出错时的时刻（秒） */
const atTime = { t: z.number().optional() };

export const TemplateDiagnosticSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('compile'), ...diagnosticBase }),
  z.strictObject({ kind: z.literal('load'), ...diagnosticBase }),
  z.strictObject({ kind: z.literal('setup'), ...diagnosticBase }),
  z.strictObject({ kind: z.literal('update'), ...diagnosticBase, ...atTime }),
  z.strictObject({
    kind: z.literal('watchdog'),
    ...diagnosticBase,
    /** 超时的调用（load、render、renderFrame 等） */
    operation: z.string().max(64),
    timeoutMs: z.number().min(0),
  }),
  z.strictObject({ kind: z.literal('determinism'), ...diagnosticBase, ...atTime }),
  z.strictObject({ kind: z.literal('rule'), ...diagnosticBase }),
]);
export type TemplateDiagnostic = z.infer<typeof TemplateDiagnosticSchema>;
export const TemplateDiagnosticsSchema = z.array(TemplateDiagnosticSchema).max(200);

/**
 * 错误对象上带的诊断（引擎的 TemplateError、宿主的看门狗错误、源码预检错误都挂在 `diagnostic` 字段上）。
 * 跨线程传来的错误也走这里：字段不合 schema 就当没有。
 */
export function diagnosticOf(error: unknown): TemplateDiagnostic | null {
  if (!error || typeof error !== 'object') return null;
  const parsed = TemplateDiagnosticSchema.safeParse((error as { diagnostic?: unknown }).diagnostic);
  return parsed.success ? parsed.data : null;
}

/** 截断给人看的文字 */
export function clipDiagnosticMessage(message: string): string {
  return message.length <= MAX_DIAGNOSTIC_MESSAGE ? message : `${message.slice(0, MAX_DIAGNOSTIC_MESSAGE - 1)}…`;
}

export const EffectiveTimingSchema = z.strictObject({
  durations: z.record(z.string().regex(/^[a-z][a-zA-Z0-9]{0,63}$/), z.number().min(0).max(30))
    .refine((durations) => Object.keys(durations).length >= 1 && Object.keys(durations).length <= 16),
  editable: z.boolean(),
});

export const ResourceNoticeCodeSchema = z.enum(['panorama-fallback', 'catalog-placeholder']);
const ResourceNoticesSchema = z.array(ResourceNoticeCodeSchema).max(ResourceNoticeCodeSchema.options.length);

export const LoadResultSchema = z.strictObject({
  duration: z.number().min(0.1).max(30),
  cutTime: z.number().nullable(),
  audioCues: z.array(AudioCueSchema),
  warnings: z.array(z.string()),
  resourceNotices: ResourceNoticesSchema.optional(),
  timing: EffectiveTimingSchema.optional(),
  /**
   * 静态规则检查的提示（rule 类诊断，H12）。由宿主在交给引擎之前算出并附上；引擎自己不填。
   * 可选字段：旧的调用方只看 warnings。
   */
  diagnostics: TemplateDiagnosticsSchema.optional(),
});
export type LoadResult = z.infer<typeof LoadResultSchema>;

export const CompositionLoadResultSchema = LoadResultSchema.extend({
  duration: z.number().min(0).max(COMPOSITION_MAX_SECONDS),
  cutTime: z.null(),
  totalFrames: z.int().min(0).max(COMPOSITION_MAX_SECONDS * 60),
  clipTiming: z.array(z.strictObject({ id: CompositionIdSchema, timing: EffectiveTimingSchema })).max(COMPOSITION_MAX_CLIPS).optional(),
  clipResourceNotices: z.array(z.strictObject({ id: CompositionIdSchema, notices: ResourceNoticesSchema })).max(COMPOSITION_MAX_CLIPS).optional(),
});
export type CompositionLoadResult = z.infer<typeof CompositionLoadResultSchema>;

export const FrameQualitySchema = z.strictObject({
  /** 1 表示没有运动模糊 */
  subframes: z.int().min(1).max(64),
  /** 快门角，度 */
  shutterAngle: z.number().min(0).max(360),
});
export type FrameQuality = z.infer<typeof FrameQualitySchema>;

export const OpaqueSchema = z.strictObject({ key: z.string().regex(/^#[0-9a-fA-F]{6}$/) });
export type Opaque = z.infer<typeof OpaqueSchema>;

export const ExecutionTraceTargetSchema = CompositionTemplateSchema.extend({ clipId: CompositionIdSchema.optional() });
export type ExecutionTraceTarget = z.infer<typeof ExecutionTraceTargetSchema>;
const TraceOffsetSchema = z.int().min(0).max(MAX_TEMPLATE_CODE_BYTES);
export const ExecutionTraceConfigSchema = z.strictObject({
  target: ExecutionTraceTargetSchema,
  stem: z.string().regex(/^__allayTrace\d+$/).max(24),
  insertions: z.array(z.union([
    z.tuple([TraceOffsetSchema, z.enum(['mark', 'entry', 'block', 'expression']), TraceLineSchema]),
    z.tuple([TraceOffsetSchema, z.enum(['end-block', 'end-expression'])]),
  ])).min(1).max(MAX_EXECUTION_TRACE_EDITS),
}).nullable();
export type ExecutionTraceConfig = z.infer<typeof ExecutionTraceConfigSchema>;
export type ExecutionTracePlan = Omit<NonNullable<ExecutionTraceConfig>, 'target'>;
export const SetupTraceResultSchema = ExecutionTraceLinesSchema.nullable();
export type SetupTraceResult = z.infer<typeof SetupTraceResultSchema>;

function traceInsertion(stem: string, [, kind, line]: ExecutionTracePlan['insertions'][number]): string {
  const call = kind === 'entry' ? `${stem}(${line},true)` : `${stem}(${line})`;
  return kind === 'mark' || kind === 'entry' ? `;${call};` : kind === 'block' ? `{${call};` :
    kind === 'expression' ? `(${call},(` : kind === 'end-block' ? ';}' : '))';
}

/** 宿主验证和预览 Worker 使用相同的受限插入操作；协议不携带可执行的字符串。 */
export function applyExecutionTracePlan(source: string, { stem, insertions }: ExecutionTracePlan): string {
  let from = 0;
  const pieces: string[] = [];
  for (const edit of insertions) {
    const offset = edit[0];
    if (offset < from || offset > source.length) throw new Error('invalid trace insertion offset');
    pieces.push(source.slice(from, offset), traceInsertion(stem, edit));
    from = offset;
  }
  pieces.push(source.slice(from), `\nvar ${stem}Sink;function ${stem}(line,entry){if(${stem}Sink)${stem}Sink(line,entry);}export function ${stem}Bind(sink){${stem}Sink=sink;}\n`);
  return pieces.join('');
}

export function originalTraceLocation(source: string, plan: ExecutionTracePlan, location: { line: number; column: number }): { line: number; column?: number } {
  const { line } = location;
  const newlines = /\r\n|[\n\r\u2028\u2029]/g;
  for (let current = 1; current < line; current++) if (!newlines.exec(source)) return { line };
  const start = newlines.lastIndex;
  const end = newlines.exec(source)?.index ?? source.length;
  let column = location.column;
  for (const edit of plan.insertions) {
    const offset = edit[0];
    if (offset < start) continue;
    if (offset > end || offset - start >= column) break;
    column = Math.max(offset - start + 1, column - traceInsertion(plan.stem, edit).length);
  }
  return { line, column };
}

/** 按实际画出墨迹的行标记，再按位合并到帧。4 只供旧帧协议兼容，不再生成。 */
export const FontUsageFlag = {
  /** 一行可见墨迹全来自系统字体。 */
  whole: 1,
  /** 同一行有资源栈与系统字形的可见墨迹。 */
  partial: 2,
  /** @deprecated 旧版显式内置 BDF 标记。 */
  explicit: 4,
  /** 发生系统回退，且字体请求归一化后为 minecraft:default。 */
  resourceDefault: 8,
} as const;
const FontUsageSchema = z.strictObject({
  clipId: CompositionIdSchema.optional(),
  flags: z.int().min(1).max(15),
});
export type FontUsage = z.infer<typeof FontUsageSchema>;

export const FrameStatsSchema = z.strictObject({
  t: z.number(), ms: z.number(),
  trace: ExecutionTraceLinesSchema.optional(),
  fontUsage: z.array(FontUsageSchema).max(COMPOSITION_MAX_CLIPS).optional(),
});
export type FrameStats = z.infer<typeof FrameStatsSchema>;

export const ResourceKindSchema = z.enum(['texture', 'sound-meta', 'font', 'raw']);
export type ResourceKind = z.infer<typeof ResourceKindSchema>;

/** 资源的最大边长 */
export const MAX_TEXTURE_SIZE = 4096;

/** 类型化数组：不限定底层缓冲的类型（ArrayBuffer 或 SharedArrayBuffer 都接受，运行时只认构造函数） */
const typedArray = <T extends ArrayBufferView>(ctor: abstract new (...args: never[]) => T) => z.custom<T>((v) => v instanceof ctor, { message: `expected ${ctor.name}` });

const RgbaImageShape = {
  width: z.int().min(1).max(MAX_TEXTURE_SIZE),
  height: z.int().min(1).max(MAX_TEXTURE_SIZE),
  data: typedArray<Uint8Array>(Uint8Array),
};
const rgbaLengthOk = (p: { width: number; height: number; data: Uint8Array }) => p.data.byteLength === p.width * p.height * 4;
const RGBA_LENGTH_MESSAGE = { message: 'data length must be width * height * 4' };

export const RgbaImageSchema = z.strictObject(RgbaImageShape).refine(rgbaLengthOk, RGBA_LENGTH_MESSAGE);
export type RgbaImage = z.infer<typeof RgbaImageSchema>;

/**
 * 解码好的 RGBA8 贴图（直通 alpha，sRGB 编码，第一行是图像顶部）。
 * mcmeta 是与这张图来自同一层的 `.png.mcmeta` 原文（动画、界面九宫格），引擎自己解析。
 */
export const TexturePayloadSchema = z
  .strictObject({ kind: z.literal('rgba'), ...RgbaImageShape, mcmeta: z.string().max(65_536).optional() })
  .refine(rgbaLengthOk, RGBA_LENGTH_MESSAGE);
export type TexturePayload = z.infer<typeof TexturePayloadSchema>;

/** 资源栈里的位图字体（原版 font/*.json 展开 reference 之后的 bitmap、space 提供器，3.9） */
const OutlineShape = {
  size: z.number().min(1).max(64),
  oversample: z.number().min(1).max(8),
  shift: z.tuple([z.number().min(-32).max(32), z.number().min(-32).max(32)]),
  skip: z.string().max(65_536),
};

export const OutlineProviderPayloadSchema = z.strictObject({
  type: z.literal('ttf'), ...OutlineShape,
  bytes: typedArray<Uint8Array>(Uint8Array).refine((bytes) => bytes.byteLength >= 12 && bytes.byteLength <= 32 * 1024 * 1024),
});

const BitmapFontTablesShape = {
  ascent: z.int().min(0).max(64),
  descent: z.int().min(0).max(64),
  codepoints: typedArray<Uint32Array>(Uint32Array),
  metrics: typedArray<Int16Array>(Int16Array),
  offsets: typedArray<Uint32Array>(Uint32Array),
  bits: typedArray<Uint8Array>(Uint8Array),
};
const tableLengthsOk = (tables: { metrics: Int16Array; offsets: Uint32Array; codepoints: Uint32Array }) =>
  tables.metrics.length === tables.codepoints.length * 5 && tables.offsets.length === tables.codepoints.length;
export const BitmapFontTablesSchema = z.strictObject(BitmapFontTablesShape).refine(tableLengthsOk, { message: 'table lengths mismatch' });

export const FontProviderPayloadSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('bitmap'),
    ascent: z.int().min(-512).max(512),
    height: z.int().min(1).max(512),
    rows: z.array(z.array(z.int().min(0).max(0x10ffff)).max(1024)).max(1024),
    image: RgbaImageSchema,
  }),
  z.strictObject({ type: z.literal('space'), advances: z.array(z.tuple([z.int().min(0).max(0x10ffff), z.number().min(-512).max(512)])).max(65_536) }),
  OutlineProviderPayloadSchema,
  z.strictObject({ type: z.literal('unihex'), tables: BitmapFontTablesSchema }),
]);
export type FontProviderPayload = z.infer<typeof FontProviderPayloadSchema>;

export const FontPayloadSchema = z.strictObject({
  kind: z.literal('font'),
  providers: z.array(FontProviderPayloadSchema).max(256),
  /** 跳过的提供器（unihex、ttf、缺失的贴图等），供诊断 */
  skipped: z.array(z.string()).max(256),
});
export type FontPayload = z.infer<typeof FontPayloadSchema>;

/** 音效事件的全部变体（resolveResource('sound-meta', 事件 ID)）：资源栈里合并后的 sounds.json 展开 event 引用之后 */
export const SoundMetaVariantSchema = z.strictObject({
  file: z.string().min(1).max(256),
  volume: z.number().min(0).max(16),
  pitch: z.number().min(0).max(16),
  weight: z.number().min(0).max(1_000_000),
  kind: z.enum(['effect', 'music']).optional(),
});
export type SoundMetaVariant = z.infer<typeof SoundMetaVariantSchema>;

export const SoundMetaPayloadSchema = z.strictObject({
  kind: z.literal('sound'),
  variants: z.array(SoundMetaVariantSchema).max(1024),
});
export type SoundMetaPayload = z.infer<typeof SoundMetaPayloadSchema>;

export const ResourcePayloadSchema = z.union([TexturePayloadSchema, FontPayloadSchema, SoundMetaPayloadSchema]);
export type ResourcePayload = z.infer<typeof ResourcePayloadSchema>;

/** 缩略图请求（03-assets.md 3.10）：方块是带面明暗的等轴视角，物品正面平视 */
export const ThumbRequestSchema = z.strictObject({
  kind: z.enum(['block', 'item']),
  id: z.string().min(1).max(256),
  size: z.union([z.literal(64), z.literal(128)]),
  resourceStamp: z.string().max(256),
});
export type ThumbRequest = z.infer<typeof ThumbRequestSchema>;

export const EngineModeSchema = z.enum(['preview', 'export', 'utility']);
export type EngineMode = z.infer<typeof EngineModeSchema>;

export const ResizeSchema = z.tuple([z.int().min(1).max(8192), z.int().min(1).max(8192)]);

