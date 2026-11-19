import { memo, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type Ref } from 'react';
import { normalizeNewlines } from './model';
import { autoHit, nearestHit, newHits, nextHit, revealHit, traceLines, traceViewport, TRACE_PAD_TOP as PAD_TOP, TRACE_ROW_HEIGHT as ROW_HEIGHT } from './trace-navigation';
import { lineAt, lineStarts, type TextMatch } from './text-navigation';

const OVERSCAN = 6;

export interface TraceEditor {
  locate(): number | undefined;
  caret(): { offset: number; scrollLeft: number };
  focus(selection?: TextMatch, scrollLeft?: number): void;
}

export const SourceEditor = memo(function SourceEditor({ fileName, text, readOnly, active, hits, traceToken, traceMode, follow, traceRef, located, searching, match, onManual, onChange }: {
  fileName: string;
  text: string;
  readOnly: boolean;
  active: boolean;
  hits?: ReadonlySet<number>;
  traceToken?: number;
  traceMode?: 'frame' | 'setup';
  follow?: boolean;
  traceRef?: Ref<TraceEditor>;
  located?: number;
  searching?: boolean;
  match?: TextMatch;
  onManual?: () => void;
  onChange: (value: string) => void;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const matchMark = useRef<HTMLElement>(null);
  const [height, setHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const value = useMemo(() => normalizeNewlines(text), [text]);
  const starts = useMemo(() => lineStarts(value), [value]);
  const total = starts.length;
  const lines = useMemo(() => traceLines(hits, total), [hits, total]);
  const signature = lines.join(',');
  const navigation = useRef({ token: traceToken, mode: traceMode, initial: true, caret: false, previous: [] as number[], fresh: [] as number[],
    cycle: undefined as { signature: string; line: number } | undefined });

  useLayoutEffect(() => {
    const tracker = navigation.current;
    const changedMode = tracker.mode !== traceMode;
    if (tracker.token !== traceToken || changedMode) {
      tracker.token = traceToken;
      tracker.mode = traceMode;
      tracker.cycle = undefined;
      tracker.previous = [];
    }
    if (changedMode) tracker.initial = true;
    if (tracker.previous !== lines) {
      tracker.fresh = newHits(lines, tracker.previous);
      tracker.previous = lines;
    }
    const field = textarea.current;
    if (searching || !active || traceToken === undefined || !field?.clientHeight || !lines.length) return;
    const editing = !readOnly && field.ownerDocument.activeElement === field;
    const initial = tracker.initial;
    tracker.initial = false;
    if (editing || (!initial && !follow)) return;
    const line = autoHit(lines, tracker.fresh, field.scrollTop, field.clientHeight, initial);
    if (line !== undefined) field.scrollTop = revealHit(line, field.scrollTop, field.clientHeight);
  }, [active, follow, lines, readOnly, searching, traceMode, traceToken]);

  const matchLine = match ? lineAt(starts, match.start) : undefined;
  useLayoutEffect(() => {
    const field = textarea.current;
    const mark = matchMark.current;
    if (!active || !field || !mark || matchLine === undefined) return;
    const box = field.getBoundingClientRect();
    const matchBox = mark.getBoundingClientRect();
    const start = matchBox.left - box.left;
    const end = matchBox.right - box.left;
    if (start < 0 || end > field.clientWidth) field.scrollLeft = Math.max(0, field.scrollLeft + start - 16);
    field.scrollTop = revealHit(matchLine, field.scrollTop, field.clientHeight);
  }, [active, match, matchLine]);

  useImperativeHandle(traceRef, () => ({
    caret: () => ({ offset: textarea.current?.selectionStart ?? 0, scrollLeft: textarea.current?.scrollLeft ?? 0 }),
    focus(selection, left) {
      const field = textarea.current;
      if (!field || !active) return;
      field.focus({ preventScroll: true });
      if (selection) field.setSelectionRange(selection.start, selection.end);
      field.scrollTop = revealHit(lineAt(starts, field.selectionStart), field.scrollTop, field.clientHeight);
      if (left !== undefined) field.scrollLeft = left;
      else if (selection && selection.start === selection.end) field.scrollLeft = 0;
    },
    locate() {
      const field = textarea.current;
      if (!field || !active || !lines.length) return;
      const tracker = navigation.current;
      const caret = tracker.caret ? lineAt(starts, field.selectionStart) : 0;
      const anchor = caret || traceViewport(field.scrollTop, field.clientHeight).center;
      const line = tracker.cycle?.signature === signature ? nextHit(lines, tracker.cycle.line) :
        nearestHit(tracker.fresh.length ? tracker.fresh : lines, anchor);
      if (line === undefined) return;
      tracker.initial = false;
      tracker.cycle = { signature, line };
      field.scrollTop = revealHit(line, field.scrollTop, field.clientHeight);
      return line;
    },
  }), [active, lines, signature, starts]);

  const manual = (caret = false) => {
    const tracker = navigation.current;
    tracker.initial = false;
    tracker.caret ||= caret;
    tracker.cycle = undefined;
    onManual?.();
  };

  useLayoutEffect(() => {
    if (!active || !textarea.current) return;
    const field = textarea.current;
    const measure = () => {
      setHeight(field.clientHeight);
      setScrollTop(field.scrollTop);
      setScrollLeft(field.scrollLeft);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(field);
    return () => observer.disconnect();
  }, [active]);

  const first = Math.min(total, Math.max(0, Math.floor((scrollTop - PAD_TOP) / ROW_HEIGHT) - OVERSCAN));
  const end = Math.min(total, Math.ceil((scrollTop + height - PAD_TOP) / ROW_HEIGHT) + OVERSCAN);
  const source = fileName === 'template.js';
  return <section className="inspector-editor" aria-label={fileName} hidden={!active} onWheelCapture={() => manual()}
    data-trace-mode={traceMode} onPointerDownCapture={() => manual()} style={{
    '--line-height': `${ROW_HEIGHT}px`,
    '--line-padding': `${PAD_TOP}px`,
    '--number-width': `${Math.max(3, String(total).length)}ch`,
  } as CSSProperties}>
    <div className="inspector-line-layer" aria-hidden="true" style={{ height }}>
      <div className="inspector-line-window" style={{ transform: `translateY(${PAD_TOP + first * ROW_HEIGHT - scrollTop}px)` }}>
        {Array.from({ length: Math.max(0, end - first) }, (_, index) => {
          const line = first + index + 1;
          return <div key={line} className="inspector-line" data-testid={source ? 'code-inspector-source-row' : 'code-inspector-manifest-row'}
            data-line={line} data-hit={hits?.has(line) ?? false} data-located={located === line || undefined}>
            <span className="inspector-line-marker" />
            <span className="inspector-line-number">{line}</span>
          </div>;
        })}
      </div>
    </div>
    {match && matchLine !== undefined && <div className="inspector-search-layer" aria-hidden="true">
      <div className="inspector-search-line" style={{ top: PAD_TOP + (matchLine - 1) * ROW_HEIGHT - scrollTop, left: -scrollLeft }}>
        {value.slice(starts[matchLine - 1], match.start)}<mark ref={matchMark}>{value.slice(match.start, match.end)}</mark>
      </div>
    </div>}
    <textarea ref={textarea} aria-label={fileName} className="inspector-textarea" value={value} readOnly={readOnly}
      data-testid={source ? 'code-inspector-source' : 'code-inspector-manifest'}
      spellCheck={false} autoComplete="off" autoCapitalize="off" wrap="off" dir="ltr"
      onFocus={() => { if (!readOnly) manual(true); }}
      onPointerDown={() => manual(true)}
      onKeyDown={() => manual(true)}
      onChange={(event) => onChange(event.currentTarget.value)}
      onScroll={(event) => {
        setHeight(event.currentTarget.clientHeight);
        setScrollTop(event.currentTarget.scrollTop);
        setScrollLeft(event.currentTarget.scrollLeft);
      }} />
  </section>;
});
