export interface TextMatch { start: number; end: number }

export function findMatches(text: string, query: string): TextMatch[] {
  if (!query) return [];
  const literal = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return Array.from(text.matchAll(new RegExp(literal, 'giu')), (match) => ({ start: match.index, end: match.index + match[0].length }));
}

export function activeMatch(matches: readonly TextMatch[], anchor: number): number {
  if (matches.length === 0) return -1;
  const index = matches.findIndex(({ start }) => start >= anchor);
  return index === -1 ? 0 : index;
}

export function lineStarts(text: string): number[] {
  const offsets = [0];
  for (let offset = text.indexOf('\n'); offset !== -1; offset = text.indexOf('\n', offset + 1)) offsets.push(offset + 1);
  return offsets;
}

export function lineAt(starts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = starts.length;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid;
  }
  return lo + 1;
}

export function parseLine(value: string, total: number): number | undefined {
  const input = value.trim();
  if (!/^\d+$/.test(input)) return;
  const line = Number(input);
  return line >= 1 && line <= total ? line : undefined;
}
