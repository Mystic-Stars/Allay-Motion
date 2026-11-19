import { describe, expect, it, vi } from 'vitest';
import { compileTransform, framePosition, localFrame, placeCue } from '../../packages/engine/src/composition-timing';
import { cueWindow, scheduleCues } from '../../apps/desktop/src/renderer/audio/schedule';
import { ExportStartSchema } from '../../apps/desktop/src/shared/export';
import { ExportRun } from '../../apps/desktop/src/renderer/features/export/exportRunner';
import { EngineHost } from '../../apps/desktop/src/renderer/engine-host/EngineHost';
import type { AudioCue, CompositionClip, CompositionLoadResult, CompositionLoadRequest } from '../../packages/template-sdk/src/index';

vi.mock('../../apps/desktop/src/renderer/engine-host/resource-client', () => ({
  createResolver: () => async () => null, loadStamp: () => '', profileStamp: () => '',
}));
vi.mock('../../apps/desktop/src/renderer/audio/app-audio', () => ({
  reportMissingSounds: vi.fn(), soundBank: { prepare: async () => ({ voices: [], missing: [] }) },
}));

const clip: CompositionClip = {
  id: 'clip', template: { id: 'test.engine.fixture', version: '1.0.0' }, params: {}, startFrame: 60, durationFrames: 60, sourceInFrame: 30,
  transform: { x: 10 }, keyframes: [{ frame: 40, x: 90 }, { frame: 20, opacity: 0 }],
};
const cue: AudioCue = { sound: 'test:clip', at: 0.25, gain: 1, rate: 2, pan: 0, variant: null };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('T-EXP-COMP 合成帧边界与快照', () => {
  it('按半开片段、相对关键帧及播放速率计算音频裁切', () => {
    expect(localFrame(clip, framePosition(60 / 60, 60))).toBe(0);
    expect(localFrame(clip, framePosition(120 / 60, 60))).toBeNull();
    const transform = compileTransform(clip);
    expect({ ...transform(30) }).toMatchObject({ x: 70, opacity: 0 });
    expect({ ...transform(10) }).toMatchObject({ x: 30, opacity: 0.5 });
    const placed = placeCue(cue, clip, 60, 120, 'profile')!;
    expect(placed).toMatchObject({ at: 1, clip: { offset: 0.25, end: 2, profile: 'profile' } });
    expect(cueWindow(placed, 4, 2, 1.25)).toEqual({ start: 1.25, offset: 1, end: 2 });
    expect(cueWindow(placed, 0.5, 2, 0)).toBeNull();
    expect(placeCue({ ...cue, at: 1.5 }, clip, 60, 120)).toBeNull();
    expect(cueWindow(cue, 4, 2, 1)).toBeNull();
  });

  it('同一事件的重叠片段各有音源，独立计算裁切和 seek 后的窗口', () => {
    const sources = Array.from({ length: 2 }, () => ({ playbackRate: { value: 0 }, start: vi.fn(), stop: vi.fn(), connect }));
    function connect() { return { connect }; }
    let index = 0;
    const context = {
      createBufferSource: () => sources[index++]!,
      createGain: () => ({ gain: { value: 0 }, connect }),
      createStereoPanner: () => ({ pan: { value: 0 }, connect }),
    } as unknown as BaseAudioContext;
    const buffer = { duration: 5 } as AudioBuffer;
    const voices = [
      { cue: { ...cue, at: 1, clip: { offset: 0.25, end: 2 } }, buffer },
      { cue: { ...cue, at: 1.5, clip: { offset: 0, end: 3 } }, buffer },
    ];
    expect(scheduleCues(context, {} as AudioNode, voices, { from: 1.25, startAt: 10, until: 2.5 })).toHaveLength(2);
    expect(sources[0]!.start).toHaveBeenCalledExactlyOnceWith(10, 1);
    expect(sources[0]!.stop).toHaveBeenCalledExactlyOnceWith(10.75);
    expect(sources[1]!.start).toHaveBeenCalledExactlyOnceWith(10.25, 0);
    expect(sources[1]!.stop).toHaveBeenCalledExactlyOnceWith(11.25);
  });

  it('五分钟只导出 18000 帧，上一帧未确认不请求下一帧，且改工程不改任务', async () => {
    let next = 0;
    let acknowledged = 0;
    let seen: CompositionLoadRequest | undefined;
    const result: CompositionLoadResult = { duration: 300, totalFrames: 18_000, cutTime: null, warnings: [], audioCues: [] };
    const host = {
      dispose: vi.fn(),
      loadComposition: async (req: CompositionLoadRequest) => { seen = req; return result; },
      renderFrame: async (index: number) => {
        if (index !== next || acknowledged !== index) throw new Error('frame rendered before write acknowledgement');
        next++;
        return new Uint8Array(4);
      },
    };
    const create = vi.spyOn(EngineHost, 'create').mockResolvedValue(host as unknown as EngineHost);
    const pending = deferred();
    const first = deferred();
    const start = vi.fn(async (req: unknown) => {
      expect(ExportStartSchema.parse(req)).toMatchObject({ fps: 60, totalFrames: 18_000 });
      return { ok: true, job: { jobId: 'job', encoder: null } };
    });
    vi.stubGlobal('window', { allay: { export: {
      start,
      writeFrame: async () => { if (acknowledged === 0) { first.resolve(); await pending.promise; } acknowledged++; return { ok: true }; },
      finish: async () => ({ ok: true, path: 'result.mov', frames: acknowledged }),
      cancel: vi.fn(),
    } } });
    try {
      const composition = { formatVersion: 1 as const, fps: 60 as const, durationFrames: 18_000, tracks: [] };
      const run = new ExportRun({ composition, template: null, params: {}, output: { width: 64, height: 64, fps: 30 }, preset: 'prores4444',
        quality: 'draft', shutterAngle: 180, key: '#00ff00', suggestedName: 'fixture' }, () => undefined);
      composition.durationFrames = 1;
      const finished = run.run();
      await Promise.race([first.promise, finished]);
      expect(next).toBe(1);
      expect(seen?.composition.durationFrames).toBe(18_000);
      pending.resolve();
      expect(await finished).toMatchObject({ kind: 'done', frames: 18_000, fps: 60 });
      expect(next).toBe(18_000);
    } finally {
      pending.resolve();
      vi.unstubAllGlobals();
      create.mockRestore();
    }
  });

  it('等待写入时取消，只清理一次且不再渲染', async () => {
    const startedWriting = deferred();
    const unblockWrite = deferred();
    const dispose = vi.fn();
    const renderFrame = vi.fn(async () => new Uint8Array(4));
    const create = vi.spyOn(EngineHost, 'create').mockResolvedValue({
      loadComposition: async () => ({ duration: 1, totalFrames: 60, cutTime: null, warnings: [], audioCues: [] }),
      dispose, renderFrame,
    } as unknown as EngineHost);
    const finish = vi.fn();
    const cancel = vi.fn(async () => { unblockWrite.resolve(); });
    vi.stubGlobal('window', { allay: { export: {
      start: async () => ({ ok: true, job: { jobId: 'job', encoder: null } }),
      writeFrame: async () => { startedWriting.resolve(); await unblockWrite.promise; return { ok: true }; },
      finish, cancel,
    } } });
    try {
      const run = new ExportRun({ composition: { formatVersion: 1, fps: 60, durationFrames: 60, tracks: [] }, template: null, params: {},
        output: { width: 64, height: 64, fps: 60 }, preset: 'png-sequence', quality: 'draft', shutterAngle: 180, key: '#00ff00', suggestedName: 'fixture' }, () => undefined);
      const finished = run.run();
      await Promise.race([startedWriting.promise, finished]);
      await run.cancel();
      expect(await finished).toEqual({ kind: 'canceled' });
      expect(cancel).toHaveBeenCalledExactlyOnceWith('job');
      expect(dispose).toHaveBeenCalled();
      expect(renderFrame).toHaveBeenCalledTimes(1);
      expect(finish).not.toHaveBeenCalled();
    } finally {
      unblockWrite.resolve();
      vi.unstubAllGlobals();
      create.mockRestore();
    }
  });
});
