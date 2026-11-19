// 导出任务（docs/code-editing-and-mcp-plan.md H7）：导出是一个有编号、状态、进度、可以取消的任务，
// 由带类型的命令启动、查询、取消（exportCommands，经注册表的 dispatch 执行）。导出对话框只是任务的一个观察者，
// 将来的可选模块（如 MCP）也只经这三个命令。一次只跑一个任务（导出是模态的，5.1）。
import i18next from 'i18next';
import { z } from 'zod';
import { create } from 'zustand';
import {
  EXPORT_ERROR_CODES,
  ExportPresetSchema,
  KeyColorSchema,
  exportBaseName,
  type ExportPreset,
} from '../../../shared/export';
import { defineCommand, type AnyCommand } from '../../app/registry';
import { usePreviewStore } from '../../stores/previewStore';
import { useProjectStore } from '../../stores/projectStore';
import { useTransportStore } from '../../stores/transportStore';
import { useUiStore } from '../../stores/uiStore';
import { localized } from '../../templates/catalog';
import { ExportRun, QUALITY_SUBFRAMES, type ExportOutcome, type ExportProgress, type QualityLevel } from './exportRunner';

export const EXPORT_TASK_STATUSES = ['preparing', 'rendering', 'muxing', 'done', 'failed', 'canceled'] as const;
export type ExportTaskStatus = (typeof EXPORT_TASK_STATUSES)[number];
const QUALITY_LEVELS = Object.keys(QUALITY_SUBFRAMES) as [QualityLevel, ...QualityLevel[]];

/** 启动参数：都可省略，省略的取当前工程的导出设置；输出位置不是参数（只来自主进程的文件夹对话框，1.6 第 6 条） */
export const ExportTaskStartInputSchema = z
  .strictObject({
    preset: ExportPresetSchema.optional(),
    quality: z.enum(QUALITY_LEVELS).optional(),
    shutterAngle: z.number().min(0).max(360).optional(),
    key: KeyColorSchema.optional(),
    /** 文件名（不含扩展名）；省略时按 5.2 的规则生成 */
    fileName: z.string().trim().min(1).max(120).optional(),
  })
  .optional();
export type ExportTaskStartInput = z.infer<typeof ExportTaskStartInputSchema>;

export const ExportTaskIdInputSchema = z.strictObject({ taskId: z.uuid() });

export const ExportTaskSnapshotSchema = z.strictObject({
  id: z.uuid(),
  status: z.enum(EXPORT_TASK_STATUSES),
  preset: ExportPresetSchema,
  /** 已写入的帧数 / 总帧数（准备阶段总帧数为 0） */
  written: z.int().min(0),
  total: z.int().min(0),
  /** 0–1 */
  progress: z.number().min(0).max(1),
  etaSeconds: z.number().min(0).nullable(),
  settings: z.strictObject({
    width: z.int(),
    height: z.int(),
    fps: z.int(),
    quality: z.enum(QUALITY_LEVELS),
    shutterAngle: z.number(),
    key: z.string(),
    fileName: z.string(),
  }),
  result: z
    .strictObject({
      jobId: z.uuid(),
      path: z.string(),
      frames: z.int(),
      fps: z.int(),
      duration: z.number(),
      cutFrame: z.int().nullable(),
      cutMinAlpha: z.int().min(0).max(255).nullable(),
      encoder: z.string().nullable(),
      seconds: z.number(),
      /** 有音轨（M6b，5.5） */
      audio: z.boolean(),
      /** 混音峰值超过 0 dBFS，整体压到了 −1 dBFS */
      peakNormalized: z.boolean(),
    })
    .nullable(),
  error: z.strictObject({ code: z.enum(EXPORT_ERROR_CODES), detail: z.string(), frame: z.int().nullable() }).nullable(),
});
export type ExportTaskSnapshot = z.infer<typeof ExportTaskSnapshotSchema>;

/** 结束了的任务最多留几个（查询用） */
const KEEP_FINISHED = 10;

interface ExportTaskState {
  tasks: Record<string, ExportTaskSnapshot>;
  /** 进行中的任务；没有时为 null */
  activeId: string | null;
}

export const useExportTasks = create<ExportTaskState>(() => ({ tasks: {}, activeId: null }));

const runs = new Map<string, { run: ExportRun; finished: Promise<void> }>();

function blockUnload(event: BeforeUnloadEvent): void {
  event.preventDefault();
  event.returnValue = false;
}

function patch(id: string, next: Partial<ExportTaskSnapshot>): void {
  const s = useExportTasks.getState();
  const cur = s.tasks[id];
  if (!cur) return;
  useExportTasks.setState({ tasks: { ...s.tasks, [id]: { ...cur, ...next } } });
}

