// 音效选择器的库与按需取回（docs/decisions.md M6b）：
// - 库 = 资源栈合并后的 sounds.json 里的全部事件（主进程算，带可用状态），resourceStamp 变了就重新取；
// - 用户试听或选中某个音效、或在导出前确认取回时，才让主进程取回下载缓存里还没取的音效对象（联网只经 fetchObject）。
//   不做后台批量下载；离线取不到时标成不可用并提示，不报错。
import i18next from 'i18next';
import { ImportedSoundIdSchema, type SoundKind } from '@allay/assets';
import { create } from 'zustand';
import type { SoundFileState, SoundLibrary } from '../../shared/resources';
import { notify } from '../stores/noticeStore';
import { useResourceStore } from '../stores/resourceStore';

interface SoundLibraryState {
  stamp: string | null;
  events: SoundLibrary['events'];
  loading: boolean;
  namesDownloadable: boolean;
}

export const useSoundLibraryStore = create<SoundLibraryState>(() => ({ stamp: null, events: [], loading: true, namesDownloadable: false }));

let seq = 0;
export async function refreshSoundLibrary(): Promise<void> {
  const mine = ++seq;
  useSoundLibraryStore.setState({ loading: true });
  try {
    const [lib, imports] = await Promise.all([window.allay.resources.soundLibrary(), window.allay.sound.list().catch(() => [])]);
    const imported: SoundLibrary['events'] = imports.map(({ id, name, kind }) => ({ id, kind, names: { 'zh-CN': name, en: name, chinese: 'custom' }, source: 'imported', state: 'local', variantCount: 1 }));
    if (mine === seq) useSoundLibraryStore.setState({ stamp: lib.stamp, events: [...imported, ...lib.events], loading: false, namesDownloadable: lib.namesDownloadable ?? false });
  } catch (error) {
    console.warn('[audio] sound library failed', error);
    if (mine === seq) useSoundLibraryStore.setState({ events: [], loading: false, namesDownloadable: false });
  }
}

export async function fetchSoundNames(): Promise<void> {
  try {
    await window.allay.sound.fetchNames();
  } catch {
    notify('info', i18next.t('editor.sound.downloadNamesFailed'));
  } finally {
    await refreshSoundLibrary();
  }
}

export async function importSound(kind: SoundKind): Promise<string | null> {
  try {
    const item = await window.allay.sound.pick(kind);
    if (!item) return null;
    await refreshSoundLibrary();
    return item.id;
  } catch {
    notify('info', i18next.t('editor.sound.importFailed'));
    return null;
  }
}

let started = false;
/** 应用启动时调用一次：先取一次，之后资源栈一变就重新取 */
export function startSoundLibrary(): void {
  if (started) return;
  started = true;
  void refreshSoundLibrary();
  useResourceStore.subscribe((s, prev) => {
    if (s.state?.stamp !== prev.state?.stamp) void refreshSoundLibrary();
  });
}

/**
 * 音效文件的状态；fetch 为真时取回 remote 的（用户操作触发）。取回了东西就刷新库；
 * 取不到（离线、校验失败）时提示一次，返回的状态里它们仍是 remote。
 */
export async function soundFileStates(files: readonly string[], fetch: boolean, profile?: string): Promise<Record<string, SoundFileState>> {
  if (files.length === 0) return {};
  const unique = [...new Set(files)].filter((file) => !ImportedSoundIdSchema.safeParse(file).success).slice(0, 256);
  if (unique.length === 0) return {};
  const r = await window.allay.resources.soundFiles(unique, fetch, profile).catch(() => null);
  if (!r) return Object.fromEntries(unique.map((f) => [f, 'missing' as const]));
  if (fetch) {
    // 音效库不缓存“缺失”，取回之后下次解码就能读到；选择器的库重新取一次状态
    if (unique.some((f) => r.states[f] === 'local')) void refreshSoundLibrary();
    if (!r.ok) notify('info', i18next.t('audio.fetchFailed'));
  }
  return r.states;
}

/** 一个事件全部变体的音效名 */
export async function eventFiles(eventId: string): Promise<string[]> {
  const variants = (await window.allay.resources.soundVariants(eventId).catch(() => null)) ?? [];
  return variants.filter((v) => v.weight > 0).map((v) => v.file);
}

/** 用户在选择器里选中了一个音效：把它全部变体里还没取回的取回来（预览、导出都要用） */
export async function prepareSound(eventId: string): Promise<void> {
  if (ImportedSoundIdSchema.safeParse(eventId).success) return;
  const files = await eventFiles(eventId);
  const states = await soundFileStates(files, false);
  const remote = files.filter((f) => states[f] === 'remote');
  if (remote.length > 0) await soundFileStates(remote, true);
}
