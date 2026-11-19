import { afterEach, expect, it, vi } from 'vitest';
import { appendTemplate } from '../../apps/desktop/src/renderer/features/gallery/appendTemplate';
import { CORE_COMMANDS } from '../../apps/desktop/src/renderer/features/commands/commands';
import { dispatch, registerCommand } from '../../apps/desktop/src/renderer/app/registry';
import { clearHistory, undo, useProjectStore } from '../../apps/desktop/src/renderer/stores/projectStore';
import { useUiStore } from '../../apps/desktop/src/renderer/stores/uiStore';
import { readTemplate, type TemplateSource } from '../../apps/desktop/src/renderer/templates/catalog';
import type { TemplateEntry } from '../../apps/desktop/src/shared/templates';
import type { Composition } from '../../packages/template-sdk/src/composition';

vi.mock('../../apps/desktop/src/renderer/templates/catalog', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  readTemplate: vi.fn(),
}));

const ref = { id: 'allay.builtin.block-wipe', version: '1.0.0' };
const entry = { ...ref, baseMissing: false } as TemplateEntry;
const source = { ref, manifest: {}, params: [] } as unknown as TemplateSource;
const translate = ((key: string) => key) as Parameters<typeof appendTemplate>[3];
const composition: Composition = {
  formatVersion: 1, fps: 60, durationFrames: 300,
  tracks: [{ id: 'locked', name: 'Locked', locked: true, muted: false, clips: [
    { id: 'original', template: ref, params: {}, startFrame: 0, durationFrames: 60, sourceInFrame: 0 },
  ] }],
};

afterEach(() => {
  useProjectStore.getState().reset({ template: null, name: null, handle: null });
  clearHistory();
  useUiStore.setState({ workspaceView: 'preview', codeOpened: false });
  vi.resetAllMocks();
});

it('T-STUDIO 返回预览只改变视图；图库跳过锁轨、保留已有片段且可撤销', async () => {
  useProjectStore.getState().reset({ template: null, composition, name: 'existing', handle: null });
  clearHistory();
  useUiStore.setState({ workspaceView: 'code', codeOpened: true });
  const unregister = registerCommand(CORE_COMMANDS.find(({ id }) => id === 'showPreview')!);
  try {
    const before = useProjectStore.getState();
    await dispatch('showPreview');
    expect(useUiStore.getState().workspaceView).toBe('preview');
    expect(useProjectStore.getState()).toBe(before);

    vi.mocked(readTemplate).mockResolvedValueOnce(source);
    const selection = await appendTemplate(entry, 'locked', 'en', translate);
    const next = useProjectStore.getState().composition;
    expect(next?.tracks[0]).toStrictEqual(composition.tracks[0]);
    expect(next?.tracks[1]).toMatchObject({ id: selection?.trackId, locked: false, clips: [{ id: selection?.clipId, template: ref }] });
    expect(useProjectStore.temporal.getState().pastStates).toHaveLength(1);
    undo();
    expect(useProjectStore.getState().composition).toStrictEqual(composition);
  } finally {
    unregister();
  }
});
