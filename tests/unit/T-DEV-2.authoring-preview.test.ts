import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveCurrentSource } from '../../apps/desktop/src/renderer/app/editorHost';

const { state, trySwap, commit, discard, hotSwapTemplate, writeSource } = vi.hoisted(() => {
  const ref = { id: 'user.test.preview', version: '1.0.0' };
  return {
    state: { composition: null, template: { ref, params: [], code: 'old', assets: ref }, params: {}, handle: null, output: { width: 320, height: 180, fps: 60 } },
    trySwap: vi.fn(), commit: vi.fn((apply: () => void) => apply()), discard: vi.fn(), hotSwapTemplate: vi.fn(), writeSource: vi.fn(),
  };
});

vi.mock('../../apps/desktop/src/renderer/features/preview/previewEngine', () => ({ previewEngine: { trySwap } }));
vi.mock('../../apps/desktop/src/renderer/features/preview/hotReload', () => ({
  diagnosticFrom: (error: unknown) => ({ kind: 'update', severity: 'error', code: 'update-failed', message: String(error) }),
}));
vi.mock('../../apps/desktop/src/renderer/stores/projectStore', () => ({ useProjectStore: { getState: () => state }, hotSwapTemplate }));
vi.mock('../../apps/desktop/src/renderer/app/hostUi', () => ({ createHostUi: vi.fn() }));

const source = 'export default { setup() { return { duration: 2, update() {} }; } };';
const manifest = JSON.stringify({ ...state.template.ref, formatVersion: 1, name: 'Preview', category: 'overlay', params: [] });
const save = () => saveCurrentSource(state.template.ref, { source, manifest }, 'a'.repeat(64));
const readSource = async () => ({ ok: true, version: 'a'.repeat(64), source: 'old', manifest });

describe('T-DEV-2 保存后才切换备用 Worker', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('试运行失败不写磁盘、不切换当前预览', async () => {
    vi.stubGlobal('window', { allay: { templates: { readSource, writeSource } } });
    trySwap.mockResolvedValueOnce({ ok: false, error: new Error('update failed') });
    expect(await save()).toMatchObject({ ok: false, error: 'invalid', diagnostics: [{ kind: 'update' }] });
    expect(writeSource).not.toHaveBeenCalled();
    expect(hotSwapTemplate).not.toHaveBeenCalled();
  });

  it('磁盘冲突只销毁备用 Worker；成功才提交试载的预览', async () => {
    vi.stubGlobal('window', { allay: { templates: { readSource, writeSource } } });
    trySwap.mockResolvedValue({ ok: true, commit, discard });
    writeSource.mockResolvedValueOnce({ ok: false, error: 'conflict', currentVersion: 'b'.repeat(64) });
    expect(await save()).toMatchObject({ ok: false, error: 'conflict' });
    expect(discard).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    expect(hotSwapTemplate).not.toHaveBeenCalled();
    writeSource.mockResolvedValueOnce({ ok: true, version: 'c'.repeat(64) });
    expect(await save()).toMatchObject({ ok: true });
    expect(commit).toHaveBeenCalledOnce();
    expect(hotSwapTemplate).toHaveBeenCalledWith(expect.objectContaining({ code: source }), {}, expect.any(Function));
  });

  it('校验期间不接受第二次保存，切换目标后不写入', async () => {
    vi.stubGlobal('window', { allay: { templates: { readSource, writeSource } } });
    let finishTrial: () => void = () => undefined;
    trySwap.mockReturnValueOnce(new Promise((resolve) => { finishTrial = () => resolve({ ok: true, commit, discard }); }));
    let selected = true;
    const pending = saveCurrentSource(state.template.ref, { source, manifest }, 'a'.repeat(64), () => selected);
    await vi.waitFor(() => expect(trySwap).toHaveBeenCalledOnce());
    expect(await save()).toMatchObject({ ok: false, error: 'io' });
    selected = false;
    finishTrial();
    expect(await pending).toMatchObject({ ok: false, error: 'io' });
    expect(discard).toHaveBeenCalledOnce();
    expect(writeSource).not.toHaveBeenCalled();
  });

  it('外部改动使基础版本过期时不启动 Worker、不写盘', async () => {
    vi.stubGlobal('window', { allay: { templates: { readSource: async () => ({ ...await readSource(), version: 'b'.repeat(64) }), writeSource } } });
    expect(await save()).toMatchObject({ ok: false, error: 'conflict', currentVersion: 'b'.repeat(64) });
    expect(trySwap).not.toHaveBeenCalled();
    expect(writeSource).not.toHaveBeenCalled();
  });
});
