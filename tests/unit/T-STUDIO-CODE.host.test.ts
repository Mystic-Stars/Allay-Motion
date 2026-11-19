import { afterEach, expect, it, vi } from 'vitest';
import { framePublisher, matchesTrace } from '../../apps/desktop/src/renderer/features/live-code/host/trace';

afterEach(() => vi.useRealTimers());

it('T-STUDIO-CODE-1 只接受同一片段和源码的追踪结果', () => {
  const target = { id: 'user.test.script', version: '1.0.0', clipId: 'one' };
  const sample = { ...target, source: 'old', t: 1, lines: [3] };
  expect(matchesTrace(target, 'old', sample)).toBe(true);
  expect(matchesTrace({ ...target, clipId: 'two' }, 'old', sample)).toBe(false);
  expect(matchesTrace(target, 'new', sample)).toBe(false);
});

it('T-STUDIO-CODE-1 播放中节流且不丢末帧，暂停即时发布，关窗取消待发帧', () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const send = vi.fn();
  const publisher = framePublisher(send);
  const frame = { type: 'frame', token: 1, time: 0, frame: 0, playing: true, lines: [3] } as const;
  const push = (time: number, playing = true) => publisher.push({ ...frame, lines: [3], time, frame: Math.round(time * 60), playing }, 7);
  push(0);
  push(0.016);
  push(0.033);
  expect(send).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(50);
  expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ time: 0.033 }), 7);
  push(0.05, false);
  expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ playing: false }), 7);
  push(0.066);
  publisher.clear();
  vi.advanceTimersByTime(100);
  expect(send).toHaveBeenCalledTimes(3);
});
