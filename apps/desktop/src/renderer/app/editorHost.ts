// 宿主接口 EditorHost 的实现（docs/code-editing-and-mcp-plan.md 3.3；类型在 @allay/host-api）。
import { BLOCKS } from '@allay/assets';
import { parseManifest } from '@allay/template-sdk';
import i18next from 'i18next';
import type { Disposable, EditorHost, ReloadResult, SdkApiDoc, TemplateDocuments, TemplateId, WriteResult } from '@allay/host-api';
import { analyzeTemplateCode } from '../../shared/template-code';
import { WriteSourceSchema } from '../../shared/template-authoring';
import { diagnosticFrom, hotReloader } from '../features/preview/hotReload';
import { previewEngine } from '../features/preview/previewEngine';
import { remapParams } from '../features/templates/remapParams';
import { sameRef, useDevStore } from '../stores/devStore';
import { hotSwapTemplate, useProjectStore } from '../stores/projectStore';
import { useTransportStore } from '../stores/transportStore';
import type { TemplateSource } from '../templates/catalog';
import { createHostUi, type HostUi } from './hostUi';

function candidate(id: TemplateId, files: TemplateDocuments) {
  const { template, composition } = useProjectStore.getState();
  if (!template || composition || !sameRef(template.ref, id)) throw new Error('only the current script template can be reloaded');
  return sourceCandidate(template, files);
}

