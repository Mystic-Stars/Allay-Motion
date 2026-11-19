import { localize, parseManifest, sameValue, sanitizeParams } from '@allay/template-sdk';
import i18next from 'i18next';
import type { CodeInspectorAction, CodeInspectorPacket, CodeInspectorParentApi } from '../../../../shared/code-inspector';
import { WriteSourceSchema } from '../../../../shared/template-authoring';
import { resolveLanguage, systemLocale } from '../../../i18n';
import { sameRef } from '../../../stores/devStore';
import { notify } from '../../../stores/noticeStore';
import { useProjectStore } from '../../../stores/projectStore';
import { useTemplateStore } from '../../../stores/templateStore';
import { useTransportStore } from '../../../stores/transportStore';
import { useUiStore } from '../../../stores/uiStore';
import { readTemplate, type TemplateSource } from '../../../templates/catalog';
import { previewEngine } from '../../preview/previewEngine';
import type { SetupTraceSample } from '../../../engine-host/EngineHost';
import { codeTarget, onCodeSelectionChanged, type Project, type Target } from './selection';
import { copyBuiltin, saveSource } from './sourceActions';
import { framePublisher, matchesTrace, type ExecutionTrace, type TraceTarget } from './trace';

type Packet<K extends CodeInspectorPacket['type']> = Extract<CodeInspectorPacket, { type: K }>;
type Snapshot = {
  target: Target;
  source: TemplateSource;
  raw?: { source: string; manifest: string; version: string };
  builtinScript: boolean;
};

function sameManifest(text: string, source: TemplateSource): boolean {
  try {
    const parsed = parseManifest(JSON.parse(text.replace(/^\uFEFF/, '')));
    const effective = parseManifest(source.manifest);
    return parsed.ok && effective.ok && !parsed.manifest.extends &&
      JSON.stringify({ ...parsed.manifest, params: parsed.manifest.params ?? [] }) ===
      JSON.stringify({ ...effective.manifest, params: effective.manifest.params ?? [] });
  } catch {
    return false;
  }
}

function appearance() {
  const { settings } = useUiStore.getState();
  return { language: resolveLanguage(settings.language, systemLocale()), theme: settings.theme };
}

function sameTarget(left: Target | null, right: Target | null) {
  return !!left && !!right && sameRef(left.ref, right.ref) && left.clip?.id === right.clip?.id;
}

function traceTarget(target: Target): TraceTarget {
  return { ...target.ref, ...(target.clip ? { clipId: target.clip.id } : {}) };
}

async function readSnapshot(project: Project, target: Target): Promise<Snapshot | null> {
  const source = target.clip ? await readTemplate(target.ref.id, target.ref.version) : project.template;
  if (!source) return null;
  const entry = useTemplateStore.getState().entries.find((item) => sameRef(item, target.ref));
  const builtin = entry?.source === 'builtin';
  const raw = builtin || entry?.kind === 'derived' ? undefined : await window.allay.templates.readSource(target.ref);
  return { target, source, builtinScript: builtin && entry.kind === 'script', ...(raw?.ok && raw.source.replace(/^\uFEFF/, '') === source.code && sameManifest(raw.manifest, source) ? { raw } : {}) };
}

/** 网站不提供此能力；不会监听浏览器的播放或伪造一个窗口。 */
export async function openCodeInspector(): Promise<void> {
  try {
    const api = window.allay.codeInspector;
    if (api) await api.open();
    else notify('info', i18next.t('liveCode.desktopOnly'));
  } catch {
    notify('error', i18next.t('liveCode.openFailed'));
  }
}

export function installCodeInspector(openAuthoring: () => void): void {
  const api = window.allay.codeInspector;
  if (api) new InspectorHost(api, openAuthoring);
}

class InspectorHost {
  private disposeOpen?: () => void;
  private snapshot: Snapshot | null = null;
  private header?: Packet<'document' | 'empty'>;
  private params?: Packet<'params'>;
  private lastFrame?: Packet<'frame'>;
  private lastSetup?: Packet<'setup'>;
  private query = 0;
  private selectionEpoch = 0;
  private token = 0;
  private busy = false;
  private pendingRead = false;
  private emptyReason = 'loading';
  private refreshScheduled = false;
  private readTarget: Target | null = null;
  private readonly frames = framePublisher((frame, revision) => {
    const transport = useTransportStore.getState();
    if (this.header?.type !== 'document' || frame.token !== this.header.token || revision !== useProjectStore.getState().revision ||
      frame.playing !== transport.playing || (frame.lines.length > 0 && !transport.playing && Math.abs(frame.time - transport.time) > 1e-6)) return;
    this.lastFrame = frame;
    this.api.publish(frame);
  });

  constructor(private readonly api: CodeInspectorParentApi, private readonly openAuthoring: () => void) {
    api.onOpenChanged((open) => this.setOpen(open));
  }

