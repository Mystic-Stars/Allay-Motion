import { sanitizeParams, type Composition } from '@allay/template-sdk';
import i18next from 'i18next';
import type { WriteResult } from '@allay/host-api';
import type { TemplateSourceFiles } from '../../../../shared/template-authoring';
import { saveCurrentSource, saveTemplateSource } from '../../../app/editorHost';
import { EngineHost } from '../../../engine-host/EngineHost';
import { compositionResourceStamp, prepareComposition } from '../../../engine-host/composition-sources';
import { createResolver, loadStamp } from '../../../engine-host/resource-client';
import { sameRef } from '../../../stores/devStore';
import { useProjectStore } from '../../../stores/projectStore';
import { useTransportStore } from '../../../stores/transportStore';
import { readTemplate, type TemplateSource } from '../../../templates/catalog';
import { askConfirm } from '../../project/confirm';
import { previewEngine } from '../../preview/previewEngine';
import { clipEdit } from '../../studio/edits';
import { codeTarget, type Project, type Target } from './selection';

async function trialComposition(doc: Composition, project: Project, target: Target, source: TemplateSource): Promise<void> {
  const stamp = compositionResourceStamp(doc);
  const locale = i18next.language;
  const prepared = await prepareComposition(doc, project.output, locale, stamp);
  const clip = target.clip;
  if (!clip) throw new Error('missing composition clip');
  const profile = clip.profile ?? doc.defaultProfile;
  const resolver = createResolver(source.assets, profile);
  const host = await EngineHost.create({ mode: 'preview', canvas: document.createElement('canvas'), resolveResource: resolver, strictDeterminism: true });
  try {
    await host.resize(320, 180);
    const time = useTransportStore.getState().time;
    const selectedVisible = !target.track?.muted && clip.startFrame < doc.durationFrames;
    if (prepared.request.sources.some((entry) => sameRef(entry.template, source.ref))) {
      const sources = prepared.request.sources.map((entry) => sameRef(entry.template, source.ref)
        ? { ...entry, manifest: source.manifest, code: source.code } : entry);
      await host.loadComposition({ ...prepared.request, sources }, prepared.resources);
      await host.render(Math.min(time, (doc.durationFrames - 1) / doc.fps));
      if (selectedVisible && (time * doc.fps < clip.startFrame || time * doc.fps >= clip.startFrame + clip.durationFrames)) {
        await host.render(clip.startFrame / doc.fps);
      }
    }
    if (!selectedVisible) {
      const result = await host.load({ manifest: source.manifest, code: source.code,
        params: sanitizeParams(source.params, clip.params, { locale }), output: project.output, resourceStamp: loadStamp(source.assets, profile) });
      await host.render(Math.min(result.duration, clip.sourceInFrame / doc.fps));
    }
    prepared.assertCurrent();
  } finally {
    host.dispose();
  }
}

export async function saveSource(source: TemplateSource, target: Target, files: TemplateSourceFiles, baseVersion: string, selected: () => boolean): Promise<WriteResult> {
  const project = useProjectStore.getState();
  const doc = project.composition;
  if (!doc || !target.clip) return saveCurrentSource(source.ref, files, baseVersion, selected);

  const { t } = i18next;
  if (!await askConfirm({ title: t('liveCode.sharedTitle'), body: t('liveCode.sharedBody'), confirm: t('liveCode.saveShared') })) {
    return { ok: false, error: 'io' };
  }
  const stamp = compositionResourceStamp(doc);
  const current = () => selected() && useProjectStore.getState().revision === project.revision && compositionResourceStamp(doc) === stamp;
  return saveTemplateSource(source, files, baseVersion, current, async (candidate) => {
    await trialComposition(doc, project, target, candidate);
    return {
      ok: true,
      discard() {},
      commit() {
        const state = useProjectStore.getState();
        // 刷新仍引用该模板的当前合成；不覆盖等待磁盘写入期间发生的用户操作，不记入撤销。
        if (state.composition?.tracks.some((track) => track.clips.some((clip) => sameRef(clip.template, source.ref)))) {
          const revision = state.revision + 1;
          useProjectStore.setState({ revision, structureRevision: state.structureRevision + 1,
            savedRevision: state.revision === state.savedRevision ? revision : state.savedRevision });
        }
      },
    };
  });
}

export async function copyBuiltin(target: Target, selected: () => boolean): Promise<boolean> {
  const project = useProjectStore.getState();
  if (target.track?.locked || !selected()) return false;
  const copy = await window.allay.templates.copyBuiltin(target.ref);
  if (!copy.ok || !selected()) return false;
  const next = await readTemplate(copy.entry.id, copy.entry.version);
  const current = () => selected() && useProjectStore.getState().revision === project.revision;
  if (!next || !current()) return false;
  const locale = i18next.language;
  const params = sanitizeParams(next.params, target.params, { locale });
  if (project.composition && target.clip && target.track) {
    const changed = clipEdit(project.composition, { trackId: target.track.id, clipId: target.clip.id }, (clip) => ({ ...clip, template: next.ref, params }));
    if (changed === project.composition) return false;
    await trialComposition(changed, project, target, next);
    if (!current()) return false;
    useProjectStore.getState().setComposition(changed);
  } else {
    const trial = await previewEngine.trySwap(next, params);
    if (!trial.ok) return false;
    if (!current()) { trial.discard(); return false; }
    trial.commit(() => useProjectStore.getState().setTemplate(next, params, locale));
  }
  return sameRef(codeTarget(useProjectStore.getState())?.ref, next.ref);
}
