// 工程文件 .allay（docs/01-product-architecture.md 1.9）与 project 命名空间的 IPC 数据。
// 渲染进程看不到路径：打开、保存的工程用主进程签发的不透明句柄表示；texture 参数里用户选的图片是 file:<引用>，
// 主进程保存时换成 files 里的本机路径，打开时再签发新的引用（1.6 第 6 条）。
import { CompositionFpsSchema, CompositionParamsSchema, CompositionSchema, TemplateIdSchema, type ParamValue } from '@allay/template-sdk';
import { z } from 'zod';
import { DEFAULT_KEY_COLOR, ExportPresetSchema, KeyColorSchema } from './export';

export const PROJECT_FORMAT_VERSION = 2;
export const PROJECT_EXTENSION = 'allay';
/** 工程文件大小上限（纯 JSON，正常不过几 KB） */
export const MAX_PROJECT_BYTES = 2 * 1024 * 1024;
export const MAX_RECENTS = 10;
export const MAX_PROJECT_IMAGES = 512;
export const PROJECT_IMAGE_REF = /^file:([0-9a-fA-F-]{36})$/;
export const UNLINKED_PROJECT_IMAGE_REF = /^unlinked-file:[0-9a-fA-F-]{36}$/;

/** 只改写精确匹配的图片引用；不解释文案、资源 ID 或包内 asset: 引用。 */
export function mapProjectImages(
  value: ParamValue,
  map: (value: string) => string,
): ParamValue {
  if (typeof value === 'string') return PROJECT_IMAGE_REF.test(value) || UNLINKED_PROJECT_IMAGE_REF.test(value) ? map(value) : value;
  if (Array.isArray(value)) return value.map((child) => mapProjectImages(child, map));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, mapProjectImages(child, map)]));
  return value;
}

const ParamKey = z.string().regex(/^[a-z][a-zA-Z0-9]*$/).max(64);
const ParamsSchema = CompositionParamsSchema.refine((params) => Object.keys(params).every((key) => ParamKey.safeParse(key).success));

export const ProjectOutputSchema = z.strictObject({
  width: z.int().min(16).max(8192),
  height: z.int().min(16).max(8192),
  fps: CompositionFpsSchema,
});

export const ProjectExportSchema = z.strictObject({
  preset: ExportPresetSchema,
  quality: z.enum(['draft', 'standard', 'high', 'ultra']),
  shutterAngle: z.number().min(0).max(360),
  /** 绿幕 MP4 的底色（M7）；旧工程没有这一项时用 #00FF00 */
  key: KeyColorSchema.default(DEFAULT_KEY_COLOR),
});

export const ProjectPreviewSchema = z.strictObject({
  background: z.enum(['checker', 'sample', 'solid']),
});

/** 渲染进程交给主进程保存的内容（不含 files：file: 引用留在 params 里，由主进程换成路径） */
const ProjectCommonSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  output: ProjectOutputSchema,
  export: ProjectExportSchema,
  preview: ProjectPreviewSchema,
  /** 只是记一笔保存时启用了哪些层（1.9） */
  resourceHint: z.array(z.string().max(200)).max(64),
});
const LegacyTemplateRef = z.strictObject({ id: TemplateIdSchema, version: z.string().min(1).max(64) });
export const QuickProjectDataSchema = ProjectCommonSchema.extend({ template: LegacyTemplateRef, params: ParamsSchema });
export type QuickProjectData = z.infer<typeof QuickProjectDataSchema>;
const CompositionProjectDataSchema = ProjectCommonSchema.extend({ composition: CompositionSchema });
const fpsMatches = (data: z.infer<typeof CompositionProjectDataSchema>) => data.output.fps === data.composition.fps;
export const ProjectDataSchema = z.union([QuickProjectDataSchema, CompositionProjectDataSchema.refine(fpsMatches)]);
export type ProjectData = z.infer<typeof ProjectDataSchema>;

/** 磁盘上的 .allay */
const QuickProjectFileSchema = z.looseObject({
  formatVersion: z.literal(1),
  appVersion: z.string().max(64).optional(),
  name: z.string().max(120).catch('').default(''),
  template: LegacyTemplateRef,
  params: ParamsSchema.catch({}).default({}),
  output: ProjectOutputSchema.catch({ width: 1920, height: 1080, fps: 60 }).default({ width: 1920, height: 1080, fps: 60 }),
  export: ProjectExportSchema.catch({ preset: 'prores4444', quality: 'standard', shutterAngle: 180, key: DEFAULT_KEY_COLOR }).default({ preset: 'prores4444', quality: 'standard', shutterAngle: 180, key: DEFAULT_KEY_COLOR }),
  preview: ProjectPreviewSchema.catch({ background: 'checker' }).default({ background: 'checker' }),
  files: z.record(ParamKey, z.string().max(4096)).catch({}).default({}),
  resourceHint: z.array(z.string().max(200)).max(64).catch([]).default([]),
});
const CompositionProjectFileSchema = CompositionProjectDataSchema.extend({
  formatVersion: z.literal(PROJECT_FORMAT_VERSION),
  appVersion: z.string().max(64).optional(),
  files: z.array(z.uuid()).max(MAX_PROJECT_IMAGES).optional(),
}).refine(fpsMatches);
export const ProjectFileSchema = z.discriminatedUnion('formatVersion', [QuickProjectFileSchema, CompositionProjectFileSchema]);
export type ProjectFile = z.infer<typeof ProjectFileSchema>;

export const ProjectHandleSchema = z.uuid();

export type ProjectOpenResult =
  | { canceled: true }
  | { canceled?: false; ok: false; error: 'unreadable' | 'invalid' | 'too-new' | 'too-large' | 'missing' }
  | {
      canceled?: false;
      ok: true;
      handle: string;
      /** 文件名（不含扩展名），界面上当工程名 */
      name: string;
      data: ProjectData;
      /** 找不到的图片对应的参数 key：这些参数回到默认值并提示（1.9） */
      missingFiles: string[];
    };

export type ProjectSaveResult = { canceled: true } | { canceled?: false; ok: false; error: 'not-writable' | 'unknown-handle' } | { canceled?: false; ok: true; handle: string; name: string };

export interface RecentProject {
  /** 不透明句柄：openRecent 用 */
  id: string;
  name: string;
  /** 所在文件夹，只用于显示 */
  folder: string;
}