function finishedOutcome(id: string, outcome: ExportOutcome): void {
  if (outcome.kind === 'done') {
    const { kind: _kind, ...result } = outcome;
    patch(id, { status: 'done', progress: 1, etaSeconds: 0, result });
  } else if (outcome.kind === 'failed') {
    patch(id, { status: 'failed', etaSeconds: null, error: { code: outcome.error.code, detail: outcome.error.detail, frame: outcome.frame } });
  } else {
    patch(id, { status: 'canceled', etaSeconds: null });
  }
  runs.delete(id);
  // 只留最近几个结束了的任务
  const s = useExportTasks.getState();
  const ids = Object.keys(s.tasks).filter((k) => k !== s.activeId && k !== id);
  const drop = ids.slice(0, Math.max(0, ids.length - (KEEP_FINISHED - 1)));
  const tasks = { ...s.tasks };
  for (const k of drop) delete tasks[k];
  useExportTasks.setState({ tasks, activeId: s.activeId === id ? null : s.activeId });
  window.removeEventListener('beforeunload', blockUnload);
  useUiStore.getState().setExporting(false);
}

/** 按 5.2 的规则生成的文件名（不含扩展名） */
export function defaultFileName(): string {
  const { template, output, name, composition } = useProjectStore.getState();
  const templateName = !composition && template ? localized(template.manifest.name, i18next.language) : 'timeline';
  return exportBaseName(name ?? i18next.t('project.untitled'), templateName, output.width, output.height, composition?.fps ?? output.fps);
}

export function exportTaskActive(): boolean {
  return useExportTasks.getState().activeId !== null;
}

/** 启动一个导出任务，立即返回编号；任务在后台跑，状态在 useExportTasks 里 */
export function startExportTask(input: ExportTaskStartInput): string {
  if (exportTaskActive()) throw new Error('an export is already running');
  const project = useProjectStore.getState();
  const { template, params, composition } = project;
  if (!template && !composition) throw new Error('no template');
  const output = { ...project.output, fps: composition?.fps ?? project.output.fps };
  const saved = project.exportSettings;
  const preset: ExportPreset = input?.preset ?? saved.preset;
  const quality = input?.quality ?? saved.quality;
  const shutterAngle = input?.shutterAngle ?? saved.shutterAngle;
  const key = (input?.key ?? saved.key).toUpperCase();
  const fileName = input?.fileName ?? defaultFileName();
  const id = crypto.randomUUID();
  const snapshot: ExportTaskSnapshot = {
    id,
    status: 'preparing',
    preset,
    written: 0,
    total: 0,
    progress: 0,
    etaSeconds: null,
    settings: { width: output.width, height: output.height, fps: output.fps, quality, shutterAngle, key, fileName },
    result: null,
    error: null,
  };
  const run = new ExportRun({ template, params, composition, output, preset, quality, shutterAngle, key, suggestedName: fileName }, (p: ExportProgress) =>
    patch(id, { status: p.stage, written: p.written, total: p.total, progress: p.total > 0 ? p.written / p.total : 0, etaSeconds: p.etaSeconds }),
  );
  window.addEventListener('beforeunload', blockUnload);
  useExportTasks.setState((s) => ({ tasks: { ...s.tasks, [id]: snapshot }, activeId: id }));
  useUiStore.getState().setExporting(true);
  // 导出是模态的：预览停下来
  useTransportStore.getState().setPlaying(false);
  const finished = run.run().then(
    (outcome) => finishedOutcome(id, outcome),
    (error: unknown) => finishedOutcome(id, { kind: 'failed', error: { code: 'template-failed', detail: String(error) }, frame: null }),
  );
  runs.set(id, { run, finished });
  return id;
}

export function getExportTask(id: string): ExportTaskSnapshot | null {
  return useExportTasks.getState().tasks[id] ?? null;
}

/** 取消：进行中的任务终止并清理；已经结束的任务不受影响。返回取消后的状态 */
export async function cancelExportTask(id: string): Promise<ExportTaskStatus | null> {
  const entry = runs.get(id);
  if (entry) {
    await entry.run.cancel();
    await entry.finished;
  }
  return getExportTask(id)?.status ?? null;
}

const ready = () => usePreviewStore.getState().status.kind === 'ready';

/** 导出任务的三个命令（不在命令面板里列出：它们要参数，面板里的“导出”打开对话框） */
export const EXPORT_TASK_COMMANDS: AnyCommand[] = [
  defineCommand({
    id: 'exportTask.start',
    titleKey: 'command.items.exportTaskStart',
    effect: 'read',
    hideInPalette: true,
    input: ExportTaskStartInputSchema,
    output: z.strictObject({ taskId: z.uuid() }),
    enabled: () => ready() && !exportTaskActive(),
    run: (input) => ({ taskId: startExportTask(input) }),
  }),
  defineCommand({
    id: 'exportTask.get',
    titleKey: 'command.items.exportTaskGet',
    effect: 'read',
    hideInPalette: true,
    input: ExportTaskIdInputSchema,
    output: ExportTaskSnapshotSchema.nullable(),
    run: ({ taskId }) => getExportTask(taskId),
  }),
  defineCommand({
    id: 'exportTask.cancel',
    titleKey: 'command.items.exportTaskCancel',
    effect: 'read',
    hideInPalette: true,
    input: ExportTaskIdInputSchema,
    output: z.strictObject({ status: z.enum(EXPORT_TASK_STATUSES).nullable() }),
    run: async ({ taskId }) => ({ status: await cancelExportTask(taskId) }),
  }),
];
