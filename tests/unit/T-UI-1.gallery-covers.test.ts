import { afterEach, expect, it, vi } from 'vitest';
import type { TemplateEntry } from '../../apps/desktop/src/shared/templates';
import { coverKey, covers, useCoverStore } from '../../apps/desktop/src/renderer/features/gallery/covers';
import { useResourceStore } from '../../apps/desktop/src/renderer/stores/resourceStore';
import { useProjectStore } from '../../apps/desktop/src/renderer/stores/projectStore';

const mocks = vi.hoisted(() => ({ read: vi.fn(), frame: vi.fn(), at: vi.fn(), open: vi.fn(), dispose: vi.fn(), close: vi.fn() }));
vi.mock('../../apps/desktop/src/renderer/engine-host/EngineHost', () => ({ EngineHost: { create: async () => ({ dispose: mocks.dispose }) } }));
vi.mock(import('../../apps/desktop/src/renderer/templates/catalog'), async importOriginal => ({ ...await importOriginal(), readTemplate: mocks.read }));
vi.mock('../../apps/desktop/src/renderer/engine-host/still', () => ({ STILL_FAST: {}, openStill: mocks.open }));

function entry(name: string): TemplateEntry {
  const id = `allay.builtin.${name}`;
  const version = '1.0.0';
  return { id, version, kind: 'script', source: 'builtin', baseMissing: false, trialWarnings: [], manifest: { formatVersion: 1, id, version, category: 'overlay', name, params: [] } };
}
const source = (id: string) => ({ ref: { id }, code: 'export default {}', params: [] });
function setup() {
  mocks.open.mockResolvedValue({ frames: 4, duration: 0.1, cutTime: null, at: mocks.at, frame: mocks.frame });
  mocks.read.mockImplementation(async (id: string) => source(id));
  vi.stubGlobal('OffscreenCanvas', class {
    getContext() { return { putImageData() {} }; }
    async convertToBlob() { return new Blob(['png']); }
    transferToImageBitmap() { return { close: mocks.close }; }
  });
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); useResourceStore.setState({ state: null }); });

it('T-UI-1 当前页每卡只渲一帧；悬停才建图集，最后的使用者离开后释放位图和 URL', async () => {
  setup();
  const revoke = vi.spyOn(URL, 'revokeObjectURL');
  const entries = [entry('one'), entry('two')];
  const leave = covers.ensure(entries);
  const key = coverKey(entries[0]!.id, '1.0.0');
  await vi.waitFor(() => expect(Object.keys(useCoverStore.getState().covers)).toHaveLength(2));
  expect(mocks.at).toHaveBeenCalledTimes(2);
  expect(mocks.frame).not.toHaveBeenCalled();
  const stop = covers.animate(entries[0]!);
  const stopAgain = covers.animate(entries[0]!);
  await vi.waitFor(() => expect(useCoverStore.getState().covers[key]?.sheet).toBeTruthy());
  expect(mocks.frame).toHaveBeenCalledTimes(4);
  stop();
  expect(mocks.close).not.toHaveBeenCalled();
  stopAgain();
  expect(mocks.close).toHaveBeenCalledTimes(1);
  expect(useCoverStore.getState().covers[key]?.url).toMatch(/^blob:/);
  expect(useCoverStore.getState().covers[key]?.sheet).toBeNull();
  leave();
  expect(useCoverStore.getState().covers).toEqual({});
  expect(revoke).toHaveBeenCalledTimes(2);
});

it('T-UI-1 快速翻页丢弃旧队列；资源变化只重建当前页，迟到的旧封面不能覆盖它', async () => {
  setup();
  let resolveOld!: (value: ReturnType<typeof source>) => void;
  mocks.read.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
  const leave = covers.ensure([entry('old'), entry('obsolete')]);
  leave();
  const current = entry('current');
  const key = coverKey(current.id, current.version);
  const close = covers.ensure([current]);
  resolveOld(source('allay.builtin.old'));
  await vi.waitFor(() => expect(Object.keys(useCoverStore.getState().covers)).toEqual([key]));
  const url = useCoverStore.getState().covers[key]!.url;
  useResourceStore.setState({ state: { stamp: 'replacement', layers: [], brokenPacks: [], detecting: false, hasAssets: false, download: { status: 'idle' },
    vanilla: { active: null, enabled: false, consent: false, problem: null, local: null, cached: null } } });
  await vi.waitFor(() => expect(useCoverStore.getState().covers[key]?.url).toMatch(/^blob:/));
  expect(useCoverStore.getState().covers[key]?.url).not.toBe(url);
  expect(mocks.read.mock.calls.map(args => args[0])).toEqual(['allay.builtin.old', current.id, current.id]);
  expect(mocks.at).toHaveBeenCalledTimes(2);
  expect(mocks.frame).not.toHaveBeenCalled();
  expect(mocks.dispose).toHaveBeenCalledTimes(2);
  close();
});

it('T-UI-1 合成图库的静帧和悬停使用工程档案；激活栈变化不污染它，覆盖包变动才重画', async () => {
  setup();
  const profile = { id: 'pinned', name: 'pinned', source: 'downloaded' as const, versionId: '26.3', gameDir: null, resourcePacksDir: null, sourcePath: '', missing: false, stamp: 'one' };
  const resources = { stamp: 'global', layers: [], brokenPacks: [], detecting: false, hasAssets: true, download: { status: 'idle' as const },
    vanilla: { active: null, enabled: false, consent: false, problem: null, local: null, cached: null },
    library: { activeProfileId: null, pinnedId: null, profiles: [profile] } };
  useResourceStore.setState({ state: resources });
  useProjectStore.setState({ composition: { formatVersion: 1, fps: 30, durationFrames: 30, tracks: [], defaultProfile: profile.id } });
  const card = entry('profile-test');
  const release = covers.ensure([card]);
  const end = covers.animate(card);
  try {
    await vi.waitFor(() => expect(mocks.frame).toHaveBeenCalledTimes(4));
    useResourceStore.setState({ state: { ...resources, stamp: 'other-active' } });
    expect(mocks.read).toHaveBeenCalledTimes(2);
    useResourceStore.setState({ state: { ...resources, library: { ...resources.library, profiles: [{ ...profile, stamp: 'two' }] } } });
    await vi.waitFor(() => expect(mocks.frame).toHaveBeenCalledTimes(8));
    expect(mocks.at).toHaveBeenCalledTimes(2);
    expect(mocks.open.mock.calls.map(([, request]) => request.profileId)).toEqual(Array(4).fill(profile.id));
  } finally {
    end(); release(); useProjectStore.setState({ composition: null });
  }
});
