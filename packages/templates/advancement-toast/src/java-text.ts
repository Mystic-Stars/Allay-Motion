import type { GuiTextMetrics } from '@allay/template-sdk';

const WIDTH = 125;
const TOP = 3;
const BOTTOM = 29;
const BASELINE_OFFSET = 7;
const LINE_HEIGHT = 9;
const MAX_LINES = 3;

type Measure = (text: string) => GuiTextMetrics;
type Row = { text: string; scale: number; above: number; below: number; left: number };

export function splitJavaTitle(text: string, measure: Measure): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r\n?|\n/)) {
    const chars = [...paragraph.trimEnd()];
    let start = 0;
    while (start < chars.length) {
      let end = start;
      let space = -1;
      for (; end < chars.length; end++) {
        if (chars[end] === ' ') space = end;
        if (end > start && measure(chars.slice(start, end + 1).join('')).width > WIDTH) break;
      }
      if (end < chars.length && space > start) end = space;
      lines.push(chars.slice(start, end).join('').trimEnd());
      start = end;
      while (chars[start] === ' ') start++;
    }
    if (!chars.length) lines.push('');
  }
  return lines.length ? lines : [''];
}

function ellipsize(text: string, measure: Measure): string {
  const chars = [...text.trimEnd()];
  while (chars.length && measure(`${chars.join('').trimEnd()}…`).width > WIDTH) chars.pop();
  return `${chars.join('').trimEnd()}…`;
}

function row(text: string, measure: Measure): Row {
  const { width, above, below, left } = measure(text);
  const scale = Math.min(1, WIDTH / Math.max(1, width), (BOTTOM - TOP) / Math.max(1, above + below));
  return { text, scale, above: above * scale, below: below * scale, left: left * scale };
}

function positionRows(rows: Row[], preferred: number[]) {
  const gap = (index: number) => Math.max(LINE_HEIGHT, rows[index - 1]!.below + rows[index]!.above + 1);
  const latest = rows.map((item) => BOTTOM - item.below);
  for (let index = rows.length - 2; index >= 0; index--) latest[index] = Math.min(latest[index]!, latest[index + 1]! - gap(index + 1));
  const baselines: number[] = [];
  for (const [index, item] of rows.entries()) {
    const earliest = Math.max(TOP + item.above, index ? baselines[index - 1]! + gap(index) : TOP);
    if (earliest - latest[index]! > 1e-9) return null;
    baselines.push(Math.max(earliest, Math.min(preferred[index]!, latest[index]!)));
  }
  return rows.map((item, index) => ({ ...item, baseline: baselines[index]! }));
}

export function layoutJavaToastText(headerText: string, titleText: string, measureHeader: Measure, measureTitle: Measure, legacy: boolean) {
  const headerLine = headerText.replace(/\r\n?|\n/g, ' ');
  const header = row(measureHeader(headerLine).width > WIDTH ? ellipsize(headerLine, measureHeader) : headerLine, measureHeader);
  const legacyTitle = titleText.replace(/\r\n?|\n/g, ' ');
  const lines = legacy
    ? [measureTitle(legacyTitle).width > WIDTH ? ellipsize(legacyTitle, measureTitle) : legacyTitle]
    : splitJavaTitle(titleText, measureTitle);
  if (lines.length === 1) {
    const together = positionRows([header, row(lines[0]!, measureTitle)], [7 + BASELINE_OFFSET, 18 + BASELINE_OFFSET]);
    if (together) return { header: together[0]!, titles: together.slice(1), alternating: false };
  }

  const solo = positionRows([header], [11 + BASELINE_OFFSET])![0]!;
  for (let count = Math.min(MAX_LINES, lines.length); count >= 1; count--) {
    const visible = lines.slice(0, count);
    if (count < lines.length) visible[count - 1] = ellipsize(visible[count - 1]!, measureTitle);
    const first = 16 - Math.floor(count * LINE_HEIGHT / 2) + BASELINE_OFFSET;
    const titles = positionRows(visible.map((text) => row(text, measureTitle)), visible.map((_, index) => first + index * LINE_HEIGHT));
    if (titles) return { header: solo, titles, alternating: true };
  }
  throw new Error('unable to fit a single Java toast row');
}
