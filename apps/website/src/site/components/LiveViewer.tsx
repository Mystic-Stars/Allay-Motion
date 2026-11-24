// 实时预览面板：应用的预览面板的样子（左上“预览 · 模板名”、右上规格读数、棋盘格背景、悬浮工具条、阶段轨和剪辑点），
// 画面由桌面版的引擎 Worker 实时渲染。首屏到分镜的主视觉、窄屏的仿真器都用它。
// 可以由外面驱动（分镜：选哪个模板、改哪些参数、播放头停在哪），也可以自己播（首屏：自动轮换）。
import { AllayLoader } from '@allay/mascot';
import { Skeleton } from '@allay/ui/components/misc';
import { localize, type ParamValues } from '@allay/template-sdk';
import { Pause, Play } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TemplateEntry } from '../../../../desktop/src/shared/templates';
import { mcGameVersion } from '../../host/mc-pack';
import { builtinEntries } from '../../host/templates';
import { usePrefs } from '../prefs';
import type { LivePreview, LiveState } from '../engine/runtime';

export interface LiveViewerControl {
  /** 外面选中的模板（分镜第一步） */
  templateId?: string | null;
  /** 覆盖的参数（分镜第二步） */
  params?: ParamValues | null;
  /** 播放头停在整段的这个比例上（0–1）；null 时照常播放（分镜第三步：渲染到第几帧） */
  scrub?: number | null;
}

interface Props {
  /** 自动轮换模板（首屏）；用户点了任何一个就停 */
  autoCycle?: boolean;
  /** 时间轴可拖 */
  scrubbable?: boolean;
  testId?: string;
  initialId?: string;
  control?: LiveViewerControl;
  /** 用户自己点了模板 */
  onPick?: (id: string) => void;
  /** 窄屏上不显示面板下方的素材说明（分镜里钉在顶上的面板要尽量矮；说明在仿真器一节的面板里照样有） */
  noteHiddenOnNarrow?: boolean;
  className?: string;
}

type Status = 'starting' | 'ready' | 'unsupported' | 'failed';

const STAGE_COLORS = ['var(--stage-enter)', 'var(--stage-hold)', 'var(--stage-exit)'];