  private setOpen(open: boolean): void {
    if (open === !!this.disposeOpen) return;
    if (!open) {
      this.disposeOpen?.();
      this.disposeOpen = undefined;
      this.query++;
      this.pendingRead = false;
      this.readTarget = this.snapshot = null;
      this.header = this.params = undefined;
      this.lastSetup = undefined;
      this.resetTrace(null);
      return;
    }
    const disposers = [
      this.api.onAction((action) => void this.act(action)),
      onCodeSelectionChanged(() => { this.selectionEpoch++; this.refresh(); }),
      useProjectStore.subscribe((state, before) => {
        if (state.revision === before.revision && state.params === before.params && state.composition === before.composition && state.template === before.template) return;
        const target = codeTarget(state);
        if (!sameTarget(target, this.readTarget) || (!state.composition && state.template !== before.template)) {
          this.selectionEpoch++;
          this.scheduleRefresh();
        } else this.publishParams();
      }),
      useUiStore.subscribe((state, before) => {
        if (state.settings.language !== before.settings.language || state.settings.theme !== before.settings.theme) this.publishSnapshot();
      }),
      window.allay.templates.onChanged((change) => {
        if (sameRef(change, this.readTarget?.ref)) this.scheduleRefresh(true);
      }),
      previewEngine.onExecutionTrace((sample) => this.trace(sample)),
      previewEngine.onSetupTrace((sample) => this.publishSetup(sample)),
      useTransportStore.subscribe((state, before) => {
        if (state.playing !== before.playing) previewEngine.requestRender(state.time);
      }),
    ];
    this.disposeOpen = () => disposers.forEach((dispose) => dispose());
    this.refresh();
  }

  private scheduleRefresh(force = false): void {
    this.pendingRead ||= force;
    if (this.refreshScheduled) return;
    this.refreshScheduled = true;
    queueMicrotask(() => {
      this.refreshScheduled = false;
      if (this.disposeOpen) this.refresh(this.pendingRead);
    });
  }

  private refresh(force = false): void {
    const project = useProjectStore.getState();
    const target = codeTarget(project);
    const same = sameTarget(this.readTarget, target);
    if (this.busy && same && force) return;
    this.pendingRead = false;
    const query = ++this.query;
    this.readTarget = target;
    if (!same) {
      this.snapshot = null;
      this.resetTrace(null);
    }
    if (!target || !same) this.publishSnapshot(target ? 'loading' : project.composition ? 'selectClip' : 'noTemplate');
    if (!target) return;
    if (!force && same && this.snapshot && (target.clip || project.template === this.snapshot.source)) {
      this.publishParams();
      return;
    }
    const accept = (snapshot: Snapshot | null) => {
      if (query !== this.query || !sameTarget(target, codeTarget(useProjectStore.getState()))) return;
      this.snapshot = snapshot;
      this.publishSnapshot(snapshot ? undefined : 'unavailable');
    };
    void readSnapshot(project, target).then(accept, () => accept(null));
  }

  private publishSnapshot(empty = this.emptyReason): void {
    const view = appearance();
    const snapshot = this.snapshot;
    if (!snapshot) {
      this.emptyReason = empty;
      const message = i18next.t(`liveCode.${empty}`, { lng: view.language });
      const packet: Packet<'empty'> = { type: 'empty', message, ...view };
      if (JSON.stringify(packet) !== JSON.stringify(this.header)) this.api.publish(packet);
      this.header = packet;
      return;
    }
    const { source, raw, target } = snapshot;
    const identity = traceTarget(target);
    const previous = this.header?.type === 'document' ? this.header : undefined;
    const packet: Packet<'document'> = {
      type: 'document', token: previous?.token ?? 0, ...identity, ...view,
      title: localize(source.manifest.name, view.language) || source.ref.id,
      source: raw?.source ?? source.code, manifest: raw?.manifest ?? JSON.stringify(source.manifest, null, 2),
      editable: raw !== undefined, ...(raw ? { baseVersion: raw.version } : {}),
    };
    const newRuntime = !previous || !sameRef(previous, identity) || previous.clipId !== identity.clipId || previous.source !== packet.source ||
      previous.manifest !== packet.manifest || previous.baseVersion !== packet.baseVersion;
    if (newRuntime) {
      packet.token = ++this.token;
      this.params = undefined;
      this.lastSetup = undefined;
    }
    this.header = packet;
    if (newRuntime || previous?.language !== packet.language || previous.theme !== packet.theme) this.api.publish(packet);
    this.publishParams();
    if (newRuntime) this.resetTrace(identity);
  }

  private publishParams(): void {
    const project = useProjectStore.getState();
    const target = codeTarget(project);
    const snapshot = this.snapshot;
    if (!target || !snapshot || !sameTarget(snapshot.target, target) || this.header?.type !== 'document' ||
      (!project.composition && project.template !== snapshot.source)) return;
    const params = sanitizeParams(snapshot.source.params, target.params, { locale: this.header.language });
    const fps = project.composition?.fps ?? project.output.fps;
    if (this.params?.fps === fps && Object.keys(params).every((key) => sameValue(params[key], this.params?.params[key]))) return;
    this.params = { type: 'params', token: this.header.token, params, fps };
    this.api.publish(this.params);
  }

