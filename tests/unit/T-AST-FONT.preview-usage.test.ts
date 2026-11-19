import { expect, it, vi } from 'vitest';
import { FontUsageFlag, TemplateManifestSchema } from '../../packages/template-sdk/src/index';
import { EngineHost } from '../../apps/desktop/src/renderer/engine-host/EngineHost';
import { PreviewEngine } from '../../apps/desktop/src/renderer/features/preview/previewEngine';
import { usePreviewStore } from '../../apps/desktop/src/renderer/stores/previewStore';
import { clearHistory, useProjectStore } from '../../apps/desktop/src/renderer/stores/projectStore';
import { useResourceStore } from '../../apps/desktop/src/renderer/stores/resourceStore';
import { useTransportStore } from '../../apps/desktop/src/renderer/stores/transportStore';

it('T-AST-FONT 资源栈切换立即清除来源提示，迟到回包不覆盖新结果', async () => {
  const ref = { id: 'test.preview.font-usage', version: '1.0.0' };
  const manifest = TemplateManifestSchema.parse({ formatVersion: 1, ...ref, name: 'Fixture', category: 'overlay', params: [] });
  const template = { ref, manifest, params: [], hidden: [], code: 'fixture', assets: null };
  const result = { duration: 1, cutTime: null, audioCues: [], warnings: [] };
  const fontUsage = [{ flags: FontUsageFlag.whole | FontUsageFlag.resourceDefault }];
  const render = vi.fn<EngineHost['render']>().mockImplementation(async (time) => ({ t: time, ms: 0, fontUsage }));
  const create = vi.spyOn(EngineHost, 'create').mockResolvedValue({ render, load: vi.fn().mockResolvedValue(result) } as unknown as EngineHost);
  const project = useProjectStore.getState();
  const transport = useTransportStore.getState();
  const preview = usePreviewStore.getState();
  const resources = useResourceStore.getState();
  const engine = new PreviewEngine();
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('document', { createElement: () => ({ dataset: {}, style: {} }) });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  try {
    project.reset({ template, name: null, handle: null });
    engine.mount({ replaceChildren: vi.fn() } as unknown as HTMLElement);
    await vi.waitFor(() => expect(usePreviewStore.getState().fontUsage).toEqual(fontUsage));
    let finish!: (stats: Awaited<ReturnType<EngineHost['render']>>) => void;
    render.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    engine.requestRender(0.25);
    expect(render).toHaveBeenCalledTimes(2);

    resources.replace({ stamp: 'new-font-stack', layers: [], brokenPacks: [], hasAssets: true, detecting: false,
      vanilla: { consent: true, enabled: true, active: 'cached', cached: { versionId: '26.3' }, local: null, problem: null }, download: { status: 'idle' } });
    expect(usePreviewStore.getState().fontUsage).toEqual([]);
    const changes: (typeof fontUsage)[] = [];
    const unsubscribe = usePreviewStore.subscribe((state) => { if (state.fontUsage.length) changes.push([...state.fontUsage]); });
    try {
      finish({ t: 0.25, ms: 0, fontUsage });
      render.mockImplementation(async (time) => ({ t: time, ms: 0 }));
      engine.reload();
      frames.shift()!(0);
      await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(3));
      expect(changes).toEqual([]);
    } finally { unsubscribe(); }
  } finally {
    engine.mount(null);
    clearHistory();
    useProjectStore.setState(project);
    useTransportStore.setState(transport);
    usePreviewStore.setState(preview);
    useResourceStore.setState(resources);
    create.mockRestore();
    vi.unstubAllGlobals();
  }
});
