import { FilmStrip, Scissors, SpeakerSimpleHigh } from '@phosphor-icons/react';
import { cn } from 'cn';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '../components/ui/context-menu';
import { ICON, ICON_WEIGHT } from '../lib/icons';
import { trackEditorPointer } from './track-editor-pointer';
import { nearestCue, segmentAt, snapSegment } from './timeline-edit';

// Transport 的多轨时间轴（6.4）：左侧轨道名列，右侧每条轨道是一条凹槽圆角条。
// - 帧刻度（等宽数字）；
// - 阶段轨：按 timeline.segments 画出进入/停留/退出的圆角色块（名称与时长），段与段之间的分界线可以拖动
//   （改左边那一段的 duration 参数，受它的 min/max 限制，4.3）；
// - 音效轨：按模板的 audioCues 画竖条（只读）；没有 cue 时整条置灰；
// - 剪辑点轨：琥珀菱形加帧号；没有剪辑点（叠加层模板）时不显示这一轨；
// - 播放头：1.5 px 强调色竖线贯穿各轨，顶部是带当前帧号的小牌；整个轨道区可按下拖动（键盘：左右键逐帧、Shift 十帧、Home/End）。
// 一次拖动（分界线）只算一次连续操作：onGesture('start') … onGesture('end')。
//
// 拖动的做法（docs/decisions.md“时间轴拖动”）：
// - 按下时 setPointerCapture，并在 window 上听同一个 pointerId 的 move/up/cancel：被拖元素即使重渲染也不会丢掉这次拖动；
// - 位置一律按“按下时的起点 + 总位移”算（不累加增量），吸附到帧；
// - pointermove 只记下最新的 clientX，每个动画帧最多算一次、提交一次（松手时立即按松手的位置算最后一次）；
// - 拖分界线时比例尺（秒/像素）和整条时间轴的布局都冻结在按下时，分界线始终在指针下；改了时长之后、引擎报回新时长之前，
//   色段按各段之和布局，不会因为“各段之和 ≠ 时长”被短暂卸载（那会让分界线丢掉指针捕获和键盘焦点）。

export interface TimelineSegment {
  key: string;
  label: string;
  /** 这一段的时长（秒） */
  duration: number;
  min: number;
  max: number;
  defaultDuration?: number;
}

export interface TimelineTrackProps {
  duration: number;
  time: number;
  fps: number;
  /** 各段之和不等于 duration 时不画色段（4.3） */
  segments: readonly TimelineSegment[];
  readOnlySegments?: boolean;
  cutTime: number | null;
  /** 音效 cue 的时间（秒）；空数组表示这个模板没有音效 */
  cues: readonly number[];
  disabled?: boolean;
  labels: {
    scrub: string; cut: string; boundary(left: string, right: string): string; endHandle(label: string): string;
    stages: string; sound: string; cutTrack: string;
    stageStart(label: string): string; stageEnd(label: string): string; resetStage(label: string): string;
    goToFrame(time: string): string; goToCut: string; beforeCut: string; goToCue(time: string): string; audioToggle: string;
  };
  formatTime(t: number): string;
  onSeek(t: number): void;
  onSeekStart?(): void;
  onSegmentChange(key: string, duration: number): void;
  onGesture(phase: 'start' | 'end'): void;
  onToggleAudio?(): void;
}

const SEGMENT_COLORS = ['var(--stage-enter)', 'var(--stage-hold)', 'var(--stage-exit)', 'var(--cue)', 'var(--amethyst)'];
/** 刻度标签之间至少这么宽（px） */
const LABEL_SPACING = 44;
const LABEL_STEPS = [1, 2, 3, 5, 6, 10, 12, 15, 20, 30, 60, 120, 300, 600];

export function segmentsMatch(segments: readonly TimelineSegment[], duration: number): boolean {
  if (segments.length === 0) return false;
  const sum = segments.reduce((a, s) => a + s.duration, 0);
  return Math.abs(sum - duration) < 1e-6;
}

