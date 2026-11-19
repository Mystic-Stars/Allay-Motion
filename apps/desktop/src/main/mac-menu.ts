import type { MenuItemConstructorOptions } from 'electron';
import type { MacMenuCommand, MacMenuState } from '../shared/mac-menu';
import type { RecentProject } from '../shared/project';
import type { UiSettings } from '../shared/settings';
import { macMenuMessages } from './mac-menu-messages';

type MenuItem = MenuItemConstructorOptions;
type MenuInput = string | { page: 'about' | 'shortcuts' };

export function macMenuTemplate(opts: {
  appName: string;
  systemLocale: string;
  ui: Pick<UiSettings, 'language' | 'theme' | 'editor'>;
  state: MacMenuState | null;
  recents: readonly Pick<RecentProject, 'id' | 'name'>[];
  fullScreen: boolean;
  run(command: MacMenuCommand, input?: MenuInput): void;
}): MenuItem[] {
  const { appName, ui, state, recents } = opts;
  const lang = ui.language === 'system' ? (opts.systemLocale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en') : ui.language;
  const t = macMenuMessages[lang];
  const separator: MenuItem = { type: 'separator' };
  const command = (label: string, id: MacMenuCommand, input?: MenuInput, checked?: boolean): MenuItem => ({
    label,
    enabled: state?.enabled.includes(id) ?? false,
    ...(checked === undefined ? {} : { type: id === 'guides' ? 'checkbox' : 'radio', checked }),
    click: () => opts.run(id, input),
  });
  return [
    { label: appName, submenu: [
      command(`${t.about} ${appName}`, 'settings', { page: 'about' }), command(t.settings, 'settings'), separator,
      { role: 'services', label: t.services, submenu: [] }, separator,
      { role: 'hide', label: `${t.hide} ${appName}` }, { role: 'hideOthers', label: t.hideOthers }, { role: 'unhide', label: t.showAll }, separator,
      { role: 'quit', label: `${t.quit} ${appName}` },
    ] },
    { label: t.file, submenu: [
      command(t.newProject, 'newProject'), command(t.newAnimation, 'newAnimation'), command(t.newAnimationFromTemplate, 'newAnimationFromTemplate'),
      command(t.open, 'openProject'),
      { label: t.recent, enabled: state?.enabled.includes('mac.openRecent') ?? false, submenu: recents.length
        ? recents.map(({ id, name }) => command(name, 'mac.openRecent', id))
        : [{ label: t.noRecent, enabled: false }] }, separator,
      command(t.save, 'saveProject'), command(t.saveAs, 'saveProjectAs'), separator,
      command(t.importTemplate, 'mac.importTemplate'), command(t.copyTemplate, 'copyBuiltinTemplate'), command(t.templateFolder, 'openTemplateFolder'), separator,
      command(t.export, 'export'), { role: 'close', label: t.close },
    ] },
    { label: t.edit, submenu: [
      state?.textEditing ? { role: 'undo', label: t.undo } : command(t.undo, 'undo'),
      state?.textEditing ? { role: 'redo', label: t.redo } : command(t.redo, 'redo'), separator,
      { role: 'cut', label: t.cut }, { role: 'copy', label: t.copy }, { role: 'paste', label: t.paste },
      { role: 'pasteAndMatchStyle', label: t.pasteStyle }, { role: 'selectAll', label: t.selectAll }, separator,
      command(t.reroll, 'reroll'),
    ] },
    { label: t.view, submenu: [
      { label: t.theme, submenu: [command(t.dark, 'mac.theme', 'dark', ui.theme === 'dark'), command(t.light, 'mac.theme', 'light', ui.theme === 'light')] },
      { label: t.language, submenu: [
        command(t.system, 'mac.language', 'system', ui.language === 'system'),
        command('简体中文', 'mac.language', 'zh-CN', ui.language === 'zh-CN'), command('English', 'mac.language', 'en', ui.language === 'en'),
      ] },
      { label: t.background, submenu: [
        command(t.checker, 'mac.background', 'checker', ui.editor.background !== 'solid'),
        command(t.solid, 'mac.background', 'solid', ui.editor.background === 'solid'),
      ] },
      command(t.guides, 'guides', undefined, ui.editor.guides), command(t.sidebar, 'toggleLeft'), separator,
      command(t.codeEditor, 'showCodeEditor'), command(t.backToPreview, 'showPreview'), command(t.palette, 'palette'), separator,
      { role: 'togglefullscreen', label: opts.fullScreen ? t.exitFullScreen : t.enterFullScreen },
    ] },
    { role: 'window', label: t.window, submenu: [
      { role: 'minimize', label: t.minimize }, { role: 'zoom', label: t.zoom }, separator, { role: 'front', label: t.front },
    ] },
    { role: 'help', label: t.help, submenu: [
      command(t.shortcuts, 'settings', { page: 'shortcuts' }), separator, command(t.onboarding, 'onboarding'), command(t.tour, 'tour'),
    ] },
  ];
}
