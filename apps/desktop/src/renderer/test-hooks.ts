// 只给自动化测试用的钩子（docs/decisions.md M1“测试钩子”）。只有主进程在未打包、且设置了 ALLAY_E2E_HOOKS 时
// 才在 app.info 里返回 testHooks: true，渲染进程据此装上 window.__allayTest。打包后的应用永远不会装。
// 钩子只调用界面自己也会走的路径（换模板、设时间、读预览），不碰任何安全设置。
import { TemplateManifestSchema, type AudioCue, type ParamValues, type TemplateDiagnostic } from '@allay/template-sdk';
import { previewAudio, soundBank } from './audio/app-audio';
import { mixFrames, mixOffline } from './audio/mix';
import { mascotFrameStats, resetMascotFrameStats, type MascotFrameStats } from '@allay/mascot';
import type { CopyBuiltinRequest, PresetEntry, TemplateDevChange, TemplateDevResult, TemplateEntry } from '../shared/templates';
import { applyPresetEntry, saveCurrentPreset } from './features/templates/presets';
import { installDroppedTemplate, removeTemplate, selectTemplate } from './features/templates/actions';
import { trialTimeouts } from './features/templates/trial';
import i18next from 'i18next';
import { setExportGate } from './features/export/exportRunner';
import { CommandError, dispatch } from './app/registry';
import { previewEngine } from './features/preview/previewEngine';
import { setDebugLoading } from './features/preview/debugLoading';
import { missingKeys } from './i18n';
import { thumbnails, type ThumbKind, type ThumbSize } from './features/thumbnails/thumbnails';
import type { ResourceState } from '../shared/resources';
import { useResourceStore } from './stores/resourceStore';
import { usePreviewStore, type PreviewStatus } from './stores/previewStore';
import { clearHistory, useProjectStore } from './stores/projectStore';
import { useTransportStore } from './stores/transportStore';
import { useTemplateStore } from './stores/templateStore';
import { DEFAULT_TEMPLATE_ID, type TemplateSource } from './templates/catalog';
import { optionalModules } from './app/core';
import { useCrashRequests } from './app/ErrorBoundary';
import { renderStillPng } from './engine-host/still';
import { useDevStore, type ReloadPhase, type ReloadRecord, type TemplateRef } from './stores/devStore';
import { undoInfo, type UndoOrigin } from './stores/projectStore';