/** 改完分界线后，等引擎报回新时长最多这么久（毫秒）；超时仍不相等就按 4.3 只画总时长 */
const SETTLE_MS = 1500;

/**
 * 在 window 上跟踪一个指针直到松开或取消：被拖元素重渲染、甚至被替换也不影响这次拖动。
 * 返回取消跟踪的函数（不触发 onEnd）。
 */
function trackPointer(pointerId: number, onMove: (e: PointerEvent) => void, onEnd: (e: PointerEvent, canceled: boolean) => void): () => void {
  const move = (e: PointerEvent) => {
    if (e.pointerId === pointerId) onMove(e);
  };
  const up = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    stop();
    onEnd(e, e.type === 'pointercancel');
  };
  const stop = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
  return stop;
}

/** 拖动期间整个窗口用同一个光标、不选中文字；返回恢复函数 */
function lockCursor(cursor: string): () => void {
  const style = document.documentElement.style;
  const prev = { cursor: style.cursor, userSelect: style.userSelect };
  style.cursor = cursor;
  style.userSelect = 'none';
  return () => {
    style.cursor = prev.cursor;
    style.userSelect = prev.userSelect;
  };
}

function capture(el: Element, pointerId: number): void {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    // 合成事件的 pointerId 可能不是活动指针：window 上的跟踪照样有效
  }
}

interface ScrubDrag {
  left: number;
  width: number;
  lastX: number;
  last: number;
  raf: number;
  stop(): void;
}

interface BoundaryDrag {
  index: number;
  key: string;
  origin: number;
  from: number;
  min: number;
  max: number;
  secPerPx: number;
  fps: number;
  lastX: number;
  value: number;
  raf: number;
  stop(): void;
}

type Lane = 'phase' | 'audio' | 'cut';
type MenuTarget = { lane: Lane; time: number; segmentKey?: string };

function openLaneMenu(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  element.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
  }));
}

function menuKey(event: ReactKeyboardEvent<HTMLElement>) {
  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
  event.preventDefault();
  event.stopPropagation();
  openLaneMenu(event.currentTarget);
}

function TrackName({ icon, children, muted, row, lane, disabled }: { icon: ReactNode; children: ReactNode; muted?: boolean; row: number; lane: Lane; disabled?: boolean }) {
  return (
    <button type="button" className={cn('col-start-1 flex min-w-0 items-center gap-2 rounded-sm pl-3.5 text-fg-muted focus-visible:outline-2 focus-visible:outline-(--ring)', muted && 'text-fg-subtle')}
      style={{ gridRow: row }} data-timeline-lane={lane} disabled={disabled} aria-haspopup="menu" onKeyDown={menuKey} onClick={(event) => openLaneMenu(event.currentTarget)}>
      <span className="shrink-0 text-fg-faint">{icon}</span>
      <span className="truncate">{children}</span>
    </button>
  );
}

