import { AllayHead } from '@allay/mascot';
import { Button } from '@allay/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuItemIcon,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@allay/ui/components/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@allay/ui/components/tooltip';
import { ICON, ICON_WEIGHT } from '@allay/ui/lib/icons';
import { ArrowUUpLeft, ArrowUUpRight, CaretDown, Export, GearSix } from '@phosphor-icons/react';
import { Fragment } from 'react';
import { useStore } from 'zustand';
import { useTranslation } from 'react-i18next';
import { EXPORT_PRESETS } from '../../shared/export';
import { ExportFormatItems } from '../features/export/ExportFormatMenu';
import { shortcutLabel, useShortcutFor } from '../features/commands/shortcutState';
import { ResourceButton } from '../features/resources/ResourceButton';
import { usePreviewStore } from '../stores/previewStore';
import { isDirty, redo, undo, useProjectStore } from '../stores/projectStore';
import { useUiStore } from '../stores/uiStore';
import { commandEnabled, trigger, useMenuGroups, useRegistry, type MenuId, type MenuItemDef } from './registry';
import { hasNativeMacChrome, titlebarInsets } from './titlebarChrome';

// 顶栏（6.4）：一条 44 px，直接坐在底色上（不是面板）。
// 左：悦灵头像和字标；菜单“文件 / 编辑 / 视图 / 帮助”（条目来自界面注册表，见 registry.ts、core.tsx）。
// 正中：工程名和“已修改”。右：素材状态（点开是资源栈弹层）、撤销、重做、设置、“导出”分体按钮
// （主体打开导出对话框，右侧小段列出导出格式，选中后带着这个格式打开对话框）。
// 空白处是窗口拖动区；所有可交互元素标 no-drag。最右留出系统窗口按钮的位置。

const MENUS: { id: MenuId; titleKey: string; testId?: string }[] = [
  { id: 'file', titleKey: 'menu.file', testId: 'project-menu' },
  { id: 'edit', titleKey: 'menu.edit' },
  { id: 'view', titleKey: 'menu.view' },
  { id: 'help', titleKey: 'menu.help' },
];

/** 一个菜单项：指向命令的（标题、快捷键、可用条件取自命令，执行经 dispatch），或者自带组件的 */
function RegistryMenuItem({ item }: { item: MenuItemDef }) {
  const { t } = useTranslation();
  const command = useRegistry((s) => (item.command ? s.commands[item.command] : undefined));
  // 可用条件依赖撤销历史等状态：订阅一下，让菜单打开时是最新的
  useStore(useProjectStore.temporal, (s) => s.pastStates.length + s.futureStates.length);
  useProjectStore((s) => !!s.template && !s.composition);
  useUiStore((s) => s.workspaceView);
  const shortcut = useShortcutFor(item.command ?? '');
  if (item.component) return <item.component icon={item.icon} />;
  if (!command) return null;
  return (
    <DropdownMenuItem onClick={() => trigger(command.id, item.input)} data-testid={item.testId} disabled={!commandEnabled(command)}>
      <DropdownMenuItemIcon icon={item.icon ?? command.icon} />
      <span className="min-w-0 flex-1 truncate">{t(item.titleKey ?? command.titleKey)}</span>
      {shortcut && item.input === undefined && <DropdownMenuShortcut>{shortcutLabel(shortcut)}</DropdownMenuShortcut>}
    </DropdownMenuItem>
  );
}

