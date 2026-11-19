import { create } from 'zustand';
import type { UpdateChannel, UpdateState } from '../../../shared/updates';
import { useUiStore } from '../../stores/uiStore';

// 自动更新的界面状态（docs/decisions.md“自动更新”）：联网、下载、安装都在主进程，这里只存主进程推来的状态、转发指令。

interface UpdateStore {
  state: UpdateState | null;
  switchingChannel: UpdateChannel | null;
  channelSaveFailed: boolean;
  setChannel(channel: UpdateChannel): Promise<void>;
  invalidate(): void;
  receive(state: UpdateState): boolean;
  load(): Promise<void>;
  check(expected: UpdateState): Promise<void>;
  download(expected: UpdateState): Promise<void>;
  cancel(expected: UpdateState): Promise<void>;
  install(expected: UpdateState): Promise<void>;
}

const getPrefs = () => useUiStore.getState().settings.updates;

export const useUpdateStore = create<UpdateStore>((set, get) => {
  let revision = 0;

  async function request(action: 'state' | 'check' | 'download' | 'install', expected?: UpdateState): Promise<void> {
    if (get().switchingChannel || (expected && get().state !== expected)) return;
    const started = ++revision;
    const channel = getPrefs().channel;
    const state = await window.allay.updates[action]();
    if (started === revision && state.channel === channel && channel === getPrefs().channel) set({ state });
  }

  return {
    state: null,
    switchingChannel: null,
    channelSaveFailed: false,
    async setChannel(channel) {
      const prefs = getPrefs();
      if (get().switchingChannel || prefs.channel === channel) return;
      revision++;
      set({ switchingChannel: channel, state: null, channelSaveFailed: false });
      try {
        await window.allay.settings.set({ updates: { ...prefs, channel, skipVersion: null } });
      } catch (error) {
        console.error('failed to save update channel', error);
        set({ channelSaveFailed: true });
      } finally {
        set({ switchingChannel: null });
      }
      if (!get().state) await get().load();
    },
    invalidate() {
      revision++;
      set({ state: null });
    },
    receive(state) {
      const pending = get().switchingChannel;
      if (state.channel !== getPrefs().channel || (pending && state.channel !== pending)) return false;
      revision++;
      set({ state });
      return true;
    },
    load: () => request('state'),
    check: (expected) => request('check', expected),
    download: (expected) => request('download', expected),
    async cancel(expected) {
      if (!get().switchingChannel && get().state === expected) await window.allay.updates.cancel();
    },
    install: (expected) => request('install', expected),
  };
});

/** 跳过这个版本：自动检查不再提示它 */
export function skipVersion(version: string | null, expected?: UpdateState): void {
  const { switchingChannel, state } = useUpdateStore.getState();
  if (switchingChannel || (expected && state !== expected)) return;
  useUiStore.getState().update({ updates: { ...getPrefs(), skipVersion: version } });
}
