import { describe, expect, it } from 'vitest';
import { activeMatch, findMatches, lineAt, lineStarts, parseLine } from './text-navigation';

describe('T-STUDIO-CODE-NAV 文本导航', () => {
  it('字面匹配、忽略大小写，并返回原始字符偏移', () => {
    const text = '😀 中文.\n中文a\nA.B a.b';
    expect(findMatches(text, '中文.')).toEqual([{ start: 3, end: 6 }]);
    const matches = findMatches(text, 'a.b');
    expect(matches.map(({ start, end }) => text.slice(start, end))).toEqual(['A.B', 'a.b']);
    expect(activeMatch(matches, matches[0]!.end)).toBe(1);
    expect(activeMatch(matches, text.length)).toBe(0);
    expect(activeMatch([], 0)).toBe(-1);
  });

  it('跳行保留空行和末尾换行，拒绝越界与非整数', () => {
    const offsets = lineStarts('one\n\n三\n');
    expect(offsets).toEqual([0, 4, 5, 7]);
    expect(lineAt(offsets, 4)).toBe(2);
    expect(lineAt(offsets, 7)).toBe(4);
    expect(parseLine(' 4 ', offsets.length)).toBe(4);
    for (const invalid of ['0', '5', '1.2', '1e0', '', '-1']) expect(parseLine(invalid, offsets.length)).toBeUndefined();
  });
});
