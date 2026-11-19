import { type Composition, type CompositionClip, type CompositionTrack } from '@allay/template-sdk';
import { Button } from '@allay/ui/components/button';
import { cn } from '@allay/ui/lib/utils';
import { Lock, LockOpen, SpeakerHigh, SpeakerSlash } from '@phosphor-icons/react';
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { TemplateEntry } from '../../../shared/templates';
import { useProjectStore } from '../../stores/projectStore';
import { useTransportStore } from '../../stores/transportStore';
import { describeClip } from './clipPresentation';
import { clampFrame, type Selection } from './edits';
import { useStudioLabels } from './labels';

export function seekFrame(doc: Composition, frame: number): void {
  const transport = useTransportStore.getState();
  const duration = doc.durationFrames / doc.fps;
  if (transport.duration !== duration) transport.setTimeline(duration, null);
  if (transport.playing) transport.setPlaying(false);
  const time = clampFrame(frame, 0, doc.durationFrames - 1) / doc.fps;
  if (transport.time !== time) transport.setTime(time);
}

export function useStudioFrame({ fps, durationFrames }: Composition): number {
  return useTransportStore((state) => clampFrame(state.time * fps, 0, durationFrames - 1));
}

export function templateKey(ref: CompositionClip['template']): string {
  return `${ref.id}@${ref.version}`;
}

const RULER_STEPS = [1, 2, 3, 5, 6, 10, 12, 15, 20, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200, 18000];
const columns = 'grid grid-cols-[144px_minmax(0,1fr)] gap-x-1.5';
const percent = (frame: number, total: number) => `${100 * frame / total}%`;

type DragMode = 'move' | 'start' | 'end';
type Drag = { mode: DragMode; origin: number; width: number; frame: number; pointer: number };

function ClipBar({ clip, track, total, presentation, selected, onSelect, onDrag }: {
  clip: CompositionClip; track: CompositionTrack; total: number; presentation: ReturnType<typeof describeClip>; selected: boolean;
  onSelect: () => void; onDrag: (mode: DragMode, frame: number) => void;
}) {
  const { name, icon: Icon, audio } = presentation;
  const text = `${name} · ${clip.startFrame}–${clip.startFrame + clip.durationFrames - 1}`;
  const drag = useRef<Drag | null>(null);
  const [visualDrag, setVisualDrag] = useState<{ mode: DragMode; delta: number } | null>(null);
  function pointerDown(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || track.locked || drag.current) return;
    const bar = event.currentTarget;
    const rect = bar.getBoundingClientRect();
    const width = bar.parentElement?.getBoundingClientRect().width ?? 0;
    if (!width) return;
    const edge = rect.width >= 32 ? 6 : 0;
    const mode = event.clientX - rect.left < edge ? 'start' : rect.right - event.clientX < edge ? 'end' : 'move';
    drag.current = { mode, origin: event.clientX, width, frame: mode === 'end' ? clip.startFrame + clip.durationFrames : clip.startFrame, pointer: event.pointerId };
    bar.setPointerCapture(event.pointerId);
  }
  function deltaAt(event: PointerEvent, current: Drag): number {
    if (Math.abs(event.clientX - current.origin) < 3) return 0;
    const change = (event.clientX - current.origin) * total / current.width;
    if (current.mode === 'start') return clampFrame(change, -Math.min(clip.startFrame, clip.sourceInFrame), clip.durationFrames - 1);
    if (current.mode === 'end') return clampFrame(change, 1 - clip.durationFrames, total - current.frame);
    return clampFrame(change, -clip.startFrame, total - clip.startFrame - clip.durationFrames);
  }
  function finish(event: PointerEvent<HTMLButtonElement>, commit: boolean) {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    drag.current = null;
    setVisualDrag(null);
    if (!commit) return;
    const change = deltaAt(event, current);
    if (change) onDrag(current.mode, current.frame + change);
  }
  const mode = visualDrag?.mode;
  const delta = visualDrag?.delta ?? 0;
  const start = clip.startFrame + (mode === 'end' ? 0 : delta);
  const duration = clip.durationFrames + (mode === 'start' ? -delta : mode === 'end' ? delta : 0);
  const keyframeOffset = mode === 'start' ? delta : 0;
  return (
    <button type="button" aria-label={text} title={text} aria-pressed={selected} data-testid="studio-clip"
      className="group absolute inset-y-0.5 flex min-w-px touch-none select-none items-center overflow-hidden rounded-lg bg-control text-left text-xs text-foreground hover:bg-control-hi aria-pressed:z-10 aria-pressed:bg-primary-soft aria-pressed:ring-1 aria-pressed:ring-inset aria-pressed:ring-primary focus-visible:z-10"
      style={{ left: percent(start, total), width: percent(duration, total), maxWidth: `calc(100% - ${percent(start, total)})`, cursor: track.locked ? 'pointer' : mode ? 'grabbing' : 'grab' }}
      onClick={onSelect} onPointerDown={pointerDown} onPointerMove={(event) => {
        if (drag.current?.pointer === event.pointerId) setVisualDrag({ mode: drag.current.mode, delta: deltaAt(event, drag.current) });
      }} onPointerUp={(event) => finish(event, true)} onPointerCancel={(event) => finish(event, false)} onLostPointerCapture={(event) => finish(event, false)}>
      <Icon aria-hidden="true" size={13} weight="fill" className={cn('mr-1.5 ml-2 shrink-0', audio ? 'text-cue' : 'text-fg-muted')} />
      <span className="min-w-0 truncate pr-1.5">{name}</span>
      {!track.locked && <>
        <span aria-hidden="true" className="absolute inset-y-2 left-0.5 w-1 cursor-ew-resize rounded-sm bg-fg-faint opacity-0 group-hover:opacity-100" />
        <span aria-hidden="true" className="absolute inset-y-2 right-0.5 w-1 cursor-ew-resize rounded-sm bg-fg-faint opacity-0 group-hover:opacity-100" />
      </>}
      {clip.keyframes?.filter((point) => point.frame >= keyframeOffset && point.frame - keyframeOffset < duration).map((point) => (
        <span key={point.frame} aria-hidden="true" data-testid="studio-keyframe" className="pointer-events-none absolute bottom-0.5 size-1.5 -translate-x-1/2 rotate-45 bg-mark"
          style={{ left: `clamp(4px, ${percent(point.frame - keyframeOffset, duration)}, calc(100% - 4px))` }} />
      ))}
    </button>
  );
}

