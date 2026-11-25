// 实时预览监视器：桌面版 @allay/engine 在独立 Web Worker 中实时渲染。
// 支持三种合成底幕（透明棋盘格 / 游戏黄昏山景 / 深色剪辑轨）、无遮挡控制条、窄段落文字自适应与指针/键盘精确擦除。
import { AllayLoader } from '@allay/mascot';
import { localize, type ParamValues } from '@allay/template-sdk';
import { Skeleton } from '@allay/ui/components/misc';
import { Pause, Play } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { mcGameVersion, mcTextureUrl } from '../../host/mc-pack';
import { showcaseEntries, type SiteTemplateEntry } from '../../host/templates';
import { LivePreview, hasWebgl2, type LiveState } from '../engine/runtime';
import { TEMPLATE_ICON_IDS } from '../links';
import { usePrefs } from '../prefs';

export type ViewerBackdrop = 'checker' | 'footage' | 'dark';

export interface LiveViewerControl {
  templateId?: string | null;
  params?: ParamValues | null;
  scrub?: number | null;
}

interface Props {
  autoCycle?: boolean;
  scrubbable?: boolean;
  hidePicker?: boolean;
  noteHidden?: boolean;
  noteHiddenOnNarrow?: boolean;
  backdrop?: ViewerBackdrop;
  testId?: string;
  initialId?: string;
  requestPick?: { id: string; seq: number } | null;
  control?: LiveViewerControl;
  onPick?: (id: string) => void;
  className?: string;
}

type Status = 'starting' | 'ready' | 'unsupported' | 'failed';

const STAGE_COLORS = ['var(--stage-enter)', 'var(--stage-hold)', 'var(--stage-exit)'];

function FootageBackdrop() {
  return (
    <div className="preview-footage pointer-events-none absolute inset-0" aria-hidden="true">
      <div className="absolute top-[48%] left-[68%] aspect-square w-[10%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#ffe3a8] opacity-90 blur-[2px]" />
      <div
        className="absolute inset-x-0 bottom-0 h-[44%] bg-[#3b3157]"
        style={{ clipPath: 'polygon(0 40%, 12% 22%, 24% 38%, 38% 12%, 52% 34%, 66% 18%, 80% 36%, 92% 20%, 100% 30%, 100% 100%, 0 100%)' }}
      />
      <div
        className="absolute inset-x-0 bottom-0 h-[27%] bg-[#231d38]"
        style={{ clipPath: 'polygon(0 30%, 18% 50%, 34% 24%, 50% 46%, 70% 20%, 86% 44%, 100% 26%, 100% 100%, 0 100%)' }}
      />
    </div>
  );
}

