import { describe, expect, it, vi } from 'vitest';
import type { SetupContext } from '../../packages/template-sdk/src';
import { cueJavaToast, javaTextAlpha, javaToastTiming } from '../../packages/templates/advancement-toast/src/java-timing';

describe('T-FID.toast-phase Java 1.21.1', () => {
  it.each([
    [1.875, 1275, 'header', 0xbf, 0xbf],
    [1.950, 1350, 'header', 0x7f, 0x7f],
    [2.025, 1425, 'header', 0x3f, 0x3f],
    [2.099, 1499, 'header', 0x04, 0],
    [2.100, 1500, 'title', 0x04, 0],
    [2.101, 1501, 'title', 0x04, 0],
    [2.175, 1575, 'title', 0x3f, 0x3f],
    [2.250, 1650, 'title', 0x7e, 0x7e],
    [2.399, 1799, 'title', 0xff, 0xff],
    [2.400, 1800, 'title', 0xfc, 0xfc],
  ] as const)('总时间 %fs，停留 %dms：%s draw alpha=%d，模板可见 alpha 字节=%d', (seconds, holdAge, label, drawByte, visibleByte) => {
    const timing = javaToastTiming('javaAdvancement', {});
    const sample = timing.sample(seconds);
    expect(sample.holdAge).toBe(holdAge);
    expect(visibleByte).toBe(drawByte / 255 < 0.1 ? 0 : drawByte);
    expect(javaTextAlpha('javaAdvancement', sample.holdAge)).toEqual({
      header: label === 'header' ? visibleByte / 255 : 0,
      title: label === 'title' ? visibleByte / 255 : 0,
    });
  });

  it('先应用 draw 掩码，再判断片段能否通过 alpha 阈值', () => {
    expect(javaTextAlpha('javaAdvancement', 1525)).toEqual({ header: 0, title: 0 });
    expect(javaTextAlpha('javaAdvancement', 1529)).toEqual({ header: 0, title: 28 / 255 });
    expect(javaTextAlpha('javaAdvancement263', 1529)).toEqual({ header: 0, title: 0 });
  });

  it('整毫秒采样保持 5000ms 开区间和音效边界，不依赖取样顺序', () => {
    const timing = javaToastTiming('javaAdvancement', {});
    const atExit = timing.sample(5.6);
    expect(atExit).toMatchObject({ holdAge: 5000, horizontalShown: 1 });
    expect(timing.sample(5.599)).toMatchObject({ holdAge: 4999, horizontalShown: 1 });
    expect(timing.sample(5.601).horizontalShown).toBeCloseTo(1 - (1 / 600) ** 2, 12);
    expect(timing.sample(5.9).horizontalShown).toBe(0.75);
    expect(timing.duration).toBe(6.2);
    expect(timing.sample(timing.duration).horizontalShown).toBe(0);
    expect(timing.sample(0).horizontalShown).toBe(0);
    expect(timing.sample(5.6)).toEqual(atExit);

    const cue = vi.fn<SetupContext['audio']['cue']>();
    const ctx = { params: {}, audio: { cue } } satisfies Pick<SetupContext, 'params' | 'audio'>;
    cueJavaToast(ctx, 'javaAdvancement', true, timing);
    expect(timing.sample(0.6).holdAge).toBe(0);
    expect(timing.sample(0.601).holdAge).toBe(1);
    expect(cue.mock.calls.map(([sound, seconds]) => [sound, seconds])).toEqual([
      ['minecraft:ui.toast.in', 0],
      ['minecraft:ui.toast.challenge_complete', 0.601],
      ['minecraft:ui.toast.out', 5.6],
    ]);
  });
});
