export function traceLines(hits: ReadonlySet<number> | undefined, total: number): number[] {
  return hits ? [...hits].filter((line) => Number.isInteger(line) && line >= 1 && line <= total).sort((a, b) => a - b) : [];
}

export function nearestHit(lines: readonly number[], anchor: number): number | undefined {
  let nearest: number | undefined;
  for (const line of lines) {
    if (nearest === undefined || Math.abs(line - anchor) < Math.abs(nearest - anchor)) nearest = line;
  }
  return nearest;
}

export function nextHit(lines: readonly number[], after: number): number | undefined {
  return lines.find((line) => line > after) ?? lines[0];
}

export function newHits(lines: readonly number[], previous: readonly number[]): number[] {
  const old = new Set(previous);
  return lines.filter((line) => !old.has(line));
}

export const TRACE_ROW_HEIGHT = 20;
export const TRACE_PAD_TOP = 8;

export function traceViewport(top: number, height: number) {
  const first = Math.max(1, Math.ceil((top - TRACE_PAD_TOP) / TRACE_ROW_HEIGHT) + 1);
  const last = Math.floor((top + height - TRACE_PAD_TOP) / TRACE_ROW_HEIGHT);
  return { first, last, center: (first + last) / 2 };
}

export function revealHit(line: number, top: number, height: number): number {
  const row = TRACE_PAD_TOP + (line - 1) * TRACE_ROW_HEIGHT;
  if (row >= top && row + TRACE_ROW_HEIGHT <= top + height) return top;
  return Math.max(0, row - Math.floor((height - TRACE_ROW_HEIGHT) / 2));
}

export function autoHit(lines: readonly number[], fresh: readonly number[], top: number, height: number, initial: boolean) {
  const { first, last, center } = traceViewport(top, height);
  const candidates = initial || !fresh.length ? lines : fresh;
  return candidates.some((line) => line >= first && line <= last) ? undefined : nearestHit(candidates, center);
}
