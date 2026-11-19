// 资源栈界面的动作：调用 window.allay.resources，并把结果变成提示。
import type { TFunction } from 'i18next';
import type { AddPackResult } from '../../../shared/resources';
import { useNoticeStore } from '../../stores/noticeStore';
import { useResourceStore } from '../../stores/resourceStore';
import { useUiStore } from '../../stores/uiStore';

export function openAssetSettings(): void {
  useUiStore.getState().openDialog('settings', 'assets');
}

export async function selectVersion(t: TFunction, id: string | null): Promise<void> {
  const unavailable = () => useNoticeStore.getState().show('error', t('resources.library.unavailable'));
  try {
    const state = await window.allay.resources.selectProfile(id);
    useResourceStore.getState().replace(state);
    if (id !== null && state.library?.activeProfileId !== id) unavailable();
  } catch {
    unavailable();
  }
}

function report(t: TFunction, result: AddPackResult): void {
  const notice = useNoticeStore.getState();
  if ('canceled' in result) return;
  if (result.ok) notice.show('info', t('resources.added'));
  else notice.show('error', t(`resources.addErrors.${result.error}`));
}

export async function addPack(t: TFunction, kind: 'zip' | 'folder', reconnectId?: string): Promise<void> {
  report(t, await window.allay.resources.addPack(kind, reconnectId));
}

/** 拖进窗口的文件：一个一个交给主进程（路径由 preload 从 File 取） */
export async function addDroppedFiles(t: TFunction, files: readonly File[]): Promise<void> {
  for (const file of files) {
    try {
      report(t, await window.allay.resources.addDroppedPack(file));
    } catch {
      useNoticeStore.getState().show('error', t('resources.addErrors.unreadable'));
    }
  }
}

export async function chooseGameDir(t: TFunction, reconnectId?: string): Promise<void> {
  const r = await window.allay.resources.chooseGameDir(reconnectId);
  if ('ok' in r && !r.ok) useNoticeStore.getState().show('error', t('resources.noRelease'));
}

export async function setVanilla(patch: { consent?: boolean; enabled?: boolean }): Promise<void> {
  useResourceStore.getState().replace(await window.allay.resources.setVanilla(patch));
}

export async function selectInstalledVersion(): Promise<void> {
  const state = useResourceStore.getState().state;
  const local = state?.library?.profiles.find((entry) => !entry.missing && entry.source === 'local' && entry.versionType === 'release');
  if (local) useResourceStore.getState().replace(await window.allay.resources.selectProfile(local.id));
  else await setVanilla({ consent: true, enabled: true });
}

export function downloadVanilla(versionId?: string): void {
  // 结果（进度、失败）经 resources:changed 推过来
  void window.allay.resources.downloadVanilla(versionId);
}
