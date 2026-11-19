import { describe, expect, it, vi } from 'vitest';
import { startSegmentGesture } from '../../apps/desktop/src/renderer/features/transport/segment-gesture';
import { clearHistory, isDirty, undo, useProjectStore } from '../../apps/desktop/src/renderer/stores/projectStore';
import { TemplateManifestSchema } from '../../packages/template-sdk/src/index';
import { bezierPadding, moveBezierPoint } from '../../packages/ui/src/editor/bezier-edit';
import { nearestCue, segmentAt, snapSegment } from '../../packages/ui/src/editor/timeline-edit';
import { trackEditorPointer } from '../../packages/ui/src/editor/track-editor-pointer';

describe('T-UI-2 / T-UI-3 时间轴与缓动', () => {
  it('终点左右拖动按帧率吸附并限制在声明范围内', () => {
    expect(snapSegment(0.543, 60, 0.15, 2)).toBe(33 / 60);
    expect(snapSegment(0.428, 60, 0.15, 2)).toBe(26 / 60);
    expect(snapSegment(-1, 60, 0.15, 2)).toBe(0.15);
    expect(snapSegment(3, 60, 0.15, 2)).toBe(2);
  });

  it('命中真实阶段与最近音效，包括空轨', () => {
    expect(segmentAt([0.5, 0.6, 1.1], 0.59)).toBe(1);
    expect(segmentAt([0.5, 0.6, 1.1], 0.6)).toBe(2);
    expect(segmentAt([0.5, 0.6, 1.1], 1.1)).toBe(2);
    expect(segmentAt([], 0)).toBe(-1);
    expect(nearestCue([0.7, 0.2, 0.24], 0.23)).toBe(0.24);
    expect(nearestCue([], 0.1)).toBeUndefined();
  });

  it('结束连续操作只记一步；还原起点不清除重做，也不把干净工程标成已修改', () => {
    const manifest = TemplateManifestSchema.parse({
      formatVersion: 1, id: 'test.end', version: '1.0.0', name: 'Exit', category: 'transition',
      params: [{ key: 'out', type: 'duration', label: 'Out', default: 0.5, min: 0.1, max: 2 }],
    });
    const template = { ref: { id: manifest.id, version: manifest.version }, manifest, params: manifest.params!, hidden: [], code: '', assets: null };
    const store = useProjectStore;
    store.getState().reset({ template, name: null, handle: null });
    clearHistory();
    let finish = startSegmentGesture();
    store.getState().setParams({ out: 0.6 });
    store.getState().setParams({ out: 0.7 });
    finish();
    expect(store.temporal.getState().pastStates).toHaveLength(1);
    undo();
    expect(store.getState().params.out).toBe(0.5);
    store.getState().markSaved('Fixture', 'handle');

    finish = startSegmentGesture();
    store.getState().setParams({ out: 0.4 });
    store.getState().setParams({ out: 0.5 });
    finish();
    expect(store.temporal.getState().pastStates).toHaveLength(0);
    expect(store.temporal.getState().futureStates).toHaveLength(1);
    expect(store.temporal.getState().isTracking).toBe(true);
    expect(isDirty(store.getState())).toBe(false);
  });

  it('忽略其他指针；Esc 释放捕获并移除后续移动和松手监听', () => {
    const target = new EventTarget();
    const release = vi.fn();
    const element = Object.assign(new EventTarget(), {
      setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: release,
    }) as unknown as Element;
    vi.stubGlobal('window', target);
    try {
      const move = vi.fn();
      const finish = vi.fn();
      trackEditorPointer(element, 7, move, finish);
      const pointer = (type: string, pointerId: number) => target.dispatchEvent(Object.assign(new Event(type), { pointerId }));
      pointer('pointermove', 8);
      pointer('pointercancel', 8);
      pointer('pointermove', 7);
      target.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
      pointer('pointermove', 7);
      pointer('pointerup', 7);
      expect(move).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledExactlyOnceWith(7);
      expect(finish).toHaveBeenCalledExactlyOnceWith(null);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('把上下过冲控制点纳入视区，键盘修改单轴不舍入另一轴', () => {
    const points = [0.125, -0.75, 0.875, 2.25] as const;
    const padding = bezierPadding(points);
    expect(-padding).toBeLessThan(points[1]);
    expect(1 + padding).toBeGreaterThan(points[3]);
    expect(moveBezierPoint(points, 0, 0, -0.1)).toEqual([0.125, -0.85, 0.875, 2.25]);
    expect(moveBezierPoint(points, 1, 0.5, 0.1)).toEqual([0.125, -0.75, 1, 2.35]);
  });
});