  private resetTrace(target: TraceTarget | null): void {
    this.frames.clear();
    this.lastFrame = undefined;
    previewEngine.setExecutionTrace(target);
    if (target) {
      this.publishSetup(previewEngine.currentSetupTrace);
      previewEngine.requestRender(useTransportStore.getState().time);
    }
  }

  private publishSetup(sample: SetupTraceSample | null): void {
    const header = this.header;
    const snapshot = this.snapshot;
    const project = useProjectStore.getState();
    if (header?.type !== 'document' || !snapshot || !sameTarget(snapshot.target, codeTarget(project))) return;
    if (sample && (previewEngine.loadedProjectRevision !== project.revision || !sameRef(header, sample) ||
        header.clipId !== sample.clipId || snapshot.source.code !== sample.source)) return;
    const lines = sample?.lines ?? [];
    const previous = this.lastSetup;
    if (previous?.token === header.token && previous.lines.length === lines.length && previous.lines.every((line, index) => line === lines[index])) return;
    if (!previous && !lines.length) return;
    this.lastSetup = { type: 'setup', token: header.token, lines };
    this.api.publish(this.lastSetup);
  }

  private trace(sample: ExecutionTrace | null): void {
    const header = this.header;
    const snapshot = this.snapshot;
    const project = useProjectStore.getState();
    const transport = useTransportStore.getState();
    if (header?.type !== 'document' || !snapshot || !sameTarget(snapshot.target, codeTarget(project))) return;
    if (!sample) {
      this.frames.cancel();
      if (this.lastFrame?.lines.length) {
        this.frames.push({ ...this.lastFrame, playing: transport.playing, lines: [] }, project.revision);
      }
      return;
    }
    if (previewEngine.loadedProjectRevision !== project.revision || !matchesTrace(header, snapshot.source.code, sample) ||
      (!transport.playing && Math.abs(sample.t - transport.time) > 1e-6)) return;
    const fps = project.composition?.fps ?? project.output.fps;
    this.frames.push({ type: 'frame', token: header.token, time: sample.t, frame: Math.round(sample.t * fps), playing: transport.playing, lines: sample.lines }, project.revision);
  }

  private async act(action: CodeInspectorAction): Promise<void> {
    if (action.type === 'authoring') { this.openAuthoring(); return; }
    const snapshot = this.snapshot;
    const header = this.header;
    const initial = useProjectStore.getState();
    const epoch = this.selectionEpoch;
    const selected = () => this.selectionEpoch === epoch && this.header?.type === 'document' && this.header.token === action.token && !!snapshot &&
      sameTarget(snapshot.target, codeTarget(useProjectStore.getState())) && (initial.composition !== null || useProjectStore.getState().template === snapshot.source);
    const result = (ok: boolean, message: string) => {
      if (this.header?.type === 'document' && this.header.token === action.token) this.api.publish({ type: 'result', token: action.token, ok, message });
      else if (!ok && this.disposeOpen) notify('error', message);
    };
    const { t } = i18next;
    if (!snapshot || header?.type !== 'document' || !selected()) { result(false, t('liveCode.stale')); return; }
    const canProceed = () => selected() && !useUiStore.getState().exporting;
    if (this.busy || !canProceed()) { result(false, t('liveCode.busy')); return; }
    this.busy = true;
    try {
      if (action.type === 'copy') {
        const target = codeTarget(initial);
        const ok = !!target && snapshot.builtinScript && await copyBuiltin(target, canProceed);
        result(ok, t(ok ? 'liveCode.copied' : 'liveCode.copyFailed'));
        if (snapshot.builtinScript) await useTemplateStore.getState().refresh();
      } else {
        const request = WriteSourceSchema.safeParse({ source: action.source, manifest: action.manifest, baseVersion: action.baseVersion });
        const target = codeTarget(initial);
        if (!target || !request.success || !header.editable || action.baseVersion !== header.baseVersion) { result(false, t('liveCode.conflict')); return; }
        const saved = await saveSource(snapshot.source, target, request.data, request.data.baseVersion, canProceed);
        if (saved.ok) {
          result(true, t('liveCode.saved'));
          void useTemplateStore.getState().refresh().catch((error: unknown) => console.error('[live-code] catalogue refresh failed', error));
        } else if (saved.error === 'invalid') {
          const detail = saved.diagnostics.map(({ line, column, message, code }) => `${code === 'manifest-invalid' ? 'manifest.json' : 'template.js'}${line ? `:${line}:${column ?? 1}` : ''}: ${message}`).join('\n');
          result(false, `${t('liveCode.invalid')}\n${detail}`.slice(0, 2500));
        } else result(false, t(saved.error === 'conflict' ? 'liveCode.conflict' : 'liveCode.saveFailed'));
      }
    } catch (error) {
      result(false, `${t('liveCode.saveFailed')} ${String(error).slice(0, 1200)}`);
    } finally {
      this.busy = false;
      if (this.disposeOpen) this.refresh(true);
    }
  }
}
