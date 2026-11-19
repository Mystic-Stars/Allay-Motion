import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger } from '../components/ui/select';
import { bezierPadding, moveBezierPoint, type BezierPoints } from './bezier-edit';
import { useEditor } from './context';
import { EASING_FUNCTIONS, easingFn, easingPath, type EasingValue } from './easing';
import { trackEditorPointer } from './track-editor-pointer';
import './easing-focus.css';

// EasingField（6.5）：下拉里每个预设配一条小曲线；“自定义”展开一个 SVG 贝塞尔编辑器（两个可拖控制点）
// 和一个按曲线运动的小圆点。小圆点只动 transform；减少动效时不动。

export interface EasingFieldProps {
  value: EasingValue;
  onChange(value: EasingValue): void;
  label: string;
  testId?: string;
}

const NAMES = Object.keys(EASING_FUNCTIONS);
const CUSTOM = '__custom';

function MiniCurve({ value }: { value: EasingValue }) {
  return (
    <svg width="28" height="16" viewBox="0 0 28 16" aria-hidden="true" className="shrink-0 text-primary">
      <path d={easingPath(value, 28, 16)} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const BOX = 160;
const INSET = 14;
const toX = (x: number) => x * BOX;
const toY = (y: number, pad: number) => BOX * (0.5 - (y - 0.5) / (1 + pad * 2));

function BezierEditor({ value, onChange, label, testId }: { value: BezierPoints; onChange(v: [number, number, number, number]): void; label: string; testId?: string }) {
  const editor = useEditor();
  const panelRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const dotRef = useRef<SVGGElement>(null);
  const dragRef = useRef<(() => void) | null>(null);
  const [frozenPad, setFrozenPad] = useState<number | null>(null);
  const [hover, setHover] = useState(false);
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  const pad = frozenPad ?? bezierPadding(value);
  const latest = useRef({ value, onChange, pad });
  useLayoutEffect(() => {
    latest.current = { value, onChange, pad };
  });
  const active = hover || keyboardFocus || frozenPad !== null;

  useEffect(() => {
    let raf = 0;
    let start = 0;
    const root = document.documentElement;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const tick = (now: number) => {
      const p = ((now - start) / 1400) % 1.4;
      const x = Math.min(1, p);
      const geometry = latest.current;
      const y = easingFn(geometry.value)(x);
      dotRef.current?.setAttribute('transform', `translate(${toX(x).toFixed(1)} ${(toY(y, geometry.pad) - toY(0, geometry.pad)).toFixed(1)})`);
      raf = requestAnimationFrame(tick);
    };
    const sync = () => {
      cancelAnimationFrame(raf);
      if ((root.dataset.reducedMotion ?? String(media.matches)) === 'true') {
        dotRef.current?.removeAttribute('transform');
      } else {
        start = performance.now();
        raf = requestAnimationFrame(tick);
      }
    };
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['data-reduced-motion'] });
    media.addEventListener('change', sync);
    sync();
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      media.removeEventListener('change', sync);
    };
  }, []);

  useEffect(() => () => dragRef.current?.(), []);
  useEffect(() => {
    if (!active) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && panelRef.current?.contains(event.target)) return;
      setHover(false);
      setKeyboardFocus(false);
    };
    window.addEventListener('pointerdown', dismiss, true);
    return () => window.removeEventListener('pointerdown', dismiss, true);
  }, [active]);

  const handle = (which: 0 | 1) => {
    const cx = toX(value[which * 2]!);
    const cy = toY(value[which * 2 + 1]!, pad);
    const ax = which === 0 ? 0 : BOX;
    const ay = toY(which, pad);
    return (
      <g key={which}>
        <line x1={ax} y1={ay} x2={cx} y2={cy} stroke="var(--fg-subtle)" strokeWidth="1" />
        <circle
          cx={cx}
          cy={cy}
          r="12"
          fill="transparent"
          className="cursor-grab active:cursor-grabbing"
          role="slider"
          aria-label={editor.t(which === 0 ? 'easing.handle1' : 'easing.handle2')}
          aria-valuemin={0}
          aria-valuemax={1}
          aria-valuenow={value[which * 2]}
          aria-valuetext={`${value[which * 2]}, ${value[which * 2 + 1]}`}
          data-bezier-handle={which}
          tabIndex={0}
          onFocus={(event) => setKeyboardFocus(event.currentTarget.matches(':focus-visible'))}
          onBlur={() => setKeyboardFocus(false)}
          onKeyDown={(event) => {
            if (dragRef.current) return;
            if (event.key === 'Escape') {
              setKeyboardFocus(false);
              setHover(false);
              return;
            }
            const step = event.shiftKey ? 0.1 : 0.01;
            const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
            const dy = event.key === 'ArrowDown' ? -step : event.key === 'ArrowUp' ? step : 0;
            if (!dx && !dy) return;
            event.preventDefault();
            event.stopPropagation();
            setKeyboardFocus(true);
            onChange(moveBezierPoint(value, which, dx, dy));
          }}
          onPointerDown={(event) => {
            if (event.button !== 0 || dragRef.current) return;
            const scale = svgRef.current?.getScreenCTM()?.a;
            if (!scale) return;
            const startX = event.clientX;
            const startY = event.clientY;
            const from = value;
            let current = from;
            let raf = 0;
            let last = event.nativeEvent;
            const update = (pointer: PointerEvent | null) => {
              const next = pointer ? moveBezierPoint(from, which, (pointer.clientX - startX) / (BOX * scale), (startY - pointer.clientY) * (1 + pad * 2) / (BOX * scale)) : [...from] as [number, number, number, number];
              if (next.every((coordinate, index) => coordinate === current[index])) return;
              current = next;
              latest.current.onChange(next);
            };
            editor.gesture('start');
            setFrozenPad(pad);
            const stop = trackEditorPointer(event.currentTarget, event.pointerId, (pointer) => {
              last = pointer;
              if (!raf) raf = requestAnimationFrame(() => {
                raf = 0;
                update(last);
              });
            }, (pointer) => {
              cancelAnimationFrame(raf);
              update(pointer);
              dragRef.current = null;
              setFrozenPad(null);
              setHover(panelRef.current?.matches(':hover') ?? false);
              if (!pointer) setKeyboardFocus(false);
              editor.gesture('end');
            });
            dragRef.current = () => {
              cancelAnimationFrame(raf);
              stop();
              dragRef.current = null;
              editor.gesture('end');
            };
          }}
        />
        <circle cx={cx} cy={cy} r="6" fill="var(--surface-2)" stroke="var(--primary)" strokeWidth="2" pointerEvents="none" />
      </g>
    );
  };
  return (
    <div ref={panelRef} className="bezier-editor flex flex-col pb-2" data-active={active} data-testid={testId && `${testId}-bezier`}
      onPointerEnter={(event) => { if (event.pointerType !== 'touch') setHover(true); }} onPointerLeave={() => setHover(false)}>
      <svg ref={svgRef} width={BOX + INSET * 2} height={BOX + INSET * 2} viewBox={`${-INSET} ${-INSET} ${BOX + INSET * 2} ${BOX + INSET * 2}`}
        className="h-auto max-w-full touch-none self-center overflow-visible" role="group" aria-label={label}>
        <rect x="0" y={toY(1, pad)} width={BOX} height={toY(0, pad) - toY(1, pad)} fill="none" stroke="var(--control-hi)" strokeDasharray="3 3" />
        <path d={easingPath(value, BOX, BOX, pad, 64)} fill="none" stroke="var(--primary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <g ref={dotRef} pointerEvents="none" data-bezier-preview=""><circle cx="0" cy={toY(0, pad)} r="4" fill="var(--primary)" /></g>
        {handle(0)}{handle(1)}
      </svg>
      <span className="text-center num text-xs text-fg-subtle">[{value.map((n) => n.toFixed(2)).join(', ')}]</span>
    </div>
  );
}

export function EasingField({ value, onChange, label, testId }: EasingFieldProps) {
  const editor = useEditor();
  const isCustom = typeof value !== 'string';
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Select
        value={isCustom ? CUSTOM : value}
        onValueChange={(v) => {
          if (v === CUSTOM) onChange(isCustom ? value : [0.25, 0.1, 0.25, 1]);
          else if (typeof v === 'string') onChange(v);
        }}
      >
        <SelectTrigger aria-label={label} data-testid={testId} className="w-full">
          <span className="flex min-w-0 items-center gap-2">
            <MiniCurve value={value} />
            <span className="truncate">{isCustom ? editor.t('easing.custom') : editor.t(`easing.names.${value}`)}</span>
          </span>
        </SelectTrigger>
        <SelectContent>
          {NAMES.map((n) => (
            <SelectItem key={n} value={n}>
              <MiniCurve value={n} />
              {editor.t(`easing.names.${n}`)}
            </SelectItem>
          ))}
          <SelectSeparator />
          <SelectItem value={CUSTOM}>{editor.t('easing.custom')}</SelectItem>
        </SelectContent>
      </Select>
      {isCustom && <BezierEditor value={value} onChange={onChange} label={label} testId={testId} />}
    </div>
  );
}
