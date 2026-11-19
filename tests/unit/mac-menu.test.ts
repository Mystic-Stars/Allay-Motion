import { describe, expect, it, vi } from 'vitest';
import { macMenuTemplate } from '../../apps/desktop/src/main/mac-menu';
import { handleHostCommand } from '../../apps/desktop/src/renderer/app/mainCommands';
import { registerCommand } from '../../apps/desktop/src/renderer/app/registry';
import { setTitlebarPlatform, titlebarInsets } from '../../apps/desktop/src/renderer/app/titlebarChrome';
import { useUiStore } from '../../apps/desktop/src/renderer/stores/uiStore';
import { defaultUiSettings } from '../../apps/desktop/src/shared/settings';

const recentId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

describe('macOS 原生菜单和顶栏（6.3、6.10）', () => {
  it('跟随系统语言、保留系统角色；引导期间禁用编辑器命令', () => {
    const menu = macMenuTemplate({ appName: 'App', systemLocale: 'zh-Hans', ui: defaultUiSettings(), state: { enabled: [], textEditing: false }, recents: [], fullScreen: true, run: vi.fn() });
    expect(menu.map(({ label }) => label)).toEqual(['App', '文件', '编辑', '视图', '窗口', '帮助']);
    expect(menu[0]?.submenu).toContainEqual({ role: 'quit', label: '退出 App' });
    expect(menu[1]?.submenu).toContainEqual(expect.objectContaining({ label: '打开工程…', enabled: false }));
    expect(menu[2]?.submenu).toContainEqual({ role: 'paste', label: '粘贴' });
    expect(menu[3]?.submenu).toContainEqual({ role: 'togglefullscreen', label: '退出全屏幕' });
    expect(menu[4]?.role).toBe('window');
    expect(menu[5]?.role).toBe('help');
  });

  it('文本撤销交给系统；最近工程只传句柄，应用快捷键留在渲染侧', () => {
    const run = vi.fn();
    const ui = { ...defaultUiSettings(), language: 'en' as const, shortcuts: { openProject: null } };
    const menu = macMenuTemplate({ appName: 'App', systemLocale: 'zh-CN', ui, state: { enabled: ['openProject', 'mac.openRecent'], textEditing: true }, recents: [{ id: recentId, name: 'Project' }], fullScreen: false, run });
    expect(menu[2]?.submenu).toContainEqual({ role: 'undo', label: 'Undo' });
    const file = menu[1]?.submenu as ReturnType<typeof macMenuTemplate>;
    const open = file.find(({ label }) => label === 'Open Project…');
    expect(open).toMatchObject({ enabled: true });
    expect(open?.accelerator).toBeUndefined();
    const [recent] = file.find(({ label }) => label === 'Open Recent')?.submenu as ReturnType<typeof macMenuTemplate>;
    Reflect.apply(recent!.click!, undefined, []);
    expect(run).toHaveBeenCalledWith('mac.openRecent', recentId);
  });

  it('重新运行引导时拒绝已发来的点击，也不把操作失败当成成功', async () => {
    const previous = useUiStore.getState();
    const run = vi.fn(() => false);
    const unregister = registerCommand({ id: 'openProject', titleKey: 'x', effect: 'read', run });
    const request = { requestId: recentId, command: 'openProject', source: 'mac-menu' };
    try {
      useUiStore.setState({ settings: { ...defaultUiSettings(), onboardingCompleted: true, tourCompleted: true }, onboardingOpen: true });
      await expect(handleHostCommand(request)).resolves.toMatchObject({ ok: false, error: 'disabled' });
      expect(run).not.toHaveBeenCalled();
      useUiStore.setState({ onboardingOpen: false });
      await expect(handleHostCommand(request)).resolves.toMatchObject({ ok: false, error: 'failed' });
      expect(run).toHaveBeenCalledOnce();
    } finally {
      unregister();
      useUiStore.setState(previous);
    }
  });

  it('macOS 两个顶栏共用系统边距，Windows 引导保留原边距', () => {
    try {
      setTitlebarPlatform('darwin');
      expect(titlebarInsets(true)).toBe(titlebarInsets());
      expect(titlebarInsets()?.paddingLeft).toContain('env(titlebar-area-x');
      expect(titlebarInsets()?.paddingRight).toContain('env(titlebar-area-width');
    } finally {
      setTitlebarPlatform('win32');
    }
    expect(titlebarInsets(true)).toBeUndefined();
  });
});