export function TimelineTrack(props: TimelineTrackProps) {
  const { duration, time, fps, segments, cutTime, cues, disabled, labels, formatTime, onSeek, onSeekStart, onSegmentChange, onGesture, onToggleAudio } = props;
  const gridRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  const [menuTarget, setMenuTarget] = useState<MenuTarget | null>(null);
  const [width, setWidth] = useState(0);
  /** 正在拖的分界线：它的值和按下时冻结的总时长（整条时间轴按它布局，分界线才会停在指针下） */
  const [boundaryView, setBoundaryView] = useState<{ index: number; value: number; view: number } | null>(null);
  /** 改了分界线、引擎还没报回新时长：期望的各段之和（这段时间色段按它布局，不卸载） */
  const [settling, setSettling] = useState<number | null>(null);
  const scrubRef = useRef<ScrubDrag | null>(null);
  const boundaryRef = useRef<BoundaryDrag | null>(null);
  const settleTimer = useRef(0);
  /** window 上的监听在下一次渲染之后才触发：从这里读最新的 props */
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });

  const shownSegments = boundaryView ? segments.map((s, i) => (i === boundaryView.index ? { ...s, duration: boundaryView.value } : s)) : segments;
  const segmentSum = shownSegments.reduce((a, s) => a + s.duration, 0);
  const isSettling = settling !== null && Math.abs(segmentSum - settling) < 1e-6;
  const showSegments = boundaryView !== null || isSettling || segmentsMatch(segments, duration);
  const hasEndHandle = showSegments && segments.length > 0 && segments.at(-1)!.max > segments.at(-1)!.min;
  /** 布局用的总时长：拖分界线时冻结在按下时，等引擎报回新时长时用各段之和，其余时候就是时长 */
  const view = boundaryView ? boundaryView.view : isSettling ? segmentSum : duration;
  const frameCount = Math.max(1, Math.round(duration * fps) + 1);
  const lastFrame = frameCount - 1;
  const frame = Math.min(lastFrame, Math.round(time * fps));
  const viewLastFrame = Math.max(0, Math.round(view * fps));
  const pct = (t: number) => (view > 0 ? `${(Math.min(view, Math.max(0, t)) / view) * 100}%` : '0%');
  const draggingEnd = hasEndHandle && boundaryView?.index === segments.length - 1;
  const phasePct = (t: number) => draggingEnd && view > 0 ? `${t / view * 100}%` : pct(t);
  const snap = (t: number) => Math.round(t * fps) / fps;

  useLayoutEffect(() => {
    const el = lanesRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.getBoundingClientRect().width));
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  // 卸载时结束进行中的拖动（否则撤销记录会一直暂停）
  useEffect(
    () => () => {
      window.clearTimeout(settleTimer.current);
      const s = scrubRef.current;
      if (s) {
        cancelAnimationFrame(s.raf);
        s.stop();
      }
      const b = boundaryRef.current;
      if (b) {
        cancelAnimationFrame(b.raf);
        b.stop();
        latest.current.onGesture('end');
      }
    },
    [],
  );

  /** 改了分界线：等引擎报回新时长期间，色段按期望的各段之和布局 */
  const expectSum = (key: string, value: number) => {
    const sum = latest.current.segments.reduce((a, s) => a + (s.key === key ? value : s.duration), 0);
    setSettling(sum);
    window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => setSettling(null), SETTLE_MS);
  };

  // ---- 播放头（拖动擦洗）----
  const scrubTime = (d: ScrubDrag, clientX: number) => {
    const { duration: dur, fps: f } = latest.current;
    const x = d.width > 0 ? Math.min(1, Math.max(0, (clientX - d.left) / d.width)) : 0;
    return Math.min(dur, Math.round(x * dur * f) / f);
  };
  const scrubTo = (d: ScrubDrag, clientX: number) => {
    const t = scrubTime(d, clientX);
    if (t === d.last) return;
    d.last = t;
    latest.current.onSeek(t);
  };
  const onTrackDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || duration <= 0 || e.button !== 0 || scrubRef.current || boundaryRef.current) return;
    capture(e.currentTarget, e.pointerId);
    // 比例尺在按下时量一次，拖动中不再读布局
    const rect = lanesRef.current!.getBoundingClientRect();
    const unlock = lockCursor('pointer');
    const d: ScrubDrag = {
      left: rect.left,
      width: rect.width,
      lastX: e.clientX,
      last: Number.NaN,
      raf: 0,
      stop: () => undefined,
    };
    const stopTracking = trackPointer(
      e.pointerId,
      (ev) => {
        d.lastX = ev.clientX;
        if (d.raf === 0)
          d.raf = requestAnimationFrame(() => {
            d.raf = 0;
            scrubTo(d, d.lastX);
          });
      },
      (ev, canceled) => {
        cancelAnimationFrame(d.raf);
        d.raf = 0;
        if (!canceled) scrubTo(d, ev.clientX);
        else scrubTo(d, d.lastX);
        d.stop();
      },
    );
    d.stop = () => {
      stopTracking();
      unlock();
      if (scrubRef.current === d) scrubRef.current = null;
    };
    scrubRef.current = d;
    onSeekStart?.();
    scrubTo(d, e.clientX);
  };
  const onTrackKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const step = (e.shiftKey ? 10 : 1) / fps;
    if (e.key === 'ArrowRight') onSeek(Math.min(duration, snap(time + step)));
    else if (e.key === 'ArrowLeft') onSeek(Math.max(0, snap(time - step)));
    else if (e.key === 'Home') onSeek(0);
    else if (e.key === 'End') onSeek(duration);
    else return;
    e.preventDefault();
    e.stopPropagation();
    onSeekStart?.();
  };

  // ---- 分界线 ----
  let acc = 0;
  const bounds = shownSegments.map((s) => (acc += s.duration));
  const applyBoundary = (d: BoundaryDrag, next: number) => {
    if (next === d.value) return;
    d.value = next;
    setBoundaryView((v) => (v ? { ...v, value: next } : v));
    latest.current.onSegmentChange(d.key, next);
  };
  const boundaryTo = (d: BoundaryDrag, clientX: number) => {
    const value = clientX === d.origin ? d.from : snapSegment(d.from + (clientX - d.origin) * d.secPerPx, d.fps, d.min, d.max);
    applyBoundary(d, value);
  };
  const onBoundaryDown = (index: number) => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return;
    e.stopPropagation();
    if (scrubRef.current || boundaryRef.current) return;
    const seg = segments[index]!;
    const rect = lanesRef.current!.getBoundingClientRect();
    if (rect.width <= 0 || view <= 0) return;
    e.currentTarget.focus({ preventScroll: true });
    const unlock = lockCursor('ew-resize');
    const d: BoundaryDrag = {
      index,
      key: seg.key,
      origin: e.clientX,
      from: seg.duration,
      min: seg.min,
      max: seg.max,
      secPerPx: view / rect.width,
      fps,
      lastX: e.clientX,
      value: seg.duration,
      raf: 0,
      stop: () => undefined,
    };
    const stopTracking = trackEditorPointer(
      e.currentTarget,
      e.pointerId,
      (ev) => {
        d.lastX = ev.clientX;
        if (d.raf === 0)
          d.raf = requestAnimationFrame(() => {
            d.raf = 0;
            boundaryTo(d, d.lastX);
          });
      },
      (ev) => {
        cancelAnimationFrame(d.raf);
        d.raf = 0;
        if (ev) boundaryTo(d, ev.clientX);
        else applyBoundary(d, d.from);
        d.stop();
        expectSum(d.key, d.value);
        setBoundaryView(null);
        latest.current.onGesture('end');
      },
    );
    d.stop = () => {
      stopTracking();
      unlock();
      if (boundaryRef.current === d) boundaryRef.current = null;
    };
    boundaryRef.current = d;
    setBoundaryView({ index, value: seg.duration, view });
    onGesture('start');
  };
  const onBoundaryKey = (index: number) => (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled || boundaryRef.current) return;
    menuKey(e);
    const seg = segments[index]!;
    const step = (e.shiftKey ? 10 : 1) / fps;
    let next: number;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = seg.duration + step;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = seg.duration - step;
    else if (index === segments.length - 1 && e.key === 'Home') next = seg.min;
    else if (index === segments.length - 1 && e.key === 'End') next = seg.max;
    else return;
    e.preventDefault();
    e.stopPropagation();
    const value = e.key === 'Home' || e.key === 'End' ? next : snapSegment(next, fps, seg.min, seg.max);
    if (value === seg.duration) return;
    expectSum(seg.key, value);
    onSegmentChange(seg.key, value);
  };

  // ---- 刻度：标签步长让标签之间至少隔 LABEL_SPACING（按布局用的总时长）----
  const pxPerFrame = viewLastFrame > 0 ? width / viewLastFrame : 0;
  const labelStep = LABEL_STEPS.find((s) => s * pxPerFrame >= LABEL_SPACING) ?? Math.max(1, viewLastFrame);
  const minorStep = labelStep % 2 === 0 ? labelStep / 2 : labelStep;
  const ticks: { f: number; label: boolean }[] = [];
  if (width > 0 && viewLastFrame > 0) for (let f = 0; f <= viewLastFrame; f += minorStep) ticks.push({ f, label: f % labelStep === 0 });

  const hasCut = cutTime !== null && duration > 0;
  const cutFrame = hasCut ? Math.round(cutTime * fps) : 0;
  const rows = ['24px', '40px', '30px', ...(hasCut ? ['30px'] : [])].join(' ');
  const seek = (target: number) => {
    onSeekStart?.();
    onSeek(Math.min(duration, Math.max(0, target)));
  };
  const selectedIndex = menuTarget?.lane === 'phase' && showSegments ? segments.findIndex((segment) => segment.key === menuTarget.segmentKey) : -1;
  const selected = segments[selectedIndex];
  const cue = menuTarget?.lane === 'audio' ? nearestCue(cues, menuTarget.time) : undefined;

  return (
    <ContextMenu disabled={disabled} onOpenChange={(open, details) => {
      if (!open) return;
      const event = details.event;
      const point = event instanceof MouseEvent ? event : event instanceof TouchEvent ? event.touches[0] : undefined;
      const rect = lanesRef.current?.getBoundingClientRect();
      if (!point || !rect || !rect.width || boundaryRef.current) return details.cancel();
      const target = event.target instanceof Element ? event.target : null;
      const hit = Array.from(gridRef.current?.querySelectorAll<HTMLElement>('[data-timeline-lane]') ?? []).find((element) => {
        const laneRect = element.getBoundingClientRect();
        return point.clientY >= laneRect.top && point.clientY < laneRect.bottom;
      });
      if (!hit) return details.cancel();
      const lane = hit.dataset.timelineLane as Lane;
      const at = point.clientX < rect.left ? time : Math.max(0, Math.min(view, (point.clientX - rect.left) / rect.width * view));
      const key = target?.closest<HTMLElement>('[data-timeline-segment]')?.dataset.timelineSegment;
      setMenuTarget({ lane, time: at, segmentKey: key ?? shownSegments[segmentAt(bounds, at)]?.key });
    }}>
    <ContextMenuTrigger ref={gridRef} className={cn('grid min-h-0 flex-1 gap-y-1 pr-3 pb-3 select-none', hasEndHandle ? 'grid-cols-[124px_minmax(0,1fr)_clamp(48px,12%,112px)]' : 'grid-cols-[124px_minmax(0,1fr)]', draggingEnd && 'overflow-clip')}
      style={{ gridTemplateRows: rows }} data-testid="timeline">
      {/* 轨道区（右列）：刻度、各轨和覆盖其上的拖动层、播放头都以它为坐标 */}
      <div ref={lanesRef} className="group/track relative col-start-2 row-span-full row-start-1 min-w-0">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-6 num text-2xs text-fg-subtle" aria-hidden="true">
          {ticks.map(({ f, label }) =>
            label ? (
              <span key={f} className="absolute top-0.5 -translate-x-1/2" style={{ left: pct(f / fps) }}>
                {f}
              </span>
            ) : (
              <span key={f} className="absolute bottom-0 h-[5px] w-px bg-control-hi" style={{ left: pct(f / fps) }} />
            ),
          )}
        </div>
      </div>

      <TrackName row={2} lane="phase" disabled={disabled} icon={<FilmStrip size={ICON.sm} weight={ICON_WEIGHT.active} />}>{labels.stages}</TrackName>
      {hasEndHandle && <div className="pointer-events-none col-start-3 row-start-2 rounded-r-lg border border-dashed border-divider bg-well/40" data-testid="timeline-end-room" />}
      {/* 拖分界线时布局冻结，各段之和可能超出轨道：超出的部分裁掉 */}
      <div className={cn('relative col-start-2 row-start-2 rounded-lg bg-well', !draggingEnd && 'overflow-hidden')}>
        {showSegments &&
          shownSegments.map((s, i) => {
            const first = i === 0;
            const last = i === shownSegments.length - 1;
            // 窄的色块（停留）只居中显示名称；再窄就什么都不写
            const px = view > 0 ? (s.duration / view) * width : 0;
            const narrow = px < 110;
            const seconds = props.readOnlySegments ? s.duration.toFixed(3).replace(/0$/, '') : s.duration.toFixed(2);
            return (
              <div
                key={s.key}
                data-testid={`timeline-segment-${s.key}`}
                title={props.readOnlySegments ? `${s.label} · ${seconds} s` : s.label}
                data-duration={s.duration}
                className={cn('pointer-events-none absolute inset-y-[3px] flex min-w-0 items-center gap-2 overflow-hidden rounded-md font-medium text-stage-foreground', narrow ? 'justify-center px-2' : 'px-3')}
                style={{
                  left: first ? 0 : `calc(${phasePct(bounds[i]! - s.duration)} + 1px)`,
                  width: `calc(${phasePct(s.duration)} - ${first || last ? 1 : 2}px)`,
                  background: SEGMENT_COLORS[i % SEGMENT_COLORS.length],
                }}
              >
                {!props.readOnlySegments && <span className="absolute inset-y-[9px] left-1 w-[3px] rounded-full bg-stage-foreground/55" />}
                {!props.readOnlySegments && <span className="absolute inset-y-[9px] right-1 w-[3px] rounded-full bg-stage-foreground/55" />}
                {px >= 36 && <span className="truncate">{s.label}</span>}
                {!narrow && <span className="shrink-0 num font-normal opacity-75">{seconds} s</span>}
              </div>
            );
          })}
      </div>

      <TrackName row={3} lane="audio" disabled={disabled} icon={<SpeakerSimpleHigh size={ICON.sm} weight={ICON_WEIGHT.active} />} muted={cues.length === 0}>
        {labels.sound}
      </TrackName>
      <div className={cn('relative col-start-2 row-start-3 rounded-lg bg-well', cues.length === 0 && 'opacity-50')} data-testid="timeline-cues">
        {cues.map((c, i) => (
          <span key={i} className="pointer-events-none absolute inset-y-[9px] w-[3px] -translate-x-1/2 rounded-full bg-cue" style={{ left: pct(c) }} />
        ))}
      </div>

      {hasCut && (
        <>
          <TrackName row={4} lane="cut" disabled={disabled} icon={<Scissors size={ICON.sm} weight={ICON_WEIGHT.active} />}>{labels.cutTrack}</TrackName>
          <div className="relative col-start-2 row-start-4 rounded-lg bg-well">
            <div className="pointer-events-none absolute top-[9px] flex items-center" style={{ left: pct(cutTime) }} title={labels.cut} data-testid="timeline-cut">
              <span className="block size-[11px] -translate-x-1/2 rotate-45 rounded-[2px] bg-mark" />
              <span className="ml-1.5 num text-xs text-mark">{cutFrame}</span>
              <span className="sr-only">{labels.cut}</span>
            </div>
          </div>
        </>
      )}

      {/* 拖动层与播放头：覆盖轨道区（刻度以下所有轨） */}
      <div className="pointer-events-none relative col-start-2 row-span-full row-start-1">
        <div
          data-testid="transport-track"
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-label={labels.scrub}
          aria-valuemin={0}
          aria-valuemax={lastFrame}
          aria-valuenow={frame}
          aria-valuetext={formatTime(time)}
          aria-disabled={disabled}
          className="pointer-events-auto absolute inset-0 cursor-pointer touch-none rounded-lg outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)"
          onPointerDown={onTrackDown}
          onKeyDown={onTrackKey}
        />
        {/* 命中区落在阶段轨上 */}
        {showSegments && !props.readOnlySegments &&
          shownSegments.slice(0, hasEndHandle ? undefined : -1).map((s, i) => (
            <div
              key={`b-${s.key}`}
              role="slider"
              tabIndex={disabled ? -1 : 0}
              aria-label={shownSegments[i + 1] ? labels.boundary(s.label, shownSegments[i + 1]!.label) : labels.endHandle(s.label)}
              aria-valuemin={s.min}
              aria-valuemax={s.max}
              aria-valuenow={s.duration}
              aria-valuetext={`${s.duration.toFixed(2)} s`}
              data-testid={shownSegments[i + 1] ? `timeline-boundary-${i}` : 'timeline-exit-end'}
              data-timeline-segment={s.key}
              className={cn('pointer-events-auto absolute top-7 z-10 h-10 w-3 -translate-x-1/2 cursor-ew-resize touch-none rounded-sm outline-none focus-visible:outline-2 focus-visible:outline-(--ring)', !shownSegments[i + 1] && 'z-30 grid w-6 place-items-center')}
              style={{ left: phasePct(bounds[i]!) }}
              onPointerDown={onBoundaryDown(i)}
              onKeyDown={onBoundaryKey(i)}
            >{!shownSegments[i + 1] && <span className="pointer-events-none h-5 w-1 rounded-full bg-stage-foreground outline-2 outline-stage-exit" />}</div>
          ))}
        <div className="absolute inset-y-0 z-20 w-0" style={{ left: phasePct(time) }} data-testid="timeline-playhead">
          <span className="absolute top-[22px] bottom-0 -left-[0.75px] w-[1.5px] bg-primary" />
          <span data-testid="timeline-playhead-frame" className="absolute top-0.5 left-0 -translate-x-1/2 rounded-[5px] bg-primary px-1.5 py-0.5 num text-2xs font-medium text-primary-foreground">
            {frame}
          </span>
        </div>
      </div>
    </ContextMenuTrigger>
    {menuTarget && <ContextMenuContent data-testid="timeline-context-menu">
      {selected ? <>
        <ContextMenuItem onClick={() => seek(bounds[selectedIndex - 1] ?? 0)}>{labels.stageStart(selected.label)}</ContextMenuItem>
        <ContextMenuItem onClick={() => seek(bounds[selectedIndex]!)}>{labels.stageEnd(selected.label)}</ContextMenuItem>
        {!props.readOnlySegments && selected.defaultDuration !== undefined && <>
          <ContextMenuSeparator />
          <ContextMenuItem disabled={selected.duration === selected.defaultDuration} onClick={() => {
            expectSum(selected.key, selected.defaultDuration!);
            onSegmentChange(selected.key, selected.defaultDuration!);
          }}>{labels.resetStage(selected.label)}</ContextMenuItem>
        </>}
      </> : menuTarget.lane === 'cut' && hasCut ? <>
        <ContextMenuItem onClick={() => seek(cutTime)}>{labels.goToCut}</ContextMenuItem>
        <ContextMenuItem disabled={cutFrame === 0} onClick={() => seek((cutFrame - 1) / fps)}>{labels.beforeCut}</ContextMenuItem>
      </> : <ContextMenuItem onClick={() => seek(cue ?? snap(menuTarget.time))}>
        {cue !== undefined ? labels.goToCue(formatTime(snap(cue))) : labels.goToFrame(formatTime(snap(menuTarget.time)))}
      </ContextMenuItem>}
      {menuTarget.lane === 'audio' && onToggleAudio && <ContextMenuItem onClick={onToggleAudio}>{labels.audioToggle}</ContextMenuItem>}
    </ContextMenuContent>}
    </ContextMenu>
  );
}

export function timelineFrameLabel(frame: number, total: number): string {
  return `F${frame}/${Math.max(0, total - 1)}`;
}
