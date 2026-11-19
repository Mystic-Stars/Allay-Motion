// 应用的核心命令表：快捷键（6.7）、命令面板（6.4，Ctrl+K）和顶栏菜单都从注册表读，这张表在启动时注册进去（app/core.tsx）。
// 命令的形状见 app/registry.ts（docs/code-editing-and-mcp-plan.md H2）：带参数的命令声明 input 的 zod schema，
// 执行一律经 dispatch（先校验参数）。
import { randomSeed } from '@allay/ui/editor';
import {
  ArrowUUpLeft,
  ArrowUUpRight,
  CircleHalf,
  Code,
  Command,
  Compass,
  DiceFive,
  Export,
  FilePlus,
  FilmSlate,
  FloppyDisk,
  FloppyDiskBack,
  FolderOpen,
  FrameCorners,
  GearSix,
  MagnifyingGlass,
  MapTrifold,
  MonitorPlay,
  Play,
  Repeat,
  SidebarSimple,
  SkipBack,
  SkipForward,
  Stack,
} from '@phosphor-icons/react';
import i18next from 'i18next';
import { z } from 'zod';
import { CodeStudio } from '../../app/codeWorkspace';
import { defineCommand, SettingsPageIdSchemaSource, trigger, type AnyCommand } from '../../app/registry';
import { redo, undo, useProjectStore } from '../../stores/projectStore';
import { usePreviewStore } from '../../stores/previewStore';
import { useTransportStore } from '../../stores/transportStore';
import { useUiStore } from '../../stores/uiStore';
import { openCodeInspector } from '../live-code/host';
import { newComposition, newProject, openProject, saveProject } from '../project/actions';
import { playbackBounds } from '../transport/usePlaybackClock';

/** Workspace 注册的布局控制（折叠左栏） */
export const layout = { toggleLeft: () => undefined as void };

export function focusTemplateSearch(): void {
  const panel = document.querySelector<HTMLElement>('[data-testid="panel-left"]');
  if (panel && panel.getBoundingClientRect().width < 1) layout.toggleLeft();
  // 搜索框平时收起：切到“模板”页并展开它
  useUiStore.setState({ leftTab: 'templates', searchOpen: true });
  requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById('gallery-search')?.focus()));
}

const ready = () => usePreviewStore.getState().status.kind === 'ready';

export function togglePlay(): void {
  const s = useTransportStore.getState();
  if (!ready()) return;
  const { endTime } = playbackBounds(s.duration, useProjectStore.getState().composition);
  if (!s.playing && s.time >= endTime) s.setTime(0);
  s.setPlaying(!s.playing);
}

export function stepFrames(n: number): void {
  const s = useTransportStore.getState();
  const { composition, output } = useProjectStore.getState();
  const fps = composition?.fps ?? output.fps;
  const { endTime } = playbackBounds(s.duration, composition);
  s.setPlaying(false);
  s.setTime(Math.min(endTime, (Math.round(s.time * fps) + n) / fps));
}

function toEnd(): void {
  const transport = useTransportStore.getState();
  const { composition } = useProjectStore.getState();
  if (composition) transport.setPlaying(false);
  transport.setTime(playbackBounds(transport.duration, composition).endTime);
}

export function rerollSeed(): void {
  const { template } = useProjectStore.getState();
  const def = template?.params.find((p) => p.type === 'seed' && !template.hidden.includes(p.key));
  if (def) useProjectStore.getState().setParams({ [def.key]: randomSeed() }, i18next.language);
}

/** 设置页的 id（注册表里的分类，6.11）；不认识的页在打开时退回第一页 */
const SettingsInput = z.strictObject({ page: z.string().regex(SettingsPageIdSchemaSource) }).optional();

const key = (id: string) => `command.items.${id}`;
const navigationKey = (id: string) => `workspaceNavigation.${id}`;

async function createAnimation(fromTemplate: boolean): Promise<boolean> {
  const created = await newComposition(fromTemplate);
  if (created) useUiStore.setState({ workspaceView: 'preview' });
  return created;
}

