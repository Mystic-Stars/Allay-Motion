import { CompositionSchema, sanitizeParams, sameValue, type Composition, type OutputSettings, type ParamValue, type ParamValues } from '@allay/template-sdk';
import { temporal } from 'zundo';
import { create } from 'zustand';
import type { ExportPreset } from '../../shared/export';
import type { TemplateSource } from '../templates/catalog';

// projectStore（1.7）：当前模板、参数、输出设置、工程名、是否有未保存改动。
// 撤销用 zundo，只记录模板和参数。一次连续操作（拖滑块、拖数字、拖时间轴上的分界线）只算一步：
// 指针按下时暂停记录（先记下按下前的状态），松开时恢复记录并补一条。
// 参数始终是完整的一组：换模板、改参数时都经 template-sdk 的校验函数清洗（4.4），text 的多语言默认值按界面语言取一次。

/**
 * 撤销记录的来源（docs/code-editing-and-mcp-plan.md H6）：哪一次改动产生了这个状态。
 * labelKey 是文案键（命令的 undoLabelKey 或 titleKey，界面上直接改参数时是 history.*）；
 * source 是谁改的：界面、命令（含快捷键、命令面板）、主进程经命令通道（H11）、可选模块（module:<id>）。
 */
export interface UndoOrigin {
  labelKey: string;
  source: 'ui' | 'command' | 'main' | `module:${string}`;
}

export const UI_ORIGIN: UndoOrigin = { labelKey: 'history.params', source: 'ui' };

/** 当前这次改动的来源（dispatch 执行 write 命令期间设置；没有设置时是界面上的直接修改） */
let ambientOrigin: UndoOrigin | null = null;

/** 在 fn 同步执行期间产生的改动都记成 origin（只覆盖同步部分：异步命令在 await 之后的改动按界面修改记） */
export function withOrigin<T>(origin: UndoOrigin, fn: () => T): T {
  const prev = ambientOrigin;
  ambientOrigin = origin;
  try {
    return fn();
  } finally {
    ambientOrigin = prev;
  }
}

function originFor(fallbackKey: string): UndoOrigin {
  return ambientOrigin ?? { ...UI_ORIGIN, labelKey: fallbackKey };
}

export type QualityLevel = 'draft' | 'standard' | 'high' | 'ultra';

export interface ExportSettings {
  preset: ExportPreset;
  quality: QualityLevel;
  /** 快门角 0–360（5.2） */
  shutterAngle: number;
  /** 绿幕 MP4 的底色 #RRGGBB */
  key: string;
}

interface ProjectState {
  /** 启动时模板列表还没取到，或者没有可用的模板 */
  template: TemplateSource | null;
  composition: Composition | null;
  params: ParamValues;
  output: OutputSettings;
  exportSettings: ExportSettings;
  /** 工程名；null 是“未命名工程” */
  name: string | null;
  /** 主进程签发的工程句柄（打开或保存过）；null 表示还没有对应的文件 */
  handle: string | null;
  /** 模板、参数或输出每变一次加一，预览据此重新装载或改参数 */
  revision: number;
  /** 模板或输出每变一次加一：这时预览要重新装载，只改参数时走 setParams */
  structureRevision: number;
  /** 上次保存（或打开、新建）时的 revision */
  savedRevision: number;
  /** file: 引用对应的文件名（只用于显示） */
  fileNames: Record<string, string>;
  /** 产生当前状态的那次改动（撤销时显示“撤销什么”，H6） */
  origin: UndoOrigin;
  setTemplate(template: TemplateSource, params?: Readonly<Record<string, unknown>>, locale?: string): void;
  setComposition(doc: Composition | null): void;
  /** 改一部分参数（多余的键丢弃，越界的钳制） */
  setParams(patch: Readonly<Record<string, unknown>>, locale?: string): void;
  setOutput(output: OutputSettings): void;
  setExportSettings(patch: Partial<ExportSettings>): void;
  setFileName(ref: string, name: string): void;
  /** 新建或打开工程：重置名字、句柄，清空撤销历史 */
  reset(next: { template: TemplateSource | null; composition?: Composition; params?: Readonly<Record<string, unknown>>; output?: OutputSettings; exportSettings?: ExportSettings; name: string | null; handle: string | null; locale?: string }): void;
  markSaved(name: string, handle: string, revision?: number): void;
}

