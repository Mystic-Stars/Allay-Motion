import { afterEach, describe, expect, it } from 'vitest';
import { CompositionSchema, type Composition, type CompositionClip } from '../../packages/template-sdk/src/composition';
import { appendClip, clipEdit, duplicateClip, makeTrack, moveClip, splitClip, trimClip, valueAt } from '../../apps/desktop/src/renderer/features/studio/edits';
import { beginGesture, clearHistory, endGesture, isDirty, redo, undo, useProjectStore } from '../../apps/desktop/src/renderer/stores/projectStore';

const clip: CompositionClip = { id: 'clip', template: { id: 'allay.builtin.block-wipe', version: '1.0.0' },
  startFrame: 12, sourceInFrame: 3, durationFrames: 60, params: { cols: 12, nested: [{ value: 3 }] },
  transform: { x: 0 }, keyframes: [{ frame: 40, x: 80 }, { frame: 20, opacity: 0.4 }] };
const doc: Composition = { formatVersion: 1, fps: 60, durationFrames: 300, tracks: [
  { ...makeTrack('track', 'Main'), clips: [clip] }, makeTrack('other', 'Other'),
] };
const selection = { trackId: 'track', clipId: 'clip' };

afterEach(() => {
  useProjectStore.getState().reset({ template: null, name: null, handle: null });
  clearHistory();
});

describe('T-STUDIO 合成工程', () => {
  it('五分钟、帧率、唯一身份和有限 JSON 都由 schema 约束', () => {
    expect(CompositionSchema.safeParse({ ...doc, durationFrames: 18_000 }).success).toBe(true);
    for (const invalid of [{ ...doc, durationFrames: 18_001 }, { ...doc, fps: 29 }, { ...doc, durationFrames: 71 },
      { ...doc, tracks: [doc.tracks[0], doc.tracks[0]] },
      { ...doc, tracks: [{ ...doc.tracks[0], clips: [{ ...clip, params: { number: Infinity } }] }] }]) {
      expect(CompositionSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('分割保持源时钟和稀疏曲线，不能在片段首帧或开区间末端分割', () => {
    expect(splitClip(doc, selection, 12, 'right')).toBe(doc);
    expect(splitClip(doc, selection, 72, 'right')).toBe(doc);
    const [left, right] = splitClip(doc, selection, 42, 'right').tracks[0]!.clips;
    expect(left).toMatchObject({ id: 'clip', startFrame: 12, durationFrames: 30, sourceInFrame: 3 });
    expect(right).toMatchObject({ id: 'right', startFrame: 42, durationFrames: 30, sourceInFrame: 33, template: clip.template });
    for (const frame of [0, 0.5, 9, 10, 22]) {
      expect(valueAt(right!, 'x', frame)).toBeCloseTo(valueAt(clip, 'x', frame + 30));
      expect(valueAt(right!, 'opacity', frame)).toBeCloseTo(valueAt(clip, 'opacity', frame + 30));
    }
  });

  it('复制实例独立、可换轨，锁定拒绝移入或修改', () => {
    const copied = duplicateClip(doc, doc.tracks[0]!, clip, 'copy');
    const copy = copied.tracks[0]!.clips[1]!;
    expect(copy).toMatchObject({ id: 'copy', startFrame: 72, template: clip.template, params: clip.params });
    expect(copy.params.nested).not.toBe(clip.params.nested);
    const moved = moveClip(copied, { ...selection, clipId: 'copy' }, 200, 'other');
    expect(moved.tracks[1]!.clips[0]).toMatchObject({ id: 'copy', startFrame: 200 });
    const locked = { ...doc, tracks: [{ ...doc.tracks[0]!, locked: true }, doc.tracks[1]!] };
    expect(clipEdit(locked, selection, () => null)).toBe(locked);
    expect(moveClip(locked, selection, 200, 'other')).toBe(locked);
    expect(appendClip(locked, locked.tracks[0]!, copy)).toBe(locked);
    expect(trimClip(doc, selection, 'start', -1).tracks[0]!.clips[0]).toMatchObject({ startFrame: 9, sourceInFrame: 0, durationFrames: 63 });
  });

  it('合成写入标记脏状态，一次手势只撤销一步并同步帧率', () => {
    useProjectStore.getState().reset({ template: null, composition: doc, name: 'doc', handle: null });
    clearHistory();
    beginGesture();
    useProjectStore.getState().setComposition({ ...doc, fps: 30 });
    useProjectStore.getState().setComposition({ ...doc, fps: 24 });
    endGesture();
    expect(isDirty(useProjectStore.getState())).toBe(true);
    expect(useProjectStore.temporal.getState().pastStates).toHaveLength(1);
    undo();
    expect(useProjectStore.getState()).toMatchObject({ composition: doc, output: { fps: 60 } });
    redo();
    expect(useProjectStore.getState()).toMatchObject({ composition: { fps: 24 }, output: { fps: 24 } });
  });
});