/** 顶栏的一个菜单：条目全部来自注册表（核心功能和可选模块一样经 registerMenuItem 挂上来） */
function RegistryMenu({ id, titleKey, testId }: { id: MenuId; titleKey: string; testId?: string }) {
  const { t } = useTranslation();
  const groups = useMenuGroups(id);
  if (groups.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" className="app-no-drag h-7 px-2.5" data-testid={testId} />}>{t(titleKey)}</DropdownMenuTrigger>
      <DropdownMenuContent className={id === 'file' ? 'w-72' : 'w-60'}>
        {groups.map((group, i) => (
          <Fragment key={group[0]!.id}>
            {i > 0 && <DropdownMenuSeparator />}
            {group.map((item) => (
              <RegistryMenuItem key={item.id} item={item} />
            ))}
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 带工具提示的图标按钮；提示里的快捷键取自命令生效的快捷键（6.11） */
function IconButton({ label, command, ...props }: { label: string; command: string } & Parameters<typeof Button>[0]) {
  const shortcut = useShortcutFor(command);
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon" className="app-no-drag" aria-label={label} {...props} />} />
      <TooltipContent side="bottom">
        {label} {shortcut && <span className="num text-fg-subtle">{shortcutLabel(shortcut)}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

/** “导出”分体按钮：全窗口唯一的实心强调色按钮 */
function ExportButton() {
  const { t } = useTranslation();
  const ready = usePreviewStore((s) => s.status.kind === 'ready');
  const open = useUiStore.getState().openExport;
  return (
    <div className="app-no-drag ml-2 flex h-[30px] overflow-hidden rounded-lg">
      <Button className="h-full gap-[7px] rounded-none pr-3.5 pl-3" data-testid="topbar-export" disabled={!ready} onClick={() => open()}>
        <Export size={ICON.sm} weight="bold" />
        {t('topbar.export')}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button className="h-full w-7 rounded-none bg-primary-press px-0 hover:bg-primary-hover" aria-label={t('topbar.exportFormat')} disabled={!ready} data-testid="topbar-export-format" />}
        >
          <CaretDown size={ICON.xs - 1} weight="bold" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          {/* GroupLabel 必须在 Group 里（Base UI 错误 #31） */}
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t('topbar.exportAs')}</DropdownMenuLabel>
            <ExportFormatItems presets={EXPORT_PRESETS} onPick={(p) => open(p)} />
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function TopBar() {
  const { t } = useTranslation();
  const name = useProjectStore((s) => s.name);
  const dirty = useProjectStore(isDirty);
  const canUndo = useStore(useProjectStore.temporal, (s) => s.pastStates.length > 0);
  const canRedo = useStore(useProjectStore.temporal, (s) => s.futureStates.length > 0);
  return (
    <header
      data-testid="topbar"
      className="app-drag relative flex h-topbar shrink-0 items-center gap-1 bg-background"
      style={titlebarInsets()}
    >
      {/* 正中：工程名与“已修改”（不接收指针，不挡拖动区） */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex h-topbar items-center justify-center gap-2">
        <span className="max-w-[30vw] truncate font-medium" data-testid="project-name">
          {name ?? t('project.untitled')}
        </span>
        {dirty && (
          <span className="text-fg-subtle" data-testid="project-dirty" title={t('project.unsavedMark')}>
            {t('project.modified')}
          </span>
        )}
      </div>

      <div className="relative flex items-center gap-2 pr-3">
        <AllayHead size={22} className="app-no-drag" onClick={() => undefined} label={t('brand.name')} />
        <span className="text-[13px] font-semibold whitespace-nowrap">{t('brand.wordmark')}</span>
      </div>
      {!hasNativeMacChrome() && (
        <nav className="relative flex items-center" aria-label={t('menu.file')}>
          {MENUS.map((menu) => (
            <RegistryMenu key={menu.id} id={menu.id} titleKey={menu.titleKey} testId={menu.testId} />
          ))}
        </nav>
      )}

      <div data-testid="drag-region" className="h-full min-w-4 flex-1" />

      <ResourceButton />
      <IconButton label={t('topbar.undo')} command="undo" disabled={!canUndo} onClick={undo} data-testid="topbar-undo">
        <ArrowUUpLeft size={ICON.md} />
      </IconButton>
      <IconButton label={t('topbar.redo')} command="redo" disabled={!canRedo} onClick={redo} data-testid="topbar-redo">
        <ArrowUUpRight size={ICON.md} />
      </IconButton>
      <IconButton label={t('topbar.settings')} command="settings" onClick={() => useUiStore.getState().openDialog('settings', 'general')} data-testid="topbar-settings">
        <GearSix size={ICON.md} weight={ICON_WEIGHT.normal} />
      </IconButton>
      <ExportButton />
    </header>
  );
}