export const DEFAULT_OUTPUT: OutputSettings = { width: 1920, height: 1080, fps: 60 };
export const DEFAULT_EXPORT: ExportSettings = { preset: 'prores4444', quality: 'standard', shutterAngle: 180, key: '#00FF00' };

type Tracked = Pick<ProjectState, 'template' | 'params' | 'composition' | 'origin'>;

function tracked(state: ProjectState): Tracked {
  const { template, params, composition, origin } = state;
  return { template, params, composition, origin };
}

function sameTracked(a: Tracked, b: Tracked): boolean {
  return a.template === b.template && a.params === b.params && a.composition === b.composition;
}

export const useProjectStore = create<ProjectState>()(
  temporal(
    (set) => ({
      template: null,
      composition: null,
      params: {},
      output: DEFAULT_OUTPUT,
      exportSettings: DEFAULT_EXPORT,
      name: null,
      handle: null,
      revision: 0,
      structureRevision: 0,
      savedRevision: 0,
      fileNames: {},
      origin: UI_ORIGIN,
      setTemplate: (template, params = {}, locale = 'en') =>
        set((s) => s.composition ? s : ({
          template,
          params: sanitizeParams(template.params, params, { locale }),
          revision: s.revision + 1,
          structureRevision: s.structureRevision + 1,
          origin: originFor('history.template'),
        })),
      setComposition: (doc) => set((s) => {
        if (doc === s.composition) return s;
        if (doc) CompositionSchema.parse(doc);
        return {
          composition: doc,
          output: doc && doc.fps !== s.output.fps ? { ...s.output, fps: doc.fps } : s.output,
          revision: s.revision + 1,
          structureRevision: s.structureRevision + 1,
          origin: originFor('history.params'),
        };
      }),
      setParams: (patch, locale = 'en') =>
        set((s) => {
          if (!s.template || s.composition) return s;
          const params = sanitizeParams(s.template.params, { ...s.params, ...patch }, { locale });
          // 值没变就不产生新状态（不记撤销、不重画）
          if (Object.keys(params).every((k) => sameValue(params[k], s.params[k]))) return {};
          return { params, revision: s.revision + 1, origin: originFor('history.params') };
        }),
      setOutput: (output) => set((s) => ({ output: s.composition ? { ...output, fps: s.composition.fps } : output, revision: s.revision + 1, structureRevision: s.structureRevision + 1 })),
      setExportSettings: (patch) => set((s) => ({ exportSettings: { ...s.exportSettings, ...patch } })),
      setFileName: (ref, name) => set((s) => ({ fileNames: { ...s.fileNames, [ref]: name } })),
      reset: ({ template, composition, params = {}, output = DEFAULT_OUTPUT, exportSettings = DEFAULT_EXPORT, name, handle, locale = 'en' }) =>
        set((s) => {
          const revision = s.revision + 1;
          return {
            template,
            composition: composition ? CompositionSchema.parse(composition) : null,
            params: template ? sanitizeParams(template.params, params, { locale }) : {},
            output: composition ? { ...output, fps: composition.fps } : output,
            exportSettings,
            name,
            handle,
            revision,
            structureRevision: s.structureRevision + 1,
            savedRevision: revision,
            fileNames: {},
            origin: UI_ORIGIN,
          };
        }),
      markSaved: (name, handle, revision) => set((s) => ({ name, handle, savedRevision: revision ?? s.revision })),
    }),
    {
      partialize: tracked,
      equality: sameTracked,
      limit: 200,
    },
  ),
);

export function isDirty(s: Pick<ProjectState, 'revision' | 'savedRevision'>): boolean {
  return s.revision !== s.savedRevision;
}

// ---- 撤销重做（只记录模板和参数）----

let gestureDepth = 0;
let gestureBefore: Tracked | null = null;

/** 一次连续操作开始：按下前的状态记下来，期间的改动不进历史 */
export function beginGesture(): void {
  if (gestureDepth++ > 0) return;
  const s = useProjectStore.getState();
  gestureBefore = tracked(s);
  useProjectStore.temporal.getState().pause();
}

