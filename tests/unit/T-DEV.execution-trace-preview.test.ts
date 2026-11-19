import { expect, it, vi } from 'vitest';
import { EngineHost, type SetupTraceSample } from '../../apps/desktop/src/renderer/engine-host/EngineHost';
import { PreviewEngine, type ExecutionTraceFrame } from '../../apps/desktop/src/renderer/features/preview/previewEngine';
import { usePreviewStore } from '../../apps/desktop/src/renderer/stores/previewStore';
import { clearHistory, useProjectStore } from '../../apps/desktop/src/renderer/stores/projectStore';
import { useTransportStore } from '../../apps/desktop/src/renderer/stores/transportStore';
import { TemplateManifestSchema } from '../../packages/template-sdk/src/index';

it('T-DEV-TRACE 暂停时重画最后请求时间；忽略过期 seek 回包；无订阅者时恢复原预览', async () => {
  const target = { id: 'test.preview.trace', version: '1.0.0' };
  const manifest = TemplateManifestSchema.parse({ formatVersion: 1, ...target, name: 'Fixture', category: 'overlay', params: [] });
  const template = { ref: target, manifest, params: [], hidden: [], code: 'original source', assets: null };
  const result = { duration: 1, cutTime: null, audioCues: [], warnings: [] };
  const render = vi.fn<EngineHost['render']>().mockImplementation(async (time) => ({ t: time, ms: 0, trace: [7], traceSource: template.code }));
  const create = vi.spyOn(EngineHost, 'create').mockResolvedValue({ render, load: vi.fn().mockResolvedValue(result) } as unknown as EngineHost);
  const project = useProjectStore.getState();
  const transport = useTransportStore.getState();
  const preview = usePreviewStore.getState();
  const engine = new PreviewEngine();
  const frames: (ExecutionTraceFrame | null)[] = [];
  let unsubscribe: (() => void) | undefined;
  vi.stubGlobal('document', { createElement: () => ({ dataset: {}, style: {} }) });
  try {
    project.reset({ template, name: null, handle: null });
    transport.setPlaying(false);
    engine.mount({ replaceChildren: vi.fn() } as unknown as HTMLElement);
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1));
    engine.requestRender(0.25);
    await vi.waitFor(() => expect(render).toHaveBeenLastCalledWith(0.25, undefined, null));
    engine.setExecutionTrace(target);
    expect(render).toHaveBeenCalledTimes(2);

    let finish!: (value: Awaited<ReturnType<EngineHost['render']>>) => void;
    render.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    unsubscribe = engine.onExecutionTrace((frame) => frames.push(frame));
    expect(render).toHaveBeenLastCalledWith(0.25, undefined, target);
    engine.requestRender(0.75);
    finish({ t: 0.25, ms: 0, trace: [5], traceSource: template.code });
    await vi.waitFor(() => expect(frames.at(-1)).toEqual({ ...target, source: template.code, t: 0.75, lines: [7] }));
    expect(frames.some((frame) => frame?.t === 0.25)).toBe(false);

    unsubscribe();
    await vi.waitFor(() => expect(render).toHaveBeenLastCalledWith(0.75, undefined, null));
    expect(useTransportStore.getState().playing).toBe(false);
    expect(useTransportStore.getState().time).toBe(transport.time);
  } finally {
    unsubscribe?.();
    engine.mount(null);
    clearHistory();
    useProjectStore.setState(project);
    useTransportStore.setState(transport);
    usePreviewStore.setState(preview);
    create.mockRestore();
    vi.unstubAllGlobals();
  }
});

it('T-DEV-TRACE 初始化不跟随 seek；迟到的旧选中结果不会在重开后发布', async () => {
  const target = { id: 'test.preview.setup', version: '1.0.0' };
  const manifest = TemplateManifestSchema.parse({ formatVersion: 1, ...target, name: 'Fixture', category: 'overlay', params: [] });
  const template = { ref: target, manifest, params: [], hidden: [], code: 'setup fixture source', assets: null };
  const result = { duration: 1, cutTime: null, audioCues: [], warnings: [] };
  const render = vi.fn<EngineHost['render']>().mockImplementation(async (time) => ({ t: time, ms: 0 }));
  const create = vi.spyOn(EngineHost, 'create').mockResolvedValue({ render, load: vi.fn().mockResolvedValue(result) } as unknown as EngineHost);
  const project = useProjectStore.getState();
  const transport = useTransportStore.getState();
  const preview = usePreviewStore.getState();
  const engine = new PreviewEngine();
  const samples: (SetupTraceSample | null)[] = [];
  let unsubscribe: (() => void) | undefined;
  vi.stubGlobal('document', { createElement: () => ({ dataset: {}, style: {} }) });
  try {
    project.reset({ template, name: null, handle: null });
    transport.setPlaying(false);
    engine.mount({ replaceChildren: vi.fn() } as unknown as HTMLElement);
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1));

    const fresh = { ...target, source: template.code, lines: [18] };
    let finish!: () => void;
    render.mockImplementationOnce((time, _quality, _target, setup) => new Promise((resolve) => {
      finish = () => { setup?.({ ...fresh, lines: [5] }); resolve({ t: time, ms: 0 }); };
    }));
    unsubscribe = engine.onSetupTrace((sample) => samples.push(sample));
    engine.setExecutionTrace(target);
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(2));
    unsubscribe();
    engine.setExecutionTrace(null);

    render.mockImplementationOnce(async (time, _quality, _target, setup) => {
      setup?.(fresh);
      return { t: time, ms: 0 };
    });
    unsubscribe = engine.onSetupTrace((sample) => samples.push(sample));
    engine.setExecutionTrace(target);
    engine.requestRender(0.75);
    finish();
    await vi.waitFor(() => expect(samples).toEqual([fresh]));
    engine.requestRender(0.5);
    await vi.waitFor(() => expect(render).toHaveBeenLastCalledWith(0.5, undefined, target));
    expect(samples).toEqual([fresh]);
    engine.setExecutionTrace(null);
    expect(samples).toEqual([fresh, null]);
  } finally {
    unsubscribe?.();
    engine.mount(null);
    clearHistory();
    useProjectStore.setState(project);
    useTransportStore.setState(transport);
    usePreviewStore.setState(preview);
    create.mockRestore();
    vi.unstubAllGlobals();
  }
});
