import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BaseWindow, MessageBoxOptions, MessageBoxReturnValue } from 'electron';
import { expect, it, vi } from 'vitest';
import type { createIpcRegistrar } from '../../apps/desktop/src/main/ipc';
import { registerSkinHandlers } from '../../apps/desktop/src/main/skins/handlers';
import { encodePng } from '../../scripts/mascot-bake/png';

it('T-SKIN-2 主进程每次查名前单独询问；拒绝后不发请求，同意后存入离线库', async () => {
  const root = await mkdtemp(join(tmpdir(), 'allay-skins-consent-'));
  try {
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    const handle = (channel: string, callback: (...args: unknown[]) => Promise<unknown>) => { handlers.set(channel, callback); };
    const getWindow = () => ({ isDestroyed: () => false }) as ReturnType<Parameters<typeof registerSkinHandlers>[2]>;
    const showMessageBox = vi.fn<(...args: [MessageBoxOptions] | [BaseWindow, MessageBoxOptions]) => Promise<MessageBoxReturnValue>>();
    const fetchSkin = vi.fn<NonNullable<Parameters<typeof registerSkinHandlers>[4]>['fetch']>();
    registerSkinHandlers({ handle } as ReturnType<typeof createIpcRegistrar>, root, getWindow, { showMessageBox, showOpenDialog: vi.fn() }, { fetch: fetchSkin });
    const lookup = handlers.get('skins:fetchJava')!;
    const list = handlers.get('skins:list')!;
    const name = 'Test_123';
    expect(await list()).toEqual([]);
    expect(showMessageBox).not.toHaveBeenCalled();
    expect(fetchSkin).not.toHaveBeenCalled();
    showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false });
    expect(await lookup(null, name, 'en')).toEqual({ status: 'canceled' });
    expect(showMessageBox).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ cancelId: 0, defaultId: 0, detail: expect.stringContaining(name) }));
    expect(fetchSkin).not.toHaveBeenCalled();
    showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false });
    fetchSkin.mockResolvedValueOnce({ name, model: 'slim', bytes: encodePng({ width: 64, height: 64, data: new Uint8Array(64 * 64 * 4) }) });
    const entry = expect.objectContaining({ name, model: 'slim', height: 64, source: 'java' });
    expect(await lookup(null, name, 'zh-CN')).toEqual({ status: 'added', entry });
    expect(fetchSkin).toHaveBeenCalledExactlyOnceWith(name);
    showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false });
    expect(await lookup(null, name, 'en')).toEqual({ status: 'canceled' });
    expect(showMessageBox).toHaveBeenCalledTimes(3);
    expect(fetchSkin).toHaveBeenCalledTimes(1);
    expect(await list()).toEqual([entry]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