function RulerReadout({ doc, width }: { doc: Composition; width: number }) {
  const frame = useStudioFrame(doc);
  const total = doc.durationFrames;
  const major = RULER_STEPS.find((step) => step * width / total >= 44) ?? total;
  const minor = major % 2 === 0 ? major / 2 : major;
  return <>
    {Array.from({ length: Math.ceil(total / minor) }, (_, index) => {
      const tick = index * minor;
      const showLabel = tick % major === 0 && (tick === 0 || (1 - tick / total) * width >= 18);
      return <span key={tick} aria-hidden="true" className="pointer-events-none absolute inset-y-0" style={{ left: percent(tick, total) }}>
        {showLabel && <span className={cn('num absolute top-0.5 text-2xs text-fg-subtle', tick !== 0 && '-translate-x-1/2')}>{tick}</span>}
        <span className={cn('absolute bottom-0 w-px bg-divider', showLabel ? 'h-2' : 'h-1')} />
      </span>;
    })}
    <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 z-10 w-px bg-primary" style={{ left: percent(frame, total) }} />
    <span aria-hidden="true" className="num pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-sm bg-primary px-1 text-2xs text-primary-foreground"
      style={{ left: `clamp(21px, ${percent(frame, total)}, calc(100% - 21px))` }}>{frame}</span>
  </>;
}

function LanePlayhead({ doc }: { doc: Composition }) {
  const frame = useStudioFrame(doc);
  return <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 z-20 w-px bg-primary" style={{ left: percent(frame, doc.durationFrames) }} />;
}

function ScrubTarget({ doc }: { doc: Composition }) {
  const { t } = useTranslation();
  const frame = useStudioFrame(doc);
  return <div role="slider" tabIndex={0} aria-label={t('transport.scrub')} aria-valuemin={0} aria-valuemax={doc.durationFrames - 1} aria-valuenow={frame}
    data-testid="studio-scrub" className="absolute inset-0 z-20 rounded-sm"
    onKeyDown={(event) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const step = event.shiftKey ? 10 : 1;
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? doc.durationFrames - 1
        : event.key === 'ArrowRight' || event.key === 'ArrowUp' ? frame + step
          : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? frame - step : undefined;
      if (next === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      seekFrame(doc, next);
    }} />;
}

