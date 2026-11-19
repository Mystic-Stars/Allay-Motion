import { expect, it, vi } from 'vitest';
import { EngineHost } from '../../apps/desktop/src/renderer/engine-host/EngineHost';
import { PreviewEngine } from '../../apps/desktop/src/renderer/features/preview/previewEngine';
import { startSegmentGesture } from '../../apps/desktop/src/renderer/features/transport/segment-gesture';
import { usePreviewStore } from '../../apps/desktop/src/renderer/stores/previewStore';
import { clearHistory, useProjectStore } from '../../apps/desktop/src/renderer/stores/projectStore';
import { useTransportStore } from '../../apps/desktop/src/renderer/stores/transportStore';
import { TemplateManifestSchema, type LoadResult } from '../../packages/template-sdk/src/index';

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => { resolve = complete; });
  return { promise, resolve };
}

it('T-UI-2 取消拖动后，过时的同结构参数回包不禁用时间轴也不覆盖时长', async () => {
  const manifest = TemplateManifestSchema.parse({
    formatVersion: 1, id: 'test.exit', version: '1.0.0', name: 'Exit', category: 'transition',
    params: [{ key: 'outDuration', type: 'duration', label: 'Out', default: 0.5, min: 0.15, max: 2 }],
  });
  const template = { ref: { id: manifest.id, version: manifest.version }, manifest, params: manifest.params!, hidden: [], code: '', assets: null };
  const result = (duration: number): LoadResult => ({ duration, cutTime: null, audioCues: [], warnings: [] });
  const stale = deferred<LoadResult>();
  const restored = deferred<LoadResult>();
  const replayStarted = deferred<'setParams' | 'load'>();
  const host = {
    load: vi.fn().mockResolvedValueOnce(result(1.1)).mockImplementation(() => {
      replayStarted.resolve('load');
      return restored.promise;
    }),
    setParams: vi.fn().mockReturnValueOnce(stale.promise).mockImplementation(() => {
      replayStarted.resolve('setParams');
      return restored.promise;
    }),
    render: vi.fn().mockResolvedValue(undefined),
  };
  const create = vi.spyOn(EngineHost, 'create').mockResolvedValue(host as unknown as EngineHost);
  const engine = new PreviewEngine();
  const frames: FrameRequestCallback[] = [];
  const project = useProjectStore.getState();
  const preview = usePreviewStore.getState();
  const transport = useTransportStore.getState();
  vi.stubGlobal('document', { createElement: () => ({ dataset: {}, style: {} }) });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  try {
    project.reset({ template, name: null, handle: null });
    clearHistory();
    engine.mount({ replaceChildren: vi.fn() } as unknown as HTMLElement);
    await vi.waitFor(() => expect(engine.loadedProjectRevision).toBe(useProjectStore.getState().revision));

    const finish = startSegmentGesture();
    project.setParams({ outDuration: 0.4 });
    expect(useProjectStore.getState().params.outDuration).toBe(0.4);
    engine.reload();
    frames.shift()!(0);
    await vi.waitFor(() => expect(host.setParams).toHaveBeenCalledWith({ outDuration: 0.4 }));

    project.setParams({ outDuration: 0.5 });
    finish();
    stale.resolve(result(1));
    expect(await replayStarted.promise).toBe('setParams');
    expect(host.setParams).toHaveBeenLastCalledWith({ outDuration: 0.5 });
    expect(usePreviewStore.getState().status.kind).toBe('ready');
    expect(useTransportStore.getState().duration).toBe(1.1);
    expect(engine.loadedProjectRevision).not.toBe(useProjectStore.getState().revision);

    restored.resolve(result(1.1));
    await vi.waitFor(() => expect(engine.loadedProjectRevision).toBe(useProjectStore.getState().revision));
  } finally {
    engine.mount(null);
    clearHistory();
    useProjectStore.setState(project);
    usePreviewStore.setState(preview);
    useTransportStore.setState(transport);
    create.mockRestore();
    vi.unstubAllGlobals();
  }
});
