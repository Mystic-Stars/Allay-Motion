import { Button } from '@allay/ui/components/button';
import { Dialog, DialogContent, DialogTitle } from '@allay/ui/components/dialog';
import { Input, ToggleGroup, ToggleGroupItem } from '@allay/ui/components/misc';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@allay/ui/components/select';
import { ScrubNumberField } from '@allay/ui/editor';
import { ICON } from '@allay/ui/lib/icons';
import { cn } from '@allay/ui/lib/utils';
import { CheckCircle, CircleNotch, CloudArrowDown, FolderOpen, Warning } from '@phosphor-icons/react';
import { frameCount } from '@allay/engine/frames';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  EXPORT_FPS,
  EXPORT_PRESETS,
  KEY_COLOR_CHOICES,
  KeyColorSchema,
  PRESET_EXTENSION,
  estimateBytes,
  evenDimension,
  sanitizeFileName,
  type ExportPreset,
} from '../../../shared/export';
import { dispatch } from '../../app/registry';
import { soundFileStates } from '../../audio/sound-library';
import { usePreviewStore } from '../../stores/previewStore';
import { useProjectStore } from '../../stores/projectStore';
import { useTransportStore } from '../../stores/transportStore';
import { useUiStore } from '../../stores/uiStore';
import { PRESET_KEY, PRESET_STATE_KEYS, presetState, useEnsureExportInfo, useExportInfo } from './exportInfo';
import { ExportAllay, ExportProgressPage, ExportResultPage } from './ExportPages';
import { formatBytes } from './labels';
import { coverCheck, QUALITY_SUBFRAMES, type CoverResult, type QualityLevel } from './exportRunner';
import { defaultFileName, useExportTasks } from './exportTasks';

// 导出对话框（docs/06-ui-design.md 6.4，720×520）：设置页、进度页、完成页。
// 对话框只是导出任务的观察者：“导出”经 dispatch('exportTask.start') 启动任务，进度页和完成页读任务的状态，
// “取消”经 dispatch('exportTask.cancel')（docs/code-editing-and-mcp-plan.md H7）。

const QUALITIES = Object.keys(QUALITY_SUBFRAMES) as QualityLevel[];

/** 分辨率预设（5.2）；“自定义”另有宽高输入 */
export const EXPORT_RESOLUTIONS = [
  { key: '1080p', width: 1920, height: 1080 },
  { key: '1440p', width: 2560, height: 1440 },
  { key: '2160p', width: 3840, height: 2160 },
  { key: 'vertical', width: 1080, height: 1920 },
  { key: 'square', width: 1080, height: 1080 },
] as const;