export function StudioTimeline({ doc, entries, selection, select, onTrack, onDrag }: {
  doc: Composition; entries: Map<string, TemplateEntry>; selection: Selection | null; select: (value: Selection | null) => void;
  onTrack: (id: string, edit: (track: CompositionTrack) => CompositionTrack | null) => void;
  onDrag: (selection: Selection, mode: DragMode, frame: number) => void;
}) {
  const label = useStudioLabels();
  const { i18n } = useTranslation();
  const fileNames = useProjectStore((state) => state.fileNames);
  const ruler = useRef<HTMLDivElement>(null);
  const scrub = useRef<{ pointer: number; rect: DOMRect; x: number; raf: number } | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ruler.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => { if (entry) setWidth(entry.contentRect.width); });
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (scrub.current) cancelAnimationFrame(scrub.current.raf);
    };
  }, []);

  function seek(x: number, rect: DOMRect) {
    seekFrame(doc, (x - rect.left) * doc.durationFrames / rect.width);
  }
  function finish(event: PointerEvent<HTMLDivElement>, commit: boolean) {
    const drag = scrub.current;
    if (drag?.pointer !== event.pointerId) return;
    cancelAnimationFrame(drag.raf);
    scrub.current = null;
    if (commit) seek(event.clientX, drag.rect);
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto px-3 pb-3" onPointerDown={(event) => {
      if (event.button !== 0 || scrub.current || !(event.target instanceof Element) || !event.target.closest('[data-studio-lane]') || event.target.closest('button')) return;
      const rect = ruler.current?.getBoundingClientRect();
      if (!rect?.width) return;
      event.preventDefault();
      if (!ruler.current?.contains(event.target)) select(null);
      ruler.current?.querySelector<HTMLElement>('[role=slider]')?.focus({ preventScroll: true });
      event.currentTarget.setPointerCapture(event.pointerId);
      scrub.current = { pointer: event.pointerId, rect, x: event.clientX, raf: 0 };
      seek(event.clientX, rect);
    }} onPointerMove={(event) => {
      const drag = scrub.current;
      if (drag?.pointer !== event.pointerId) return;
      drag.x = event.clientX;
      if (!drag.raf) drag.raf = requestAnimationFrame(() => { drag.raf = 0; seek(drag.x, drag.rect); });
    }} onPointerUp={(event) => finish(event, true)} onPointerCancel={(event) => finish(event, false)} onLostPointerCapture={(event) => finish(event, false)}>
      <div className={`${columns} sticky top-0 z-30 bg-surface-1 pb-0.5`}>
        <span className="self-center pl-2 text-2xs text-fg-subtle">{label('tracks')} / {label('frame')}</span>
        <div ref={ruler} data-studio-lane className="relative h-[26px] min-w-0 cursor-ew-resize touch-none select-none">
          <RulerReadout doc={doc} width={width} />
          <ScrubTarget doc={doc} />
        </div>
      </div>
      {[...doc.tracks].reverse().map((track) => (
        <div key={track.id} role="group" aria-label={track.name} className={`${columns} min-h-8 py-0.5`} data-testid="studio-track">
          <div className="flex min-w-0 items-center">
            <Button variant="ghost" size="sm" className="min-w-0 flex-1 justify-start px-2" aria-pressed={selection?.trackId === track.id}
              onClick={() => select({ trackId: track.id })} title={track.name}><span className="truncate">{track.name}</span></Button>
            <Button variant="ghost" size="icon-sm" aria-label={label('mute')} title={label('mute')} aria-pressed={track.muted}
              onClick={() => onTrack(track.id, (value) => ({ ...value, muted: !value.muted }))}>{track.muted ? <SpeakerSlash size={14} weight="fill" /> : <SpeakerHigh size={14} />}</Button>
            <Button variant="ghost" size="icon-sm" aria-label={label('lock')} title={label('lock')} aria-pressed={track.locked}
              onClick={() => onTrack(track.id, (value) => ({ ...value, locked: !value.locked }))}>{track.locked ? <Lock size={14} weight="fill" /> : <LockOpen size={14} />}</Button>
          </div>
          <div data-studio-lane className="relative min-w-0 touch-none rounded-md bg-well" data-muted={track.muted}>
            <div className="absolute inset-0 data-[muted=true]:opacity-45" data-muted={track.muted}>
              {track.clips.map((clip) => {
                const entry = entries.get(templateKey(clip.template));
                const selected = selection?.trackId === track.id && selection.clipId === clip.id;
                const target = { trackId: track.id, clipId: clip.id };
                return <ClipBar key={clip.id} {...{ clip, track, total: doc.durationFrames, selected }}
                  presentation={describeClip(clip, entry?.manifest.name, i18n.language, label, fileNames, entry?.manifest.params?.find((def) => def.key === 'kind')?.default)}
                  onSelect={() => select(target)} onDrag={(mode, frame) => { select(target); onDrag(target, mode, frame); }} />;
              })}
            </div>
            <div className="pointer-events-none absolute -inset-y-0.5 inset-x-0 z-20"><LanePlayhead doc={doc} /></div>
          </div>
        </div>
      ))}
      {!doc.tracks.some((track) => track.clips.length) && <p className="px-2 py-2 text-xs text-fg-subtle">{label('empty')}</p>}
    </div>
  );
}
