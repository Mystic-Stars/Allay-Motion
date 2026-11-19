// 工程的新建、打开、保存、另存为（docs/01-product-architecture.md 1.9）。路径只在主进程：这里只有句柄。
import { CompositionFpsSchema, diffFromDefaults, studioMaterialManifest, type Composition } from '@allay/template-sdk';
import i18next from 'i18next';
import type { ProjectData, ProjectOpenResult } from '../../../shared/project';
import { notify } from '../../stores/noticeStore';
import { clearHistory, isDirty, useProjectStore } from '../../stores/projectStore';
import { useResourceStore } from '../../stores/resourceStore';
import { useTemplateStore } from '../../stores/templateStore';
import { useTransportStore } from '../../stores/transportStore';
import { useUiStore } from '../../stores/uiStore';
import { DEFAULT_TEMPLATE_ID, readTemplate } from '../../templates/catalog';
import { previewEngine } from '../preview/previewEngine';
import { askConfirm } from './confirm';

const t = (key: string, vars?: Record<string, unknown>) => i18next.t(key, vars ?? {});

/** 保存时启用了哪些层（只是记一笔，1.9） */
function resourceHint(): string[] {
  const st = useResourceStore.getState().state;
  if (!st) return [];
  return st.layers.filter((l) => l.enabled && !(l.kind === 'builtin' && l.empty)).map((l) => (l.kind === 'vanilla' ? 'vanilla' : l.kind === 'pack' ? `pack:${l.name}` : 'builtin'));
}

export function projectData(): ProjectData | null {
  const s = useProjectStore.getState();
  const fps = s.composition?.fps ?? CompositionFpsSchema.parse(s.output.fps);
  const common = {
    name: s.name ?? t('project.untitled'),
    output: { width: s.output.width, height: s.output.height, fps },
    export: s.exportSettings,
    preview: { background: useUiStore.getState().settings.editor.background },
    resourceHint: resourceHint(),
  };
  if (s.composition) return { ...common, composition: s.composition };
  if (!s.template) return null;
  return { ...common, template: s.template.ref, params: diffFromDefaults(s.template.params, s.params, { locale: i18next.language }) };
}

/** 有未保存的改动时先问一句；返回 false 表示用户取消 */
async function confirmDiscard(): Promise<boolean> {
  if (!isDirty(useProjectStore.getState())) return true;
  return askConfirm({ title: t('project.unsaved.title'), body: t('project.unsaved.body'), confirm: t('project.unsaved.discard') });
}

export async function newProject(): Promise<boolean> {
  if (!(await confirmDiscard())) return false;
  const entries = await useTemplateStore.getState().refresh();
  const flagship = entries.filter((e) => e.id === DEFAULT_TEMPLATE_ID).at(-1) ?? entries.find((e) => !e.baseMissing);
  if (!flagship) return false;
  const template = await readTemplate(flagship.id, flagship.version);
  if (!template) return false;
  useProjectStore.getState().reset({ template, name: null, handle: null, locale: i18next.language });
  clearHistory();
  previewEngine.retry();
  return true;
}

export async function newComposition(fromQuick = false): Promise<boolean> {
  if (!(await confirmDiscard())) return false;
  const { template, params, output, exportSettings, composition: current } = useProjectStore.getState();
  const transport = useTransportStore.getState();
  const fps = CompositionFpsSchema.parse(output.fps);
  const initial = fromQuick && !current && template ? {
    id: crypto.randomUUID(), startFrame: 0, sourceInFrame: 0,
    durationFrames: Math.max(1, Math.round((transport.duration || 1) * fps)), template: template.ref, params: structuredClone(params),
  } : null;
  const composition: Composition = {
    formatVersion: 1, fps, durationFrames: Math.max(fps * 5, initial?.durationFrames ?? 0),
    tracks: initial ? [{ id: crypto.randomUUID(), name: t('gallery.title'), locked: false, muted: false, clips: [initial] }] : [],
  };
  const fileNames = useProjectStore.getState().fileNames;
  useProjectStore.getState().reset({ template: null, composition, output, exportSettings, name: null, handle: null });
  if (initial) useProjectStore.setState({ fileNames });
  clearHistory();
  transport.setPlaying(false);
  transport.setTime(0);
  previewEngine.retry();
  return true;
}

async function applyOpened(result: ProjectOpenResult): Promise<boolean> {
  if (result.canceled) return false;
  if (!result.ok) {
    notify('error', t(`project.errors.${result.error}`));
    return false;
  }
  const { data } = result;
  const entries = await useTemplateStore.getState().refresh();
  let source: Parameters<ReturnType<typeof useProjectStore.getState>['reset']>[0];
  if ('composition' in data) {
    const installed = new Set(entries.filter((entry) => !entry.baseMissing).map(({ id, version }) => `${id}@${version}`));
    const missing = new Map(data.composition.tracks.flatMap((track) => track.clips.flatMap(({ template }) => {
      const key = `${template.id}@${template.version}`;
      return installed.has(key) || studioMaterialManifest(template) ? [] : [[key, template] as const];
    })));
    const first = missing.values().next().value;
    if (first) notify('error', t('project.errors.templateMissing', first));
    source = { template: null, composition: data.composition, name: result.name, handle: result.handle };
  } else {
    const template = await readTemplate(data.template.id, data.template.version);
    if (!template) {
      notify('error', t('project.errors.templateMissing', data.template));
      return false;
    }
    source = { template, params: data.params, name: result.name, handle: result.handle };
  }
  useProjectStore.getState().reset({
    ...source,
    output: data.output,
    exportSettings: data.export,
    locale: i18next.language,
  });
  clearHistory();
  const transport = useTransportStore.getState();
  transport.setPlaying(false);
  transport.setTime(0);
  useUiStore.getState().setEditor({ background: data.preview.background });
  previewEngine.retry();
  if (result.missingFiles.length > 0) {
    if ('composition' in data) notify('info', i18next.language.startsWith('zh') ? '有片段的图片待重链；请选择片段后重新选择图片。' : 'Some clips need image relinking. Select a clip to choose the image again.');
    else notify('error', t('project.missingFiles', { keys: result.missingFiles.join(', ') }));
  }
  else {
    const now = resourceHint();
    const same = now.length === data.resourceHint.length && now.every((h, i) => h === data.resourceHint[i]);
    if (!same && data.resourceHint.length > 0) notify('info', t('project.resourceHint'));
  }
  return true;
}

export async function openProject(): Promise<boolean> {
  if (!(await confirmDiscard())) return false;
  return applyOpened(await window.allay.project.open());
}

/** 双击关联的 .allay（M8）：主进程经命令通道发来一次性令牌，路径不经过界面 */
export async function openAssociatedProject(token: string): Promise<boolean> {
  if (!(await confirmDiscard())) return false;
  return applyOpened(await window.allay.project.openRequested(token));
}

export async function openRecent(id: string): Promise<boolean> {
  if (!(await confirmDiscard())) return false;
  return applyOpened(await window.allay.project.openRecent(id));
}

export async function saveProject(as = false): Promise<boolean> {
  const data = projectData();
  if (!data) return false;
  const { handle, revision, savedRevision } = useProjectStore.getState();
  const r = as ? await window.allay.project.saveAs(data) : await window.allay.project.save(handle, data);
  if (r.canceled) return false;
  if (!r.ok) {
    notify('error', t(`project.errors.${r.error}`));
    return false;
  }
  const current = useProjectStore.getState();
  if (current.handle === handle && current.savedRevision === savedRevision) current.markSaved(r.name, r.handle, revision);
  notify('info', t('project.saved', { name: r.name }));
  return true;
}
