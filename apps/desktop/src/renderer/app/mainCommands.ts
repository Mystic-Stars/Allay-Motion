// 界面这一端的命令通道（docs/code-editing-and-mcp-plan.md H11；格式见 shared/host-commands.ts）：
// 主进程发来的请求先按 schema 校验，再经 dispatch 执行（和菜单、快捷键走同一个命令层，参数按命令自己的 schema 校验），
// 结果或失败原因交回主进程。write 命令的改动在撤销记录上标为来自主进程（H6）。
import i18next from 'i18next';
import { z } from 'zod';
import { HostCommandRequestSchema, HostCommandResultSchema, type HostCommandError, type HostCommandResult } from '../../shared/host-commands';
import { MAC_MENU_COMMANDS, type MacMenuState } from '../../shared/mac-menu';
import { LanguagePrefSchema, ThemeSchema } from '../../shared/settings';
import { openRecent } from '../features/project/actions';
import { installViaDialog } from '../features/templates/actions';
import { usePreviewStore } from '../stores/previewStore';
import { RevisionConflictError, useProjectStore } from '../stores/projectStore';
import { onboardingVisible, tourVisible, useUiStore } from '../stores/uiStore';
import { CommandError, commandEnabled, defineCommand, dispatch, getCommand, registerCommand, useRegistry } from './registry';

function errorOf(error: unknown): { error: HostCommandError; message: string } {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
  if (error instanceof CommandError) return { error: error.code, message };
  if (error instanceof RevisionConflictError) return { error: 'conflict', message };
  return { error: 'failed', message };
}

/** 命令的返回值变成可以过 IPC 的 JSON（undefined 表示没有返回值） */
function toJson(value: unknown): unknown {
  return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as unknown);
}

export async function handleHostCommand(raw: unknown): Promise<HostCommandResult | null> {
  const parsed = HostCommandRequestSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn('[host-commands] malformed request ignored');
    // 连 requestId 都读不出来的请求没法回复；主进程那边会超时
    const id = typeof raw === 'object' && raw !== null && 'requestId' in raw ? (raw as { requestId: unknown }).requestId : null;
    return typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id) ? { requestId: id, ok: false, error: 'invalid-input', message: 'malformed request' } : null;
  }
  const { requestId, command, input, source } = parsed.data;
  try {
    if (source === 'mac-menu') {
      if (!macMenuState().enabled.some((id) => id === command)) throw new CommandError('disabled', `menu command unavailable: ${command}`);
      if (await dispatch(command, input) === false) return { requestId, ok: false, error: 'failed', message: 'menu action did not complete' };
      return { requestId, ok: true };
    }
    const output = toJson(await dispatch(command, input, { source: 'main' }));
    const result = HostCommandResultSchema.safeParse({ requestId, ok: true, ...(output !== undefined && { output }) });
    return result.success ? result.data : { requestId, ok: false, error: 'invalid-output', message: 'invalid host command output' };
  } catch (error) {
    return { requestId, ok: false, ...errorOf(error) };
  }
}

export function isNativeTextEditing(): boolean {
  if (typeof document === 'undefined') return false;
  const target = document.activeElement;
  return (target instanceof HTMLElement && target.isContentEditable) ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLInputElement && ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(target.type));
}

function macMenuState(): MacMenuState {
  const ui = useUiStore.getState();
  const textEditing = isNativeTextEditing();
  const blocked = onboardingVisible(ui) || tourVisible(ui);
  return {
    textEditing,
    enabled: blocked ? [] : MAC_MENU_COMMANDS.filter((id) => {
      const command = getCommand(id);
      if (!command || !commandEnabled(command)) return false;
      if (textEditing && (id === 'undo' || id === 'redo')) return false;
      if (id === 'saveProject' || id === 'saveProjectAs') {
        const { template, composition } = useProjectStore.getState();
        return !!(template || composition);
      }
      return true;
    }),
  };
}

export function installMacMenuState(): void {
  const send = window.allay.host.setMacMenuState;
  if (!send) return;
  const menuCommand = { titleKey: '', category: 'view', effect: 'read', noShortcut: true, hideInPalette: true } as const;
  for (const command of [
    defineCommand({ ...menuCommand, id: 'mac.openRecent', effect: 'destructive', input: z.uuid(), run: openRecent }),
    defineCommand({ ...menuCommand, id: 'mac.importTemplate', effect: 'destructive', run: async () => (await installViaDialog(i18next.t.bind(i18next), i18next.language)).kind === 'installed' }),
    defineCommand({ ...menuCommand, id: 'mac.theme', input: ThemeSchema, run: (theme) => useUiStore.getState().setTheme(theme) }),
    defineCommand({ ...menuCommand, id: 'mac.language', input: LanguagePrefSchema, run: (language) => useUiStore.getState().update({ language }) }),
    defineCommand({ ...menuCommand, id: 'mac.background', input: z.enum(['checker', 'solid']), run: (background) => useUiStore.getState().setEditor({ background }) }),
  ]) registerCommand(command);

  let last = '';
  const sync = () => {
    const state = macMenuState();
    const signature = JSON.stringify(state);
    if (signature === last) return;
    last = signature;
    void send(state).catch((error: unknown) => console.warn('[mac-menu] state rejected', error));
  };
  useUiStore.subscribe(sync);
  useRegistry.subscribe(sync);
  usePreviewStore.subscribe(sync);
  useProjectStore.subscribe(sync);
  useProjectStore.temporal.subscribe(sync);
  document.addEventListener('focusin', sync);
  document.addEventListener('focusout', () => queueMicrotask(sync));
  sync();
}

let installed = false;

/** 启动时接上（core.tsx） */
export function installHostCommands(): void {
  if (installed) return;
  installed = true;
  window.allay.host.onCommand((request) => {
    void handleHostCommand(request).then((result) => {
      if (result) void window.allay.host.commandResult(result).catch((error: unknown) => console.warn('[host-commands] result rejected', error));
    });
  });
}