/** 一次连续操作结束：有变化就补一条撤销记录（按下前的状态） */
export function endGesture(): void {
  if (gestureDepth === 0 || --gestureDepth > 0) return;
  const t = useProjectStore.temporal;
  t.getState().resume();
  const before = gestureBefore;
  gestureBefore = null;
  const s = useProjectStore.getState();
  if (!before || sameTracked(before, s)) return;
  t.setState((ts) => ({ pastStates: [...ts.pastStates, before].slice(-200), futureStates: [] }));
}

function afterHistoryJump(prev: Tracked): void {
  useProjectStore.setState((s) => ({
    output: s.composition && s.composition.fps !== s.output.fps ? { ...s.output, fps: s.composition.fps } : s.output,
    revision: s.revision + 1,
    structureRevision: s.template !== prev.template || s.composition !== prev.composition ? s.structureRevision + 1 : s.structureRevision,
  }));
}

export function undo(): void {
  const t = useProjectStore.temporal.getState();
  if (gestureDepth > 0 || t.pastStates.length === 0) return;
  const prev = useProjectStore.getState();
  t.undo();
  afterHistoryJump(prev);
}

export function redo(): void {
  const t = useProjectStore.temporal.getState();
  if (gestureDepth > 0 || t.futureStates.length === 0) return;
  const prev = useProjectStore.getState();
  t.redo();
  afterHistoryJump(prev);
}

export function clearHistory(): void {
  gestureDepth = 0;
  gestureBefore = null;
  useProjectStore.temporal.getState().resume();
  useProjectStore.temporal.getState().clear();
}

/** 单个参数（给属性面板用） */
export function setParam(key: string, value: ParamValue, locale: string): void {
  useProjectStore.getState().setParams({ [key]: value }, locale);
}

/** 撤销、重做各自会撤回或重做哪一次改动（H6）；没有可撤销的时为 null */
export function undoInfo(): { undo: UndoOrigin | null; redo: UndoOrigin | null } {
  const t = useProjectStore.temporal.getState();
  return {
    undo: t.pastStates.length > 0 ? useProjectStore.getState().origin : null,
    // zundo 的重做从 futureStates 的末尾取
    redo: t.futureStates.at(-1)?.origin ?? null,
  };
}

// ---- 工程修订号（docs/code-editing-and-mcp-plan.md H3）----

/** 工程状态的修订号：模板、参数或输出每变一次加一（就是 revision）。写命令可以带上读到的修订号做并发保护 */
export function projectRevision(): number {
  return useProjectStore.getState().revision;
}

export class RevisionConflictError extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`project revision is ${actual}, expected ${expected}`);
    this.name = 'RevisionConflictError';
  }
}

/** baseRevision 不是当前修订号时抛 RevisionConflictError，不改任何东西；是的话执行 fn */
export function ifRevision<T>(baseRevision: number | undefined, fn: () => T): T {
  const actual = projectRevision();
  if (baseRevision !== undefined && baseRevision !== actual) throw new RevisionConflictError(baseRevision, actual);
  return fn();
}

// ---- 模板开发模式的热重载（H9）----

/**
 * 同一个模板（id 和版本相同）的代码或 manifest 在磁盘上被改了，预览已经切到新代码：换掉工程里的模板，参数用 params。
 * 不进撤销历史（这不是用户在应用里的改动）；历史里引用旧模板的状态也换成新模板（参数用 remap 重新对上），
 * 免得撤销把已经不在磁盘上的旧代码带回来。
 */
export function hotSwapTemplate(next: TemplateSource, params: ParamValues, remap: (old: TemplateSource, values: ParamValues) => ParamValues): void {
  const same = (t: TemplateSource | null) => !!t && t.ref.id === next.ref.id && t.ref.version === next.ref.version;
  const temporalApi = useProjectStore.temporal;
  const tracking = temporalApi.getState().isTracking;
  if (tracking) temporalApi.getState().pause();
  try {
    useProjectStore.setState((s) => ({ template: next, params, revision: s.revision + 1, structureRevision: s.structureRevision + 1 }));
  } finally {
    if (tracking) temporalApi.getState().resume();
  }
  const fix = <S extends Partial<Tracked>>(st: S): S => (st.template && same(st.template) && st.params ? { ...st, template: next, params: remap(st.template, st.params) } : st);
  temporalApi.setState((ts) => ({ pastStates: ts.pastStates.map(fix), futureStates: ts.futureStates.map(fix) }));
  if (gestureBefore && same(gestureBefore.template)) gestureBefore = fix(gestureBefore);
}