function sourceCandidate(current: TemplateSource, files: TemplateDocuments): TemplateSource {
  const parsed = parseManifest(JSON.parse(files.manifest.replace(/^\uFEFF/, '')));
  if (!parsed.ok) throw new Error(parsed.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '));
  const manifest = parsed.manifest;
  if (manifest.extends || !sameRef(manifest, current.ref)) throw new Error('manifest identity and script kind cannot change');
  return { ...current, code: files.source.replace(/^\uFEFF/, ''), manifest, params: manifest.params ?? [], hidden: [] };
}

type SourceTrial = { ok: true; commit(): void; discard(): void } | { ok: false; error: unknown };
let savingSource = false;

/** 两个入口共用一个在途保存；不排队重放可能已过期的稿件。磁盘仍由主进程核对版本。 */
export async function saveTemplateSource(
  current: TemplateSource, files: TemplateDocuments, baseVersion: string,
  isCurrent: () => boolean, validate: (source: TemplateSource) => Promise<SourceTrial>,
): Promise<WriteResult> {
  if (savingSource || !isCurrent()) return { ok: false, error: 'io' };
  savingSource = true;
  try {
    const id = current.ref;
    const request = WriteSourceSchema.safeParse({ ...files, baseVersion });
    if (!request.success) return { ok: false, error: 'io' };
    const disk = await window.allay.templates.readSource(id);
    if (!disk.ok) return disk;
    if (disk.version !== baseVersion) return { ok: false, error: 'conflict', currentVersion: disk.version };
    if (!isCurrent()) return { ok: false, error: 'io' };
    let source: TemplateSource;
    try {
      source = sourceCandidate(current, files);
    } catch (error) {
      return { ok: false, error: 'invalid', diagnostics: [{ kind: 'compile', severity: 'error', code: 'manifest-invalid', message: String(error).slice(0, 2000) }] };
    }
    const diagnostics = await analyzeTemplateCode(source.code);
    if (diagnostics.length) return { ok: false, error: 'invalid', diagnostics };
    if (!isCurrent()) return { ok: false, error: 'io' };
    const trial = await validate(source);
    if (!trial.ok) return { ok: false, error: 'invalid', diagnostics: [diagnosticFrom(trial.error)] };
    let promoted = false;
    try {
      if (!isCurrent()) return { ok: false, error: 'io' };
      const result = await window.allay.templates.writeSource(id, request.data);
      if (result.ok) {
        trial.commit();
        promoted = true;
      }
      return result;
    } finally {
      if (!promoted) trial.discard();
    }
  } catch (error) {
    return { ok: false, error: 'invalid', diagnostics: [diagnosticFrom(error)] };
  } finally {
    savingSource = false;
  }
}

/** 先在备用 Worker 试当前帧，磁盘保存成功后才交换。冲突和试运行失败都不动预览。 */
export async function saveCurrentSource(
  id: TemplateId, files: TemplateDocuments, baseVersion: string, stillSelected: () => boolean = () => true,
): Promise<WriteResult> {
  const initial = useProjectStore.getState();
  const current = initial.template;
  if (initial.composition || !current || !sameRef(current.ref, id)) return { ok: false, error: 'io' };
  const sameProject = () => {
    const state = useProjectStore.getState();
    return !state.composition && state.template === current && state.handle === initial.handle && state.output === initial.output;
  };
  return saveTemplateSource(current, files, baseVersion, () => stillSelected() && sameProject(), async (source) => {
    const locale = i18next.language;
    const params = remapParams(current.params, source.params, useProjectStore.getState().params, locale);
    const trial = await previewEngine.trySwap(source, params);
    if (!trial.ok) return trial;
    return {
      ok: true,
      discard: trial.discard,
      commit: () => {
        if (!sameProject()) { trial.discard(); return; }
        const latest = useProjectStore.getState();
        trial.commit(() => hotSwapTemplate(source, remapParams(current.params, source.params, latest.params, locale),
          (old, values) => remapParams(old.params, source.params, values, locale)));
        useDevStore.setState((state) => ({ phase: 'idle', diagnostics: [], last: { ok: true, at: Date.now() }, reloads: state.reloads + 1 }));
      },
    };
  });
}

export interface ModuleHost extends EditorHost {
  /** 注销这个模块经宿主注册过的一切（面板、命令、文案、订阅） */
  disposeAll(): void;
}

let sdkApiDoc: Promise<SdkApiDoc> | null = null;

/** pnpm templates:api 生成的接口说明。只在有模块启用时才加载（单独的代码块） */
export function loadSdkApi(): Promise<SdkApiDoc> {
  sdkApiDoc ??= import('../../../../../packages/template-sdk/generated/template-api.json').then((m) => (m as { default: SdkApiDoc }).default);
  return sdkApiDoc;
}

/** 模块要注册文案：等界面的 i18next 初始化完 */
function i18nReady(): Promise<void> {
  if (i18next.isInitialized) return Promise.resolve();
  return new Promise((resolve) => i18next.on('initialized', () => resolve()));
}

export async function createEditorHost(moduleId: string, ui: HostUi = createHostUi(moduleId)): Promise<ModuleHost> {
  const [sdkApi] = await Promise.all([loadSdkApi(), i18nReady()]);
  const subs = new Set<() => void>();
  const sub = (undo: () => void): Disposable => {
    let done = false;
    const dispose = () => {
      if (done) return;
      done = true;
      subs.delete(dispose);
      undo();
    };
    subs.add(dispose);
    return { dispose };
  };
  const blockIds = Object.freeze(Object.keys(BLOCKS));
  return {
    templates: {
      read: (id) => window.allay.templates.readSource(id),
      write: (id, files, baseVersion) => saveCurrentSource(id, files, baseVersion),
      onExternalChange: (id: TemplateId, cb) => sub(hotReloader.onExternalChange((change) => sameRef(change, id) && change.hash !== null && cb(change.hash))),
    },
    engine: {
      onDiagnostics: (id, cb) => sub(hotReloader.onDiagnostics((ref, d) => sameRef(ref, id) && cb([...d]))),
      requestReload: async (id, files): Promise<ReloadResult> => {
        try {
          if (!(await window.allay.templates.readSource(id)).ok) throw new Error('copy the template before editing its source');
          return await hotReloader.reloadWithSource(candidate(id, files));
        } catch (error) {
          return { ok: false, diagnostics: [diagnosticFrom(error)] };
        }
      },
    },
    playhead: {
      get: () => useTransportStore.getState().time,
      subscribe: (cb) => sub(useTransportStore.subscribe((s, prev) => s.time !== prev.time && cb(s.time))),
    },
    domain: {
      blockIds: () => blockIds,
      easings: () => sdkApi.easings,
      sdkApi: () => sdkApi,
    },
    ui: {
      registerPanel: (p) => ui.registerPanel(p),
      registerCommand: (c) => ui.registerCommand(c),
      registerMessages: (locale, m) => ui.registerMessages(locale, m),
    },
    disposeAll() {
      for (const d of [...subs]) d();
      ui.disposeAll();
    },
  };
}