/** 核心命令。顺序就是命令面板里的顺序 */
export const CORE_COMMANDS: AnyCommand[] = [
  { id: 'playPause', titleKey: key('playPause'), shortcut: 'Space', category: 'playback', icon: Play, effect: 'read', run: togglePlay, enabled: ready },
  { id: 'toStart', titleKey: key('toStart'), shortcut: 'Home', category: 'playback', icon: SkipBack, effect: 'read', run: () => useTransportStore.getState().setTime(0) },
  { id: 'toEnd', titleKey: key('toEnd'), shortcut: 'End', category: 'playback', icon: SkipForward, effect: 'read', run: toEnd },
  { id: 'loop', titleKey: key('loop'), shortcut: 'L', category: 'playback', icon: Repeat, effect: 'read', run: () => useTransportStore.getState().setLoop(!useTransportStore.getState().loop) },
  {
    id: 'reroll',
    titleKey: key('reroll'),
    shortcut: 'R',
    category: 'edit',
    icon: DiceFive,
    effect: 'write',
    undoLabelKey: key('reroll'),
    run: rerollSeed,
    enabled: () => !!useProjectStore.getState().template?.params.some((p) => p.type === 'seed'),
  },
  { id: 'undo', titleKey: key('undo'), shortcut: 'Ctrl+Z', category: 'edit', icon: ArrowUUpLeft, effect: 'write', run: undo, enabled: () => useProjectStore.temporal.getState().pastStates.length > 0 },
  { id: 'redo', titleKey: key('redo'), shortcut: 'Ctrl+Shift+Z', category: 'edit', icon: ArrowUUpRight, effect: 'write', run: redo, enabled: () => useProjectStore.temporal.getState().futureStates.length > 0 },
  // 新建、打开会替换当前工程（有未保存的改动时先确认），算不可撤销
  {
    id: 'newProject', titleKey: key('newProject'), shortcut: 'Ctrl+N', category: 'file', icon: FilePlus, effect: 'destructive',
    run: async () => {
      const created = await newProject();
      if (created) {
        const transport = useTransportStore.getState();
        transport.setPlaying(false);
        transport.setTime(0);
      }
      return created;
    },
  },
  { id: 'newAnimation', titleKey: navigationKey('newAnimation'), category: 'file', icon: FilmSlate, effect: 'destructive', run: () => createAnimation(false) },
  {
    id: 'newAnimationFromTemplate', titleKey: navigationKey('newAnimationFromTemplate'), category: 'file', icon: FilmSlate, effect: 'destructive',
    enabled: () => !!useProjectStore.getState().template && !useProjectStore.getState().composition,
    run: () => createAnimation(true),
  },
  { id: 'openProject', titleKey: key('openProject'), shortcut: 'Ctrl+O', category: 'file', icon: FolderOpen, effect: 'destructive', run: openProject },
  { id: 'saveProject', titleKey: key('saveProject'), shortcut: 'Ctrl+S', category: 'file', icon: FloppyDisk, effect: 'write', run: () => saveProject() },
  { id: 'saveProjectAs', titleKey: key('saveProjectAs'), shortcut: 'Ctrl+Shift+S', category: 'file', icon: FloppyDiskBack, effect: 'write', run: () => saveProject(true) },
  { id: 'export', titleKey: key('export'), shortcut: 'Ctrl+E', category: 'export', icon: Export, effect: 'read', run: () => useUiStore.getState().openExport(), enabled: ready },
  { id: 'palette', titleKey: key('palette'), shortcut: 'Ctrl+K', category: 'view', icon: Command, effect: 'read', hideInPalette: true, run: () => useUiStore.getState().openDialog('palette') },
  { id: 'searchTemplates', titleKey: key('searchTemplates'), shortcut: 'Ctrl+F', category: 'templates', icon: MagnifyingGlass, effect: 'read', run: focusTemplateSearch },
  { id: 'toggleLeft', titleKey: key('toggleLeft'), shortcut: 'Ctrl+B', category: 'view', icon: SidebarSimple, effect: 'read', run: () => layout.toggleLeft() },
  {
    id: 'showCodeEditor', titleKey: navigationKey('codeEditor'), category: 'view', icon: Code, effect: 'read',
    run: async () => {
      if (window.allay.codeInspector) useUiStore.setState({ workspaceView: 'preview' });
      await openCodeInspector();
    },
  },
  {
    id: 'showAuthoringTools', titleKey: navigationKey('authoring'), category: 'view', icon: Code, effect: 'read',
    enabled: () => CodeStudio !== null && useUiStore.getState().workspaceView !== 'code',
    run: () => useUiStore.setState({ workspaceView: 'code', codeOpened: true }),
  },
  {
    id: 'showPreview', titleKey: navigationKey('backToPreview'), category: 'view', icon: MonitorPlay, effect: 'read',
    enabled: () => useUiStore.getState().workspaceView === 'code',
    run: () => useUiStore.setState({ workspaceView: 'preview' }),
  },
  defineCommand({
    id: 'settings',
    titleKey: key('settings'),
    shortcut: 'Ctrl+,',
    category: 'help',
    icon: GearSix,
    effect: 'read',
    input: SettingsInput,
    run: (input) => useUiStore.getState().openDialog('settings', input?.page ?? 'general'),
  }),
  { id: 'resources', titleKey: key('resources'), category: 'view', icon: Stack, effect: 'read', run: () => useUiStore.getState().setResourcesOpen(true) },
  {
    id: 'toggleTheme',
    titleKey: key('toggleTheme'),
    category: 'view',
    icon: CircleHalf,
    effect: 'write',
    run: () => {
      const ui = useUiStore.getState();
      ui.setTheme(ui.settings.theme === 'dark' ? 'light' : 'dark');
    },
  },
  {
    id: 'guides',
    titleKey: key('guides'),
    category: 'view',
    icon: FrameCorners,
    effect: 'write',
    run: () => {
      const ui = useUiStore.getState();
      ui.setEditor({ guides: !ui.settings.editor.guides });
    },
  },
  // 首次启动引导（6.10）：设置里的“重新运行引导”也是它
  // 一次性的整页流程，不能有快捷键（noShortcut），也就不出现在快捷键设置页
  { id: 'onboarding', titleKey: key('onboarding'), category: 'help', icon: Compass, effect: 'read', noShortcut: true, run: () => useUiStore.getState().openOnboarding() },
  // 新手引导（6.14）：帮助菜单、设置“通用”页、命令面板里都能再看一遍；同样不能有快捷键
  { id: 'tour', titleKey: key('tour'), category: 'help', icon: MapTrifold, effect: 'read', noShortcut: true, run: () => useUiStore.getState().openTour() },
];

/** 快捷键的显示文字（Space → 空格等），定义在 shortcutState.ts */
export { shortcutLabel } from './shortcutState';

/** 按 id 执行（界面上的按钮用；出错只记日志） */
export function runCommand(id: string, input?: unknown): void {
  trigger(id, input);
}