export function ExportDialog({ onClose }: { onClose(): void }) {
  const { t } = useTranslation();
  // 对话框重新打开时，接上还在跑的任务
  const [taskId, setTaskId] = useState<string | null>(() => useExportTasks.getState().activeId);
  const task = useExportTasks((s) => (taskId ? (s.tasks[taskId] ?? null) : null));
  // 改过的文件名在“再导出一个”之后保留；没改过时跟着默认规则（分辨率、帧率变了就跟着变）
  const [name, setName] = useState<string | null>(null);
  const running = task !== null && (task.status === 'preparing' || task.status === 'rendering' || task.status === 'muxing');

  useEffect(() => {
    // 导出是模态的：预览停下来
    useTransportStore.getState().setPlaying(false);
  }, []);

  const page = task === null ? 'settings' : running ? 'progress' : 'result';

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // 导出进行中不能点外面或按 Esc 关掉：要用“取消”
        if (!open && !running) onClose();
      }}
    >
      <DialogContent
        showClose={!running}
        closeLabel={t('common.close')}
        className="h-[520px] w-[720px] gap-0 p-0"
        data-testid="export-dialog"
        data-page={page}
      >
        <div className="flex h-12 shrink-0 items-center border-b border-divider px-5">
          <DialogTitle className="text-base">{page === 'result' && task?.status === 'done' ? t('export.doneTitle') : t('export.title')}</DialogTitle>
        </div>
        {page === 'settings' && <SettingsPage onClose={onClose} onStarted={setTaskId} name={name} setName={setName} />}
        {page !== 'settings' && task && (
          <div className="flex min-h-0 flex-1 flex-col">
            {/* 进度页和结果页共用同一个悦灵进度条（不重新挂载，7.6 B） */}
            <div className="shrink-0 px-12 pt-10">
              <ExportAllay task={task} />
            </div>
            {page === 'progress' ? <ExportProgressPage task={task} /> : <ExportResultPage task={task} onAgain={() => setTaskId(null)} onClose={onClose} />}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- 设置页

function SettingsPage({ onClose, onStarted, name, setName }: { onClose(): void; onStarted(id: string): void; name: string | null; setName(v: string | null): void }) {
  const { t } = useTranslation();
  const info = useEnsureExportInfo();
  const probing = useExportInfo((s) => s.probing);
  const saved = useProjectStore((s) => s.exportSettings);
  const output = useProjectStore((s) => s.output);
  const template = useProjectStore((s) => s.template);
  const composition = useProjectStore((s) => s.composition);
  const ready = usePreviewStore((s) => s.status.kind === 'ready');
  const timelineDuration = useTransportStore((s) => s.duration);
  const duration = ready && timelineDuration > 0 ? timelineDuration : null;
  const [error, setError] = useState<string | null>(null);

  // 从“导出”分体按钮的下拉里选了格式时，预先选中它（并记进工程）
  useEffect(() => {
    const chosen = useUiStore.getState().exportPreset;
    if (chosen) useProjectStore.getState().setExportSettings({ preset: chosen });
    useUiStore.setState({ exportPreset: null });
  }, []);

  const preset = saved.preset;
  const set = (patch: Partial<typeof saved>) => useProjectStore.getState().setExportSettings(patch);
  const state = (p: ExportPreset) => presetState(info, probing, p);

  const fileName = name ?? defaultFileName();
  const [folder, setFolder] = useState<string | null>(null);
  useEffect(() => void window.allay.export.outputFolder().then(setFolder), []);

  const frames = composition?.durationFrames ?? (duration === null ? null : frameCount(duration, output.fps));
  const estimate = frames === null ? null : estimateBytes(preset, output.width, output.height, frames);
  const cover = useCoverCheck(saved.quality, saved.shutterAngle);

  const presetOk = state(preset) === 'ok';
  const canStart = presetOk && (composition ? ready && composition.durationFrames > 0 : template !== null) && info !== null && info.available;

  const start = async () => {
    setError(null);
    try {
      const out = (await dispatch('exportTask.start', {
        preset,
        quality: saved.quality,
        shutterAngle: saved.shutterAngle,
        key: saved.key,
        fileName: sanitizeFileName(fileName),
      })) as { taskId: string };
      onStarted(out.taskId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <div className="flex min-h-0 flex-1">
        {/* 左列：格式卡片 */}
        <fieldset className="flex w-[300px] shrink-0 flex-col gap-2 overflow-y-auto border-r border-divider p-4" data-testid="export-presets">
          <legend className="sr-only">{t('export.format')}</legend>
          {info && !info.available && (
            <p role="alert" className="text-xs text-danger">
              {t('export.errors.ffmpegMissing')}
            </p>
          )}
          {EXPORT_PRESETS.map((p) => {
            const st = state(p);
            const k = PRESET_KEY[p];
            return (
              <label
                key={p}
                data-testid={`export-preset-${p}`}
                data-state={st}
                className="flex cursor-pointer gap-2.5 rounded-lg bg-control p-2.5 hover:bg-control-hi has-checked:bg-primary-soft has-checked:shadow-[inset_0_0_0_1.5px_var(--primary)] has-disabled:cursor-default has-disabled:opacity-50 has-disabled:hover:bg-control"
              >
                <input
                  type="radio"
                  name="preset"
                  value={p}
                  checked={preset === p}
                  disabled={st !== 'ok'}
                  onChange={() => set({ preset: p })}
                  className="mt-0.5 size-3.5 shrink-0 accent-(--primary)"
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-semibold">{t(`export.presets.${k}`)}</span>
                  <span className="text-xs text-fg-muted">{t(`export.presetDesc.${k}`)}</span>
                  <span className="text-xs text-fg-subtle">{t('export.worksWith', { apps: t(`export.presetFor.${k}`) })}</span>
                  {st !== 'ok' && (
                    <span className="flex items-center gap-1 text-xs text-warning" data-testid={`export-preset-${p}-reason`}>
                      {st === 'checking' ? <CircleNotch size={ICON.xs} className="animate-spin" /> : <Warning size={ICON.xs} />}
                      {t(PRESET_STATE_KEYS[st])}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </fieldset>

        {/* 右列：输出设置 */}
        <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-4" data-testid="export-settings">
          <ResolutionRow />
          <Row label={t('export.fps')}>
            <Select value={String(composition?.fps ?? output.fps)} disabled={composition !== null} onValueChange={(v) => useProjectStore.getState().setOutput({ ...output, fps: Number(v) })}>
              <SelectTrigger className="w-full" aria-label={t('export.fps')} data-testid="export-fps">
                <SelectValue>{(v: unknown) => `${String(v)} fps`}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {EXPORT_FPS.map((f) => (
                  <SelectItem key={f} value={String(f)}>
                    {f} fps
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
          <Row label={t('export.quality')} hint={t(`export.qualities.${saved.quality}`)}>
            <ToggleGroup value={[saved.quality]} onValueChange={(v) => v[0] && set({ quality: v[0] as QualityLevel })} aria-label={t('export.quality')} className="w-full" data-testid="export-quality">
              {QUALITIES.map((q) => (
                <ToggleGroupItem key={q} value={q} data-testid={`export-quality-${q}`} title={t(`export.qualities.${q}`)} className="flex-1">
                  {t(`export.qualityShort.${q}`)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Row>
          <Row label={t('export.shutter')} hint={t('export.shutterHint')}>
            <ScrubNumberField value={saved.shutterAngle} onChange={(v) => set({ shutterAngle: Math.round(v) })} min={0} max={360} step={1} unit="°" fill label={t('export.shutter')} testId="export-shutter" />
          </Row>
          {preset === 'greenscreen-mp4' && <KeyColorRow value={saved.key} onChange={(key) => set({ key })} />}
          <Row label={t('export.location')}>
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-xs text-fg-muted" title={folder ?? undefined} data-testid="export-folder">
                {folder ?? t('export.folderUnset')}
              </span>
              <Button
                variant="secondary"
                className="shrink-0 gap-1.5"
                data-testid="export-choose-folder"
                onClick={() =>
                  void window.allay.export.chooseFolder().then((r) => {
                    if (!r.canceled) setFolder(r.folder);
                  })
                }
              >
                <FolderOpen size={ICON.sm} />
                {t('export.chooseFolder')}
              </Button>
            </div>
          </Row>
          <Row label={t('export.fileName')}>
            <div className="flex items-center gap-1.5">
              <Input value={fileName} onChange={(e) => setName(e.target.value)} onBlur={() => setName(sanitizeFileName(fileName))} aria-label={t('export.fileName')} data-testid="export-filename" />
              <span className="num shrink-0 text-xs text-fg-subtle">{preset === 'png-sequence' ? '/' : `.${PRESET_EXTENSION[preset]}`}</span>
            </div>
          </Row>
          <CoverLine cover={cover} />
          <SoundsLine />
        </div>
      </div>

      <div className="flex h-14 shrink-0 items-center gap-3 border-t border-divider px-5">
        <span className="num min-w-0 flex-1 truncate text-xs text-fg-subtle" data-testid="export-estimate">
          {estimate !== null && frames !== null ? t('export.estimate', { size: formatBytes(estimate), frames }) : ''}
        </span>
        {error && (
          <span role="alert" className="truncate text-xs text-danger">
            {error}
          </span>
        )}
        <Button variant="secondary" size="lg" onClick={onClose} data-testid="export-dismiss">
          {t('export.cancel')}
        </Button>
        <Button size="lg" data-testid="export-start" disabled={!canStart} onClick={() => void start()}>
          {t('export.start')}
        </Button>
      </div>
    </>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[88px_minmax(0,1fr)] items-start gap-x-3 gap-y-1">
      <span className="pt-1.5 text-xs text-fg-muted">{label}</span>
      <div className="flex min-w-0 flex-col gap-1">
        {children}
        {hint && <span className="text-xs text-fg-subtle">{hint}</span>}
      </div>
    </div>
  );
}

function ResolutionRow() {
  const { t } = useTranslation();
  const output = useProjectStore((s) => s.output);
  const match = EXPORT_RESOLUTIONS.find((r) => r.width === output.width && r.height === output.height);
  const [custom, setCustom] = useState(!match);
  const key = custom || !match ? 'custom' : match.key;
  const [w, setW] = useState(String(output.width));
  const [h, setH] = useState(String(output.height));
  useEffect(() => {
    setW(String(output.width));
    setH(String(output.height));
  }, [output.width, output.height]);

  // 自定义分辨率：宽高各限制在 64–4096 并取偶数（5.2），输入框里显示修正后的值
  const commit = () => {
    const width = evenDimension(Number(w));
    const height = evenDimension(Number(h));
    setW(String(width));
    setH(String(height));
    if (width !== output.width || height !== output.height) useProjectStore.getState().setOutput({ ...output, width, height });
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') commit();
  };

  return (
    <Row label={t('export.resolution')} hint={key === 'custom' ? t('export.customHint') : undefined}>
      <Select
        value={key}
        onValueChange={(v) => {
          if (v === 'custom') {
            setCustom(true);
            return;
          }
          const r = EXPORT_RESOLUTIONS.find((x) => x.key === v);
          setCustom(false);
          if (r) useProjectStore.getState().setOutput({ ...output, width: r.width, height: r.height });
        }}
      >
        <SelectTrigger className="w-full" aria-label={t('export.resolution')} data-testid="export-resolution">
          <SelectValue>{(v: unknown) => t(`export.resolutions.${String(v)}`)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {[...EXPORT_RESOLUTIONS.map((r) => r.key), 'custom'].map((k) => (
            <SelectItem key={k} value={k}>
              {t(`export.resolutions.${k}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {key === 'custom' && (
        <div className="flex items-center gap-1.5">
          <Input inputMode="numeric" value={w} onChange={(e) => setW(e.target.value)} onBlur={commit} onKeyDown={onKey} aria-label={t('export.width')} data-testid="export-width" className="num" />
          <span className="text-xs text-fg-subtle">×</span>
          <Input inputMode="numeric" value={h} onChange={(e) => setH(e.target.value)} onBlur={commit} onKeyDown={onKey} aria-label={t('export.height')} data-testid="export-height" className="num" />
        </div>
      )}
    </Row>
  );
}

function KeyColorRow({ value, onChange }: { value: string; onChange(v: string): void }) {
  const { t } = useTranslation();
  const upper = value.toUpperCase();
  const preset = (KEY_COLOR_CHOICES as readonly string[]).includes(upper) ? upper : 'custom';
  const [draft, setDraft] = useState(upper);
  useEffect(() => setDraft(upper), [upper]);
  const names: Record<string, string> = { '#00FF00': 'green', '#0000FF': 'blue', '#000000': 'black', custom: 'custom' };
  return (
    <Row label={t('export.key')}>
      <ToggleGroup
        value={[preset]}
        onValueChange={(v) => {
          const next = v[0];
          if (next && next !== 'custom') onChange(next);
        }}
        aria-label={t('export.key')}
        className="w-full"
        data-testid="export-key"
      >
        {[...KEY_COLOR_CHOICES, 'custom'].map((c) => (
          <ToggleGroupItem key={c} value={c} className="flex-1 gap-1.5" data-testid={`export-key-${names[c]}`}>
            <span className="size-3 shrink-0 rounded-sm shadow-[inset_0_0_0_1px_var(--divider)]" style={{ background: c === 'custom' ? upper : c }} aria-hidden="true" />
            {t(`export.keyOptions.${names[c]}`)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const v = draft.trim().startsWith('#') ? draft.trim() : `#${draft.trim()}`;
          if (KeyColorSchema.safeParse(v).success) onChange(v.toUpperCase());
          else setDraft(upper);
        }}
        aria-label={t('export.keyHex')}
        data-testid="export-key-hex"
        className={cn('num', preset !== 'custom' && 'text-fg-muted')}
      />
    </Row>
  );
}

/** 遮盖检查（5.8）：设置变了以后重新检查，旧的检查作废 */
function useCoverCheck(quality: QualityLevel, shutterAngle: number): CoverResult | 'checking' | null {
  const { i18n } = useTranslation();
  const locale = i18n.language;
  const composition = useProjectStore((s) => s.composition);
  const template = useProjectStore((s) => s.template);
  const params = useProjectStore((s) => s.params);
  const output = useProjectStore((s) => s.output);
  const ready = usePreviewStore((s) => s.status.kind === 'ready');
  const [result, setResult] = useState<CoverResult | 'checking' | null>(null);
  const key = useMemo(() => ({ template, params, output, quality, shutterAngle }), [template, params, output, quality, shutterAngle]);
  useEffect(() => {
    if (composition || !key.template || !ready) {
      setResult(null);
      return;
    }
    const ctrl = new AbortController();
    setResult('checking');
    const timer = setTimeout(() => {
      void coverCheck({ template: key.template!, params: key.params, output: key.output, quality: key.quality, shutterAngle: key.shutterAngle, locale }, ctrl.signal).then((r) => {
        if (!ctrl.signal.aborted) setResult(r);
      });
    }, 250);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [composition, key, locale, ready]);
  return composition ? { kind: 'overlay' } : result;
}

/**
 * 导出前检查要用的音效（M6b）：预览装载结果里引擎选定的变体（与导出的相同）还在下载缓存的索引里、没取回时，
 * 提示数量并给“取回音效”（用户操作，联网只经 fetchObject）。不取回也能导出：这些音效静音。导出过程中不联网。
 */
function SoundsLine() {
  const { t } = useTranslation();
  const cues = usePreviewStore((s) => s.audioCues);
  const groups = useMemo(() => {
    const files = new Map<string | undefined, Set<string>>();
    for (const cue of cues) {
      if (!cue.variant) continue;
      const profile = cue.clip?.profile;
      let group = files.get(profile);
      if (!group) files.set(profile, (group = new Set()));
      group.add(cue.variant.file);
    }
    return [...files].flatMap(([profile, group]) => {
      const entries = [...group];
      return Array.from({ length: Math.ceil(entries.length / 256) }, (_, index) => ({ profile, files: entries.slice(index * 256, (index + 1) * 256) }));
    });
  }, [cues]);
  const [remote, setRemote] = useState<typeof groups>([]);
  const [state, setState] = useState<'idle' | 'fetching' | 'failed'>('idle');
  useEffect(() => {
    let alive = true;
    void Promise.all(groups.map(async ({ profile, files }) => {
      const states = await soundFileStates(files, false, profile);
      return { profile, files: files.filter((file) => states[file] === 'remote') };
    })).then((result) => { if (alive) setRemote(result.filter((group) => group.files.length > 0)); });
    return () => {
      alive = false;
    };
  }, [groups]);
  const count = remote.reduce((sum, group) => sum + group.files.length, 0);
  if (count === 0) return null;
  const fetchAll = async () => {
    setState('fetching');
    const still: typeof groups = [];
    for (const { profile, files } of remote) {
      const states = await soundFileStates(files, true, profile);
      const remaining = files.filter((file) => states[file] !== 'local');
      if (remaining.length > 0) still.push({ profile, files: remaining });
    }
    setRemote((current) => current === remote ? still : current);
    setState(still.length > 0 ? 'failed' : 'idle');
  };
  return (
    <div className="flex flex-col gap-1.5 rounded-md bg-control px-3 py-2" data-testid="export-sounds-remote" data-count={count}>
      <span className="flex items-start gap-1.5 text-xs text-fg-muted">
        <CloudArrowDown size={ICON.xs} className="mt-px shrink-0" />
        {t('export.soundsRemote', { count })}
      </span>
      {state === 'failed' && (
        <span role="alert" className="text-xs text-warning" data-testid="export-sounds-failed">
          {t('audio.fetchFailed')}
        </span>
      )}
      <Button variant="secondary" className="self-start" disabled={state === 'fetching'} onClick={() => void fetchAll()} data-testid="export-sounds-fetch">
        {t(state === 'fetching' ? 'export.soundsFetching' : 'export.soundsFetch')}
      </Button>
    </div>
  );
}

function CoverLine({ cover }: { cover: CoverResult | 'checking' | null }) {
  const { t } = useTranslation();
  if (cover === null) return <span data-testid="export-cover" data-state="unknown" hidden />;
  if (cover === 'checking') {
    return (
      <span data-testid="export-cover" data-state="checking" className="flex items-center gap-1.5 text-xs text-fg-subtle">
        <CircleNotch size={ICON.xs} className="animate-spin" />
        {t('export.cover.checking')}
      </span>
    );
  }
  if (cover.kind === 'overlay') {
    return (
      <span data-testid="export-cover" data-state="overlay" className="text-xs text-fg-subtle">
        {t('export.cover.overlay')}
      </span>
    );
  }
  const ok = cover.minAlpha === 255;
  return (
    <span data-testid="export-cover" data-state={ok ? 'ok' : 'warn'} data-min-alpha={cover.minAlpha} role={ok ? undefined : 'alert'} className={cn('flex items-start gap-1.5 text-xs', ok ? 'text-fg-subtle' : 'text-warning')}>
      {ok ? <CheckCircle size={ICON.xs} className="mt-px shrink-0 text-success" /> : <Warning size={ICON.xs} className="mt-px shrink-0" />}
      {ok ? t('export.cover.ok', { frame: cover.cutFrame }) : t('export.cover.warn', { frame: cover.cutFrame })}
    </span>
  );
}