export function LiveViewer({
  autoCycle = false,
  scrubbable = true,
  hidePicker = false,
  noteHidden = false,
  noteHiddenOnNarrow = false,
  backdrop = 'checker',
  testId,
  initialId,
  requestPick,
  control,
  onPick,
  className,
}: Props) {
  const { t } = useTranslation();
  const { language, reducedMotion } = usePrefs();
  const entries = useMemo(() => showcaseEntries(), []);
  const [index, setIndex] = useState(() => Math.max(0, entries.findIndex((e) => e.id === (initialId ?? 'allay.builtin.block-wipe'))));
  const [status, setStatus] = useState<Status>('starting');
  const [state, setState] = useState<LiveState>({ duration: 1, cutTime: null, time: 0, playing: !reducedMotion });
  const cycling = useRef(autoCycle && !reducedMotion);
  const draggingRef = useRef(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<LivePreview | null>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const sliderRef = useRef<HTMLDivElement>(null);
  const entry: SiteTemplateEntry | undefined = entries[index];
  const name = entry ? localize(entry.manifest.name, language) : '';

  // 启动独立引擎 Worker：每次挂载在独立空容器内动态新建 <canvas>（避免 React StrictMode / HMR 对同一节点二次调用 transferControlToOffscreen 抛错）
  useEffect(() => {
    const host = canvasHostRef.current;
    const stage = stageRef.current;
    if (!host || !stage) return;
    if (!hasWebgl2()) {
      setStatus('unsupported');
      return;
    }
    setStatus('starting');
    const canvas = document.createElement('canvas');
    canvas.className = 'block size-full';
    canvas.setAttribute('role', 'img');
    host.replaceChildren(canvas);

    let disposed = false;
    let live: LivePreview | null = null;
    void (async () => {
      try {
        live = await LivePreview.create(canvas);
      } catch (error) {
        if (!disposed) {
          console.warn('[live] engine failed to start', error);
          setStatus('failed');
        }
        return;
      }
      if (disposed) {
        live.dispose();
        return;
      }
      liveRef.current = live;
      live.onLoop = () => {
        if (cycling.current) setIndex((i) => (i + 1) % entries.length);
      };
      live.subscribe((s) => {
        const p = s.duration > 0 ? Math.min(1, s.time / s.duration) : 0;
        if (playheadRef.current) playheadRef.current.style.transform = `translateX(${(p * 100).toFixed(3)}%)`;
        if (timeRef.current) timeRef.current.textContent = `${Math.min(s.time, s.duration).toFixed(2)} / ${s.duration.toFixed(2)} s`;
        if (sliderRef.current) {
          const pct = Math.round(p * 100);
          sliderRef.current.setAttribute('aria-valuenow', String(pct));
          sliderRef.current.setAttribute('aria-valuetext', `${Math.min(s.time, s.duration).toFixed(2)} s / ${s.duration.toFixed(2)} s`);
        }
        setState((prev) => (prev.duration === s.duration && prev.playing === s.playing && prev.cutTime === s.cutTime ? prev : s));
      });
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      live.resize(stage.clientWidth * dpr, stage.clientHeight * dpr);
      setStatus('ready');
    })();
    return () => {
      disposed = true;
      liveRef.current = null;
      live?.dispose();
      canvas.remove();
    };
  }, [entries.length]);

  useEffect(() => {
    const canvas = canvasHostRef.current?.querySelector('canvas');
    if (!canvas) return;
    if (name) canvas.setAttribute('aria-label', name);
    else canvas.removeAttribute('aria-label');
  }, [name, status]);

  // 外部（分镜编排 / 试玩台 / 模板卡片）驱动选中模板
  const controlledId = control?.templateId ?? null;
  useEffect(() => {
    if (!controlledId) return;
    const i = entries.findIndex((e) => e.id === controlledId);
    if (i >= 0) {
      cycling.current = false;
      setIndex(i);
    }
  }, [controlledId, entries]);

  useEffect(() => {
    if (!requestPick) return;
    const i = entries.findIndex((e) => e.id === requestPick.id);
    if (i >= 0) {
      cycling.current = false;
      setIndex(i);
      const live = liveRef.current;
      if (live && !reducedMotion) live.setPlaying(true, false);
    }
  }, [requestPick, entries, reducedMotion]);

  // 装载当前模板
  useEffect(() => {
    const live = liveRef.current;
    if (status !== 'ready' || !live || !entry) return;
    void live.show(entry, language, control?.params ?? undefined, reducedMotion);
    if (reducedMotion) live.setPlaying(false, false);
    else if (!live.userPaused && (control?.scrub === undefined || control.scrub === null)) live.setPlaying(true, false);
    // 切换模板或语言时整套重装；细粒度参数交给下面 setParams
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, entry, language, reducedMotion]);

  // 外部参数实时更新
  useEffect(() => {
    const live = liveRef.current;
    if (status !== 'ready' || !live || !entry || !control?.params) return;
    if (live.templateId !== entry.id) return;
    live.setParams(control.params);
  }, [status, entry, control?.params]);

  // 外部帧定位（如分镜第三步导出进度）
  useEffect(() => {
    const live = liveRef.current;
    if (status !== 'ready' || !live) return;
    const scrub = control?.scrub;
    if (typeof scrub === 'number') {
      live.setPlaying(false, false);
      live.seek(scrub * state.duration);
    } else if (!reducedMotion && !live.userPaused) {
      live.setPlaying(true, false);
    }
  }, [status, control?.scrub, state.duration, reducedMotion]);

  // 视口可见性与尺寸监听：滚出视口立即暂停 Worker 渲染循环
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const ro = new ResizeObserver(() => {
      const live = liveRef.current;
      if (!live) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      live.resize(stage.clientWidth * dpr, stage.clientHeight * dpr);
    });
    const io = new IntersectionObserver((es) => {
      liveRef.current?.setVisible(es.some((e) => e.isIntersecting));
    });
    ro.observe(stage);
    io.observe(stage);
    return () => {
      ro.disconnect();
      io.disconnect();
    };
  }, []);

  const pick = (i: number) => {
    cycling.current = false;
    setIndex(i);
    const live = liveRef.current;
    if (live && !reducedMotion) live.setPlaying(true, false);
    const id = entries[i]?.id;
    if (id) onPick?.(id);
  };

  const togglePlay = () => {
    const live = liveRef.current;
    if (!live) return;
    cycling.current = false;
    live.setPlaying(!state.playing, true);
  };

  const segments = useMemo(() => {
    const m = entry?.manifest;
    if (!m?.timeline) return [];
    const items = m.timeline.segments.map((s) => {
      const fromControl = control?.params?.[s.param];
      const def = (m.params ?? []).find((p) => p.key === s.param);
      const value = typeof fromControl === 'number' ? fromControl : typeof def?.default === 'number' ? def.default : 0;
      return { key: s.param, label: localize(s.label, language), value };
    });
    const total = items.reduce((n, s) => n + s.value, 0) || 1;
    return items.map((s) => ({ ...s, share: s.value / total }));
  }, [entry, language, control?.params]);

  const scrubAtClientX = (clientX: number, el: HTMLElement) => {
    const live = liveRef.current;
    if (!live || state.duration <= 0) return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return;
    const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    cycling.current = false;
    live.setPlaying(false, true);
    live.seek(ratio * state.duration);
  };

  const onPointerDown = (ev: PointerEvent<HTMLDivElement>) => {
    if (!scrubbable || status !== 'ready') return;
    draggingRef.current = true;
    ev.currentTarget.setPointerCapture(ev.pointerId);
    scrubAtClientX(ev.clientX, ev.currentTarget);
  };

  const onPointerMove = (ev: PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    scrubAtClientX(ev.clientX, ev.currentTarget);
  };

  const stopDrag = (ev: PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    if (ev.currentTarget.hasPointerCapture(ev.pointerId)) {
      ev.currentTarget.releasePointerCapture(ev.pointerId);
    }
  };

  const onTimelineKeyDown = (ev: KeyboardEvent<HTMLDivElement>) => {
    if (!scrubbable || status !== 'ready' || state.duration <= 0) return;
    const live = liveRef.current;
    if (!live) return;
    const step = state.duration * 0.05;
    if (ev.key === 'ArrowLeft') {
      ev.preventDefault();
      cycling.current = false;
      live.setPlaying(false, true);
      live.seek(Math.max(0, state.time - step));
    } else if (ev.key === 'ArrowRight') {
      ev.preventDefault();
      cycling.current = false;
      live.setPlaying(false, true);
      live.seek(Math.min(state.duration, state.time + step));
    } else if (ev.key === 'Home') {
      ev.preventDefault();
      cycling.current = false;
      live.setPlaying(false, true);
      live.seek(0);
    } else if (ev.key === 'End') {
      ev.preventDefault();
      cycling.current = false;
      live.setPlaying(false, true);
      live.seek(state.duration);
    } else if (ev.key === ' ' || ev.key === 'Enter') {
      ev.preventDefault();
      togglePlay();
    }
  };

  const cutShare = state.cutTime !== null && state.duration > 0 ? state.cutTime / state.duration : null;
  const stageBgClass = backdrop === 'dark' ? 'preview-dark' : backdrop === 'checker' ? 'preview-checker' : '';

  return (
    <div className={`monitor p-2.5 sm:p-3 ${className ?? ''}`} data-testid={testId} data-status={status} data-backdrop={backdrop}>
      <div className="flex h-8 items-center gap-2.5 px-2 text-[13px]">
        <span className="relative flex size-2" aria-hidden="true">
          {state.playing && !reducedMotion && <span className="absolute inset-0 animate-ping rounded-full bg-primary opacity-60" />}
          <span className="relative size-2 rounded-full bg-primary" />
        </span>
        <span className="font-semibold">{t('site.hero.viewerLabel')}</span>
        <span className="truncate text-fg-muted" data-testid="live-template-name">
          {name}
        </span>
        <span className="t-mono ml-auto hidden text-[10.5px] text-fg-subtle sm:inline">1920 × 1080 · 60 fps</span>
      </div>

      <div ref={stageRef} className={`${stageBgClass} relative aspect-video w-full overflow-hidden rounded-[10px]`} data-testid="live-stage">
        {backdrop === 'footage' && <FootageBackdrop />}
        <div ref={canvasHostRef} className="relative z-[1] size-full" />
        {status === 'starting' && (
          <AllayLoader loading label={t('site.hero.starting')} priority="preview" className="absolute inset-0 z-[2]">
            <div className="flex size-full flex-col items-center justify-center gap-3 p-6">
              <Skeleton className="h-[52%] w-[56%]" />
              <span className="text-[12px] text-fg-subtle">{t('site.hero.starting')}</span>
            </div>
          </AllayLoader>
        )}
        {(status === 'unsupported' || status === 'failed') && (
          <div className="absolute inset-0 z-[2] flex items-center justify-center p-6 text-center text-[13px] text-fg-muted">
            {status === 'unsupported' ? t('site.hero.noWebgl') : t('site.hero.engineFailed')}
          </div>
        )}
      </div>

      <div className="mt-2.5 space-y-2.5 px-1">
        {!hidePicker && (
          <div className="site-scroll-x flex items-center gap-1 overflow-x-auto py-0.5" role="toolbar" aria-label={t('site.hero.pick')}>
            <button
              type="button"
              className="link-focus flex size-7 shrink-0 items-center justify-center rounded-md bg-control text-foreground transition-colors duration-150 hover:bg-control-hi disabled:opacity-45"
              aria-label={state.playing ? t('site.hero.pause') : t('site.hero.play')}
              data-testid="live-play"
              disabled={status !== 'ready'}
              onClick={togglePlay}
            >
              {state.playing ? <Pause size={14} weight="fill" /> : <Play size={14} weight="fill" />}
            </button>
            <span className="mx-0.5 h-4 w-px shrink-0 bg-divider" aria-hidden="true" />
            {entries.map((e, i) => {
              const iconUrl = mcTextureUrl(TEMPLATE_ICON_IDS[e.id] ?? '');
              return (
                <button
                  key={e.id}
                  type="button"
                  aria-pressed={i === index}
                  data-testid="live-chip"
                  data-template={e.id}
                  onClick={() => pick(i)}
                  className={`link-focus flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] whitespace-nowrap transition-colors duration-150 ${
                    i === index ? 'bg-control-hi font-medium text-foreground' : 'text-fg-muted hover:bg-control hover:text-foreground'
                  }`}
                >
                  {iconUrl && <img src={iconUrl} alt="" width={13} height={13} className="pixelated size-[13px] shrink-0 rounded-[2px]" draggable={false} />}
                  {localize(e.manifest.name, language)}
                </button>
              );
            })}
          </div>
        )}

        <div className="flex items-center gap-2.5">
          {hidePicker && (
            <button
              type="button"
              className="link-focus flex size-7 shrink-0 items-center justify-center rounded-md bg-control text-foreground transition-colors duration-150 hover:bg-control-hi disabled:opacity-45"
              aria-label={state.playing ? t('site.hero.pause') : t('site.hero.play')}
              data-testid="live-play"
              disabled={status !== 'ready'}
              onClick={togglePlay}
            >
              {state.playing ? <Pause size={14} weight="fill" /> : <Play size={14} weight="fill" />}
            </button>
          )}
          <div
            ref={sliderRef}
            className={`link-focus relative flex-1 rounded-[8px] ${scrubbable ? 'cursor-ew-resize touch-none' : ''}`}
            role={scrubbable ? 'slider' : undefined}
            tabIndex={scrubbable ? 0 : undefined}
            aria-label={scrubbable ? t('site.hero.scrub') : undefined}
            aria-valuemin={scrubbable ? 0 : undefined}
            aria-valuemax={scrubbable ? 100 : undefined}
            aria-valuenow={scrubbable ? Math.round((state.duration > 0 ? state.time / state.duration : 0) * 100) : undefined}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={stopDrag}
            onPointerCancel={stopDrag}
            onKeyDown={onTimelineKeyDown}
            data-testid="live-timeline"
          >
            <div className="flex h-7 gap-[3px] rounded-[8px] bg-well p-[3px]">
              {segments.map((s, i) => {
                const narrow = s.share < 0.16;
                return (
                  <div
                    key={s.key}
                    title={`${s.label} · ${s.value.toFixed(2)}s`}
                    className={`flex min-w-0 items-center overflow-hidden rounded-[5px] text-[11px] text-stage-foreground transition-[flex-grow] duration-300 ${
                      narrow ? 'justify-center px-1' : 'justify-between gap-1.5 px-2'
                    }`}
                    style={{ flexGrow: s.share, flexBasis: 0, background: STAGE_COLORS[i % 3] }}
                  >
                    {s.share >= 0.1 && <span className="truncate">{s.label}</span>}
                    {s.share >= 0.2 && <span className="t-tab hidden shrink-0 opacity-80 sm:inline">{s.value.toFixed(2)}s</span>}
                  </div>
                );
              })}
            </div>
            {cutShare !== null && <span className="cut-mark top-[-4px]" style={{ left: `${cutShare * 100}%` }} aria-hidden="true" />}
            <div className="pointer-events-none absolute inset-y-[-3px] right-0 left-0">
              <div ref={playheadRef} className="site-playhead absolute inset-y-0 left-0 w-full">
                <div className="absolute inset-y-0 left-0 w-[2px] -translate-x-1/2 rounded-full bg-primary" />
              </div>
            </div>
          </div>
        </div>

        <div className={`items-center justify-between gap-4 text-[11px] text-fg-subtle ${noteHidden ? 'hidden' : noteHiddenOnNarrow ? 'hidden sm:flex' : 'flex'}`}>
          <span data-testid="assets-note" className="line-clamp-2">
            {mcGameVersion ? t('site.hero.mcAssets', { version: mcGameVersion }) : t('site.hero.demoAssets')}
          </span>
          <span ref={timeRef} data-testid="live-time" className="t-tab hidden shrink-0 sm:inline" />
        </div>
      </div>
    </div>
  );
}