export function LiveViewer({ autoCycle = false, scrubbable = false, testId, initialId, control, onPick, noteHiddenOnNarrow = false, className }: Props) {
  const { t } = useTranslation();
  const { language } = usePrefs();
  const entries = useMemo(() => builtinEntries(), []);
  const [index, setIndex] = useState(() => Math.max(0, entries.findIndex((e) => e.id === (initialId ?? 'allay.builtin.block-wipe'))));
  const [status, setStatus] = useState<Status>('starting');
  const [state, setState] = useState<LiveState>({ duration: 1, cutTime: null, time: 0, playing: true });
  const cycling = useRef(autoCycle);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<LivePreview | null>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const chipsRef = useRef<HTMLDivElement>(null);
  const entry: TemplateEntry | undefined = entries[index];

  // 引擎：懒加载 runtime（three 和引擎在单独的代码块里），挂到画布上
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let live: LivePreview | null = null;
    void (async () => {
      const rt = await import('../engine/runtime');
      if (disposed) return;
      if (!rt.hasWebgl2()) {
        setStatus('unsupported');
        return;
      }
      try {
        live = await rt.LivePreview.create(canvas);
      } catch (error) {
        console.warn('[live] engine failed to start', error);
        if (!disposed) setStatus('failed');
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
        // 播放头每帧走：直接写 transform，不触发 React 重渲染
        const p = s.duration > 0 ? Math.min(1, s.time / s.duration) : 0;
        if (playheadRef.current) playheadRef.current.style.transform = `translateX(${(p * 100).toFixed(3)}%)`;
        if (timeRef.current) timeRef.current.textContent = `${Math.min(s.time, s.duration).toFixed(2)} / ${s.duration.toFixed(2)} s`;
        setState((prev) => (prev.duration === s.duration && prev.playing === s.playing && prev.cutTime === s.cutTime ? prev : s));
      });
      const stage = stageRef.current;
      if (stage) {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        live.resize(stage.clientWidth * dpr, stage.clientHeight * dpr);
      }
      setStatus('ready');
    })();
    return () => {
      disposed = true;
      liveRef.current = null;
      live?.dispose();
    };
  }, [entries.length]);

  // 外面选了模板
  const controlledId = control?.templateId ?? null;
  useEffect(() => {
    if (!controlledId) return;
    const i = entries.findIndex((e) => e.id === controlledId);
    if (i >= 0) {
      cycling.current = false;
      setIndex(i);
    }
  }, [controlledId, entries]);

  // 换模板、换语言（带文字的模板跟着换）。参数覆盖在装载时一并带上
  const overridesRef = useRef<ParamValues | null>(null);
  overridesRef.current = control?.params ?? null;
  useEffect(() => {
    const live = liveRef.current;
    if (status !== 'ready' || !live || !entry) return;
    void live.show(entry, language, overridesRef.current ?? undefined).catch((error: unknown) => console.warn('[live] load failed', error));
  }, [status, entry, language]);

  // 参数变了（分镜第二步）：走 setParams，和应用里拖属性面板一样
  const paramsKey = control?.params ? JSON.stringify(control.params) : '';
  useEffect(() => {
    const live = liveRef.current;
    if (status !== 'ready' || !live || !paramsKey) return;
    if (live.templateId !== entry?.id) return;
    live.setParams(JSON.parse(paramsKey) as ParamValues);
  }, [status, paramsKey, entry?.id]);

  // 播放头由外面定（分镜第三步）
  const scrub = control?.scrub ?? null;
  useEffect(() => {
    const live = liveRef.current;
    if (status !== 'ready' || !live) return;
    if (scrub === null) {
      if (!live.userPaused) live.setPlaying(true);
      return;
    }
    live.setPlaying(false);
    live.seek(scrub * state.duration);
  }, [status, scrub, state.duration]);

  // 画布尺寸跟着面板走；不在视口里不画
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || status !== 'ready') return;
    const ro = new ResizeObserver(() => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      liveRef.current?.resize(stage.clientWidth * dpr, stage.clientHeight * dpr);
    });
    ro.observe(stage);
    const io = new IntersectionObserver((es) => liveRef.current?.setVisible(es.some((e) => e.isIntersecting)));
    io.observe(stage);
    return () => {
      ro.disconnect();
      io.disconnect();
    };
  }, [status]);

  // 选中的模板按钮滚进工具条可见处（模板多了以后工具条可以横向滑）
  useEffect(() => {
    const bar = chipsRef.current;
    const chip = bar?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!bar || !chip) return;
    const left = chip.offsetLeft - bar.clientWidth / 2 + chip.clientWidth / 2;
    bar.scrollTo({ left, behavior: document.documentElement.dataset.reducedMotion === 'true' ? 'auto' : 'smooth' });
  }, [index]);

  const pick = (i: number) => {
    cycling.current = false;
    setIndex(i);
    const id = entries[i]?.id;
    if (id) onPick?.(id);
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

  const scrubTo = (clientX: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const live = liveRef.current;
    if (!live) return;
    cycling.current = false;
    live.setPlaying(false, true);
    live.seek(((clientX - r.left) / r.width) * state.duration);
  };

  const name = entry ? localize(entry.manifest.name, language) : '';
  const cutShare = state.cutTime !== null && state.duration > 0 ? state.cutTime / state.duration : null;

  return (
    <div className={`monitor p-2 sm:p-2.5 ${className ?? ''}`} data-testid={testId} data-status={status}>
      <div className="flex h-10 items-center gap-2.5 px-2.5 text-[13px]">
        <span className="relative flex size-2" aria-hidden="true">
          <span className="absolute inset-0 animate-ping rounded-full bg-primary opacity-60 motion-reduce:hidden" />
          <span className="relative size-2 rounded-full bg-primary" />
        </span>
        <span className="font-semibold">{t('site.hero.viewerLabel')}</span>
        <span className="truncate text-fg-muted" data-testid="live-template-name">
          {name}
        </span>
        <span className="t-mono ml-auto hidden text-[10.5px] text-fg-subtle sm:inline">1920 × 1080 · 60 fps</span>
      </div>

      <div ref={stageRef} className="preview-checker relative aspect-video w-full overflow-hidden rounded-[11px]" data-testid="live-stage">
        <canvas ref={canvasRef} className="absolute inset-0 size-full" aria-label={name || undefined} role="img" />
        {status === 'starting' && (
          <AllayLoader loading label={t('site.hero.starting')} priority="preview" className="absolute inset-0">
            <div className="flex size-full flex-col items-center justify-center gap-3">
              <Skeleton className="h-[52%] w-[56%]" />
              <span className="text-[12px] text-fg-subtle">{t('site.hero.starting')}</span>
            </div>
          </AllayLoader>
        )}
        {(status === 'unsupported' || status === 'failed') && <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-[13px] text-fg-muted">{t('site.hero.noWebgl')}</div>}
      </div>

      {/* 悬浮工具条：播放和模板切换 */}
      <div className="relative z-10 -mt-6 flex justify-center px-3">
        <div ref={chipsRef} className="float site-scroll-x flex max-w-full items-center gap-1 overflow-x-auto p-1" role="toolbar" aria-label={t('site.hero.pick')}>
          <button
            type="button"
            className="link-focus flex size-8 shrink-0 items-center justify-center rounded-md text-foreground transition-colors duration-150 hover:bg-control"
            aria-label={state.playing ? t('site.hero.pause') : t('site.hero.play')}
            data-testid="live-play"
            disabled={status !== 'ready'}
            onClick={() => liveRef.current?.setPlaying(!state.playing, true)}
          >
            {state.playing ? <Pause size={15} weight="fill" /> : <Play size={15} weight="fill" />}
          </button>
          <span className="mx-1 h-5 w-px shrink-0 bg-divider" aria-hidden="true" />
          {entries.map((e, i) => (
            <button
              key={e.id}
              type="button"
              aria-pressed={i === index}
              data-testid="live-chip"
              data-template={e.id}
              onClick={() => pick(i)}
              className={`link-focus h-8 shrink-0 rounded-md px-3 text-[12.5px] whitespace-nowrap transition-colors duration-150 ${
                i === index ? 'bg-control-hi font-medium text-foreground' : 'text-fg-muted hover:bg-control hover:text-foreground'
              }`}
            >
              {localize(e.manifest.name, language)}
            </button>
          ))}
        </div>
      </div>

      {/* 阶段轨：进入 / 停留 / 退出，播放头和剪辑点 */}
      <div className="px-1.5 pt-3.5 pb-1.5 sm:px-2.5">
        <div
          className={`relative ${scrubbable ? 'cursor-ew-resize touch-none' : ''}`}
          onPointerDown={
            scrubbable
              ? (ev) => {
                  const el = ev.currentTarget;
                  el.setPointerCapture(ev.pointerId);
                  scrubTo(ev.clientX, el);
                  const move = (m: PointerEvent) => scrubTo(m.clientX, el);
                  const up = () => {
                    el.removeEventListener('pointermove', move);
                    el.removeEventListener('pointerup', up);
                  };
                  el.addEventListener('pointermove', move);
                  el.addEventListener('pointerup', up);
                }
              : undefined
          }
          data-testid="live-timeline"
          aria-label={scrubbable ? t('site.hero.scrub') : undefined}
        >
          <div className="flex h-7 gap-[3px] rounded-[8px] bg-well p-[3px]">
            {segments.map((s, i) => (
              <div
                key={s.key}
                className="flex min-w-0 items-center justify-between overflow-hidden rounded-[5px] px-2 text-[11px] text-stage-foreground transition-[flex-grow] duration-300"
                style={{ flexGrow: s.share, flexBasis: 0, background: STAGE_COLORS[i % 3] }}
              >
                <span className="truncate">{s.label}</span>
                <span className="t-tab hidden opacity-80 sm:inline">{s.value.toFixed(2)}s</span>
              </div>
            ))}
          </div>
          {cutShare !== null && <span className="cut-mark !bottom-auto top-[-6px]" style={{ left: `${cutShare * 100}%` }} aria-hidden="true" />}
          <div className="pointer-events-none absolute inset-y-[-4px] left-0 right-0">
            <div ref={playheadRef} className="site-playhead absolute inset-y-0 left-0 w-full">
              <div className="absolute inset-y-0 left-0 w-[2px] -translate-x-1/2 rounded-full bg-primary" />
            </div>
          </div>
        </div>
        <div className={`mt-2 items-center justify-between gap-4 text-[11px] text-fg-subtle ${noteHiddenOnNarrow ? 'hidden lg:flex' : 'flex'}`}>
          <span data-testid="assets-note" className="line-clamp-2">
            {mcGameVersion ? t('site.hero.mcAssets', { version: mcGameVersion }) : t('site.hero.demoAssets')}
          </span>
          <span ref={timeRef} className="t-tab hidden shrink-0 sm:inline" />
        </div>
      </div>
    </div>
  );
}