export interface AllayTestHooks {
  /** 换成一段测试模板（不含 import 的 ESM 源码） */
  loadTemplate(code: string, params?: ParamValues): void;
  /** 换回内置的旗舰模板 T1（经 templates.read，与界面选模板同一条路） */
  loadBuiltin(): Promise<boolean>;
  /** 选一个已安装的模板 */
  selectTemplate(id: string, version: string, params?: ParamValues): Promise<boolean>;
  /** 改当前模板的一部分参数（经参数校验清洗） */
  setParams(patch: Record<string, unknown>): void;
  /** 当前模板与参数 */
  project(): { ref: { id: string; version: string } | null; params: ParamValues; hidden: string[]; paramDefaults: Record<string, unknown>; revision: number };
  templates(): Promise<TemplateEntry[]>;
  /** 安装一个模板包（File 来自真实的文件输入框）：与拖放同一条路，返回结果 */
  installFile(file: File): Promise<{ kind: string; code?: string; detail?: string; warnings?: string[]; loadWarnings?: string[]; entry?: TemplateEntry }>;
  removeTemplate(id: string, version: string): Promise<boolean>;
  /** 试运行的看门狗时限（毫秒） */
  setTrialTimeouts(t: { load?: number; exportFrame?: number }): void;
  savePreset(name: string): Promise<PresetEntry | null>;
  listPresets(): Promise<PresetEntry[]>;
  applyPreset(id: string): Promise<boolean>;
  status(): PreviewStatus;
  /** 预览已经装载了当前工程（模板和参数的最新一版）且处于就绪状态 */
  previewUpToDate(): boolean;
  workerGeneration(): number;
  transport(): { time: number; playing: boolean; duration: number; cutTime: number | null };
  setTime(t: number): void;
  /** 读回预览画布（预乘 alpha，顶部在前）的像素统计 */
  previewStats(t: number): Promise<{ width: number; height: number; maxAlpha: number; minAlpha: number }>;
  /** 预览画布上 (fx, fy)（0–1 的相对位置，左上为原点）的像素，预乘 alpha */
  previewPixel(t: number, fx: number, fy: number): Promise<[number, number, number, number]>;
  /** 渲染进程当前看到的资源栈状态 */
  resourceState(): ResourceState | null;
  /** 取一张缩略图（3.10）：来源（内存、磁盘缓存、新画的）和尺寸 */
  thumbnail(kind: ThumbKind, id: string, size: ThumbSize): Promise<{ source: string; width: number; height: number; stamp: string } | null>;
  /** 预览看门狗的时限（毫秒），测试可以调短 */
  setPreviewTimeouts(t: { load?: number; previewFrame?: number }): void;
  /** 下一次导出写完第 n 帧后停住（FFmpeg 仍在运行），直到 resumeExport 或取消；null 取消这个设置 */
  pauseExportAfter(n: number | null): void;
  /** 导出当前停在第几帧（已写入的帧数）；没有停住时为 null */
  exportPausedAt(): number | null;
  resumeExport(): void;
  /** 让预览视口的加载编排假装在加载（T-ALY-2、T-ALY-5） */
  simulateLoading(on: boolean): void;
  /** 预览画布在 t 时刻的像素哈希（T-UI-1：改参数后画面变了） */
  previewHash(t: number): Promise<string>;
  /** 撤销历史的长度（T-UI-2：一次拖动只算一步） */
  history(): { past: number; future: number };
  /** 界面用到但文案里没有的键（T-UI-4） */
  missingKeys(): string[];
  // ---- 模板开发模式（MD-a 只有主进程部分，这些钩子直接走 window.allay，界面接线在 MD-b）----
  /** 把内置模板复制成可编辑的用户模板 */
  copyBuiltinTemplate(req: CopyBuiltinRequest): Promise<TemplateDevResult<{ entry: TemplateEntry }>>;
  /** 往用户模板的文件夹写类型定义和 jsconfig.json */
  writeTemplateDevFiles(id: string, version: string): Promise<TemplateDevResult>;
  /** 装上钩子以来收到的 templates.onChanged 事件（最多 100 条），clear 为真时读完清空 */
  templateChanges(clear?: boolean): TemplateDevChange[];
  // ---- 音频（M6b）----
  /** 预览播放的调度状态：当前排了几个声音、最近一次试听、缺失的音效 */
  audioState(): ReturnType<typeof previewAudio.debug>;
  /** 当前装载结果里的 cue（含引擎选定的变体） */
  audioCues(): AudioCue[];
  /** 试听一个音效事件（与 SoundField 的按钮同一条路） */
  auditionSound(id: string): Promise<void>;
  /** 用当前的 cue 离线混音两次（与导出同一个函数），返回两次 WAV 的 SHA-256 和长度、是否压过峰值 */
  mixTwice(frames: number, fps: number): Promise<{ hashes: (string | null)[]; bytes: number | null; peakNormalized: boolean; missing: string[] }>;
  // ---- MD-b ----
  /** 热重载的状态：在监视谁、做到哪一步、完成了几次、上一次的结果与诊断 */
  devState(): { watching: TemplateRef | null; phase: ReloadPhase; last: ReloadRecord | null; reloads: number; diagnostics: TemplateDiagnostic[] };
  /**
   * 经界面的命令层（注册表的 dispatch）执行命令，和菜单、快捷键、命令面板同一条路（MD-b 与 M7 共用）。
   * 成功时 { ok: true, output }；失败时 { ok: false, name, code, message }，code 是 CommandError 的码（invalid-input、disabled 等）
   */
  dispatch(id: string, input?: unknown): Promise<{ ok: true; output: unknown } | { ok: false; name: string; code: string | null; message: string }>;
  /** 撤销、重做各自对应的那次改动（H6） */
  undoInfo(): { undo: UndoOrigin | null; redo: UndoOrigin | null };
  /** 经统一的静帧接口（H4）把当前模板、当前参数在 t 时刻渲染成 PNG（base64） */
  renderStill(t: number, maxEdge?: number): Promise<{ width: number; height: number; pngBase64: string }>;
  /** 清掉当前模板（“没选模板”的界面状态，冒烟测试用）：工程里没有模板，预览回到起始状态 */
  clearTemplate(): void;
  /**
   * 不经 schema 校验，把一份（可能不合法的）manifest 和代码当成当前模板交给预览：复现“已经落在磁盘上的坏模板”
   * 在引擎里装载失败时界面怎么提示。manifest 里的 params 照原样当参数定义用
   */
  loadUnchecked(manifest: unknown, code: string): void;
  /** 让某一块（错误边界的 scope，如 app、preview、right.props）在下一次渲染时抛错；空数组清掉 */
  crashPanels(scopes: string[]): void;
  /** 可选模块：这次构建发现的、启用中的 */
  optionalModules(): { available: string[]; active: string[]; failures: Record<string, string> };
  // ---- 悦灵（M5b）----
  /** 悦灵帧循环每帧耗时的统计（T-ALY-6）；reset 为真时读完清零 */
  mascotStats(reset?: boolean): MascotFrameStats;
}

