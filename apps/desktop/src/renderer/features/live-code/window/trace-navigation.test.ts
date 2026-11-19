import { describe, expect, it } from 'vitest';
import { autoHit, nearestHit, newHits, nextHit, revealHit, traceLines, traceViewport } from './trace-navigation';

describe('T-STUDIO 执行行定位', () => {
  it('首次在千行源码中露出一条真实命中，已有完整可见命中时不滚动', () => {
    const lines = traceLines(new Set([1001, 985, 0, -4, 9999, 1.5]), 1200);
    expect(lines).toEqual([985, 1001]);
    const first = autoHit(lines, lines, 0, 160, true)!;
    expect(first).toBe(985);
    const top = revealHit(first, 0, 160);
    const { first: visibleStart, last: visibleEnd } = traceViewport(top, 160);
    expect(first).toBeGreaterThanOrEqual(visibleStart);
    expect(first).toBeLessThanOrEqual(visibleEnd);
    expect(autoHit(lines, lines, top, 160, true)).toBeUndefined();
  });

  it('跟随优先新分支，即使旧命中仍在视口内；新分支可见后不再滚动', () => {
    const lines = [3, 910, 980];
    const fresh = newHits(lines, [3, 802]);
    expect(fresh).toEqual([910, 980]);
    expect(autoHit(lines, fresh, 0, 160, false)).toBe(910);
    const top = revealHit(910, 0, 160);
    expect(autoHit(lines, fresh, top, 160, false)).toBeUndefined();
    expect(autoHit(lines, [], top, 160, false)).toBeUndefined();
  });

  it('手动定位可从光标附近开始并循环到下一处，空帧无定位', () => {
    const lines = [3, 120, 830];
    expect(nearestHit(lines, 110)).toBe(120);
    expect(nextHit(lines, 120)).toBe(830);
    expect(nextHit(lines, 830)).toBe(3);
    expect(nextHit([], 3)).toBeUndefined();
    expect(autoHit([], [], 0, 160, true)).toBeUndefined();
  });
});