declare global {
  interface Window {
    __allayTest?: AllayTestHooks;
  }
}

export function installTestHooks(): void {
  const templateChanges: TemplateDevChange[] = [];
  window.allay.templates.onChanged((change) => {
    if (templateChanges.length >= 100) templateChanges.shift();
    templateChanges.push(change);
  });
  let pausedAt: number | null = null;
  let release: () => void = () => undefined;
  const hooks: AllayTestHooks = {
    loadTemplate(code, params = {}) {
      const manifest = TemplateManifestSchema.parse({ formatVersion: 1, id: 'test.e2e.template', version: '0.0.0', name: 'test', category: 'transition', params: [] });
      useProjectStore.getState().setTemplate({ ref: { id: manifest.id, version: manifest.version }, manifest, params: [], hidden: [], code, assets: null }, params);
      previewEngine.retry();
    },
    async loadBuiltin() {
      const entries = await useTemplateStore.getState().refresh();
      const flagship = entries.filter((e) => e.id === DEFAULT_TEMPLATE_ID).at(-1);
      return flagship ? selectTemplate(flagship.id, flagship.version, i18next.language) : false;
    },
    selectTemplate: (id, version, params = {}) => selectTemplate(id, version, i18next.language, params),
    setParams: (patch) => useProjectStore.getState().setParams(patch, i18next.language),
    project() {
      const { template, params, revision } = useProjectStore.getState();
      return {
        ref: template?.ref ?? null,
        params,
        hidden: template?.hidden ?? [],
        paramDefaults: Object.fromEntries((template?.params ?? []).map((p) => [p.key, p.default])),
        revision,
      };
    },
    templates: () => useTemplateStore.getState().refresh(),
    async installFile(file) {
      const o = await installDroppedTemplate(i18next.t.bind(i18next), file, i18next.language);
      if (o.kind === 'installed') return { kind: o.kind, warnings: o.trial.warnings, loadWarnings: o.trial.loadWarnings, entry: o.entry };
      if (o.kind === 'rejected') return { kind: o.kind, code: o.code, detail: o.detail };
      return { kind: o.kind };
    },
    removeTemplate: (id, version) => removeTemplate(id, version, i18next.language),
    setTrialTimeouts(t) {
      Object.assign(trialTimeouts, t);
    },
    savePreset: (name) => saveCurrentPreset(name, i18next.language),
    listPresets: () => window.allay.presets.list(),
    async applyPreset(id) {
      const entry = (await window.allay.presets.list()).find((p) => p.id === id);
      return entry ? applyPresetEntry(entry, i18next.language) : false;
    },
    status: () => usePreviewStore.getState().status,
    previewUpToDate: () => {
      const { status, loaded } = usePreviewStore.getState();
      return status.kind === 'ready' && loaded?.revision === useProjectStore.getState().revision && loaded.locale === i18next.language;
    },
    workerGeneration: () => previewEngine.workerGeneration,
    transport: () => {
      const s = useTransportStore.getState();
      return { time: s.time, playing: s.playing, duration: s.duration, cutTime: s.cutTime };
    },
    setTime: (t) => useTransportStore.getState().setTime(t),
    async previewStats(t) {
      const px = await previewEngine.readPreview(t);
      let maxAlpha = 0;
      let minAlpha = 255;
      for (let i = 3; i < px.length; i += 4) {
        const a = px[i]!;
        if (a > maxAlpha) maxAlpha = a;
        if (a < minAlpha) minAlpha = a;
      }
      const size = previewEngine.pixelSize;
      return { width: size?.width ?? 0, height: size?.height ?? 0, maxAlpha, minAlpha };
    },
    async previewPixel(t, fx, fy) {
      const px = await previewEngine.readPreview(t);
      const size = previewEngine.pixelSize;
      if (!size) throw new Error('preview has no size');
      const x = Math.min(size.width - 1, Math.max(0, Math.floor(fx * size.width)));
      const y = Math.min(size.height - 1, Math.max(0, Math.floor(fy * size.height)));
      const o = (y * size.width + x) * 4;
      return [px[o]!, px[o + 1]!, px[o + 2]!, px[o + 3]!];
    },
    resourceState: () => useResourceStore.getState().state,
    async thumbnail(kind, id, size) {
      const stamp = useResourceStore.getState().state?.stamp ?? '';
      const thumb = await thumbnails.get(kind, id, size);
      if (!thumb) return null;
      const img = new Image();
      img.src = thumb.url;
      await img.decode();
      return { source: thumb.source, width: img.naturalWidth, height: img.naturalHeight, stamp };
    },
    setPreviewTimeouts(t) {
      previewEngine.timeouts = { ...previewEngine.timeouts, ...t };
    },
    audioState: () => previewAudio.debug(),
    audioCues: () => [...usePreviewStore.getState().audioCues],
    auditionSound: (id) => previewAudio.preview(id),
    async mixTwice(frames, fps) {
      const cues = usePreviewStore.getState().audioCues;
      const length = mixFrames(frames, fps);
      const a = await mixOffline(cues, length, soundBank);
      const b = await mixOffline(cues, length, soundBank);
      const hash = async (w: Uint8Array | null) => (w ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', w.slice().buffer))].map((x) => x.toString(16).padStart(2, '0')).join('') : null);
      return { hashes: [await hash(a.wav), await hash(b.wav)], bytes: a.wav?.byteLength ?? null, peakNormalized: a.peakNormalized, missing: a.missing };
    },
    pauseExportAfter(n) {
      pausedAt = null;
      setExportGate(
        n === null
          ? null
          : (written) => {
              if (written !== n) return Promise.resolve();
              pausedAt = written;
              return new Promise<void>((resolve) => {
                release = () => {
                  pausedAt = null;
                  resolve();
                };
              });
            },
      );
    },
    exportPausedAt: () => pausedAt,
    resumeExport() {
      release();
    },
    simulateLoading(on) {
      setDebugLoading(on);
    },
    async previewHash(t) {
      const px = await previewEngine.readPreview(t);
      let h = 0x811c9dc5;
      for (let i = 0; i < px.length; i++) h = Math.imul(h ^ px[i]!, 0x01000193);
      return (h >>> 0).toString(16);
    },
    history() {
      const s = useProjectStore.temporal.getState();
      return { past: s.pastStates.length, future: s.futureStates.length };
    },
    missingKeys: () => [...missingKeys],
    clearTemplate() {
      useProjectStore.setState({ template: null, params: {} });
      clearHistory();
      usePreviewStore.getState().setStatus({ kind: 'starting' });
    },
    loadUnchecked(manifest, code) {
      const m = manifest as TemplateSource['manifest'];
      useProjectStore.getState().setTemplate({ ref: { id: m.id, version: m.version }, manifest: m, params: m.params ?? [], hidden: [], code, assets: null }, {}, i18next.language);
      previewEngine.retry();
    },
    crashPanels(scopes) {
      useCrashRequests.setState({ scopes: [...scopes] });
    },
    copyBuiltinTemplate: (req) => window.allay.templates.copyBuiltin(req),
    writeTemplateDevFiles: (id, version) => window.allay.templates.writeDevFiles(id, version),
    devState() {
      const s = useDevStore.getState();
      return { watching: s.watching, phase: s.phase, last: s.last, reloads: s.reloads, diagnostics: [...s.diagnostics] };
    },
    async dispatch(id, input) {
      try {
        return { ok: true, output: await dispatch(id, input) };
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        const code = err instanceof CommandError ? err.code : 'code' in err && typeof err.code === 'string' ? err.code : null;
        return { ok: false, name: err.name, code, message: err.message };
      }
    },
    undoInfo: () => undoInfo(),
    async renderStill(t, maxEdge) {
      const { template, params, output } = useProjectStore.getState();
      if (!template) throw new Error('no template');
      const r = await renderStillPng({ source: template, params, width: output.width, height: output.height, fps: output.fps, maxEdge, locale: i18next.language, t });
      let bin = '';
      for (let i = 0; i < r.png.length; i += 0x8000) bin += String.fromCharCode(...r.png.subarray(i, i + 0x8000));
      return { width: r.width, height: r.height, pngBase64: btoa(bin) };
    },
    optionalModules: () => ({ available: optionalModules.available, active: optionalModules.activeIds, failures: Object.fromEntries(optionalModules.failures) }),
    templateChanges(clear = false) {
      const out = [...templateChanges];
      if (clear) templateChanges.length = 0;
      return out;
    },
    mascotStats(reset = false) {
      const s = mascotFrameStats();
      if (reset) resetMascotFrameStats();
      return s;
    },
  };
  Object.defineProperty(window, '__allayTest', { value: Object.freeze(hooks), configurable: false, writable: false });
}
