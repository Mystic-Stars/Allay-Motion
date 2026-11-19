import { create } from 'zustand';
import {
  defaultEditorPrefs,
  defaultUiSettings,
  MAX_GROUP_TEMPLATES,
  RECENT_MAX,
  type EditorPrefs,
  type PanelState,
  type RecentKind,
  type Theme,
  type UiSettings,
  type UiSettingsPatch,
} from '../../shared/settings';
import type { ExportPreset } from '../../shared/export';

// uiStore（1.7）：面板宽度、折叠状态、主题、语言，以及编辑器偏好（预览背景、参考线、分组折叠、最近使用）。
// 真正的持久化在主进程的 settings.json（1.6 第 10 条：不用 localStorage）。
// 另外放几个不持久化的界面状态：哪个对话框开着。

export type Side = 'left' | 'right';
export type DialogName = 'export' | 'settings' | 'palette' | 'saveTemplate' | 'savePreset' | null;

interface UiState {
  settings: UiSettings;
  dialog: DialogName;
  resourcesOpen: boolean;
  /** 设置对话框打开时的页（注册表里设置页的 id，6.11） */
  settingsPage: string;
  /** 首次启动引导开着（第一次启动，或设置里点了“重新运行引导”，6.10） */
  onboardingOpen: boolean;
  /** 新手引导开着（帮助菜单、设置里点了“新手引导”；首次启动引导之后自动出现的那次见 tourVisible，6.14） */
  tourOpen: boolean;
  /** 左右面板当前的标签页（注册表里面板的 id） */
  leftTab: string;
  rightTab: string;
  workspaceView: 'preview' | 'code';
  codeOpened: boolean;
  /** 模板库的搜索词 */
  galleryQuery: string;
  /** 预设保存、导入后加一，让各处的预设列表重新取 */
  presetsVersion: number;
  /** 模板库的搜索框是否展开（Ctrl+F 或搜索图标） */
  searchOpen: boolean;
  /** 从“导出”分体按钮的下拉里选的格式：打开导出对话框时预先选中 */
  exportPreset: ExportPreset | null;
  /** 导出正在进行（状态栏显示“导出中”） */
  exporting: boolean;
  /** 主进程推来的完整设置（启动、或其他地方改了设置） */
  replace(settings: UiSettings): void;
  setTheme(theme: Theme): void;
  update(patch: Omit<UiSettingsPatch, 'layout' | 'editor'>): void;
  setPanel(side: Side, state: PanelState): void;
  setEditor(patch: Partial<Omit<EditorPrefs, 'groups' | 'recent'>>): void;
  setGroupCollapsed(templateId: string, group: string, collapsed: boolean): void;
  addRecent(kind: RecentKind, value: string): void;
  openDialog(dialog: DialogName, page?: string): void;
  /** 打开引导（关掉别的对话框） */
  openOnboarding(): void;
  /** 引导走完或跳过：记进设置，之后不再自动出现 */
  finishOnboarding(): void;
  /** 打开新手引导（关掉别的对话框、弹层） */
  openTour(): void;
  /** 新手引导看完或跳过：记进设置，之后不再自动出现 */
  finishTour(): void;
  setResourcesOpen(open: boolean): void;
  bumpPresets(): void;
  setSearchOpen(open: boolean): void;
  openExport(preset?: ExportPreset): void;
  setExporting(exporting: boolean): void;
}

const SAVE_DELAY = 150;
let layoutTimer: ReturnType<typeof setTimeout> | undefined;
let pendingLayout: NonNullable<UiSettingsPatch['layout']> = {};
let editorTimer: ReturnType<typeof setTimeout> | undefined;
let pendingEditor: NonNullable<UiSettingsPatch['editor']> = {};

function persist(patch: UiSettingsPatch): void {
  window.allay.settings.set(patch).catch((error: unknown) => {
    console.error('failed to save settings', error);
  });
}

/** 编辑器偏好会连续变（最近使用、折叠），合并后再写 */
function persistEditor(patch: NonNullable<UiSettingsPatch['editor']>): void {
  pendingEditor = { ...pendingEditor, ...patch };
  clearTimeout(editorTimer);
  editorTimer = setTimeout(() => {
    const editor = pendingEditor;
    pendingEditor = {};
    persist({ editor });
  }, SAVE_DELAY);
}

export const useUiStore = create<UiState>((set, get) => ({
  settings: defaultUiSettings(),
  dialog: null,
  onboardingOpen: false,
  tourOpen: false,
  resourcesOpen: false,
  settingsPage: 'general',
  leftTab: 'templates',
  rightTab: 'props',
  workspaceView: 'preview',
  codeOpened: false,
  galleryQuery: '',
  presetsVersion: 0,
  searchOpen: false,
  exportPreset: null,
  exporting: false,
  replace: (settings) => set({ settings: { ...settings, editor: settings.editor ?? defaultEditorPrefs() } }),
  setTheme: (theme) => {
    set({ settings: { ...get().settings, theme } });
    persist({ theme });
  },
  update: (patch) => {
    set({ settings: { ...get().settings, ...patch } });
    persist(patch);
  },
  setPanel: (side, state) => {
    const current = get().settings;
    const prev = current.layout[side];
    if (prev.size === state.size && prev.collapsed === state.collapsed) return;
    set({ settings: { ...current, layout: { ...current.layout, [side]: state } } });
    // 拖动分栏时会连续触发，合并后再写
    pendingLayout = { ...pendingLayout, [side]: state };
    clearTimeout(layoutTimer);
    layoutTimer = setTimeout(() => {
      const layout = pendingLayout;
      pendingLayout = {};
      persist({ layout });
    }, SAVE_DELAY);
  },
  setEditor: (patch) => {
    const current = get().settings;
    set({ settings: { ...current, editor: { ...current.editor, ...patch } } });
    persistEditor(patch);
  },
  setGroupCollapsed: (templateId, group, collapsed) => {
    const current = get().settings;
    const groups = { ...current.editor.groups, [templateId]: { ...current.editor.groups[templateId], [group]: collapsed } };
    // 记录的模板太多时丢掉最早的
    const ids = Object.keys(groups);
    if (ids.length > MAX_GROUP_TEMPLATES) for (const id of ids.slice(0, ids.length - MAX_GROUP_TEMPLATES)) delete groups[id];
    set({ settings: { ...current, editor: { ...current.editor, groups } } });
    persistEditor({ groups });
  },
  addRecent: (kind, value) => {
    const current = get().settings;
    const list = [value, ...current.editor.recent[kind].filter((v) => v !== value)].slice(0, RECENT_MAX);
    if (list.join('\n') === current.editor.recent[kind].join('\n')) return;
    const recent = { ...current.editor.recent, [kind]: list };
    set({ settings: { ...current, editor: { ...current.editor, recent } } });
    persistEditor({ recent });
  },
  openDialog: (dialog, page) => set((s) => ({ dialog, settingsPage: page ?? s.settingsPage })),
  openOnboarding: () => set({ onboardingOpen: true, dialog: null, resourcesOpen: false }),
  finishOnboarding: () => {
    set({ onboardingOpen: false });
    if (!get().settings.onboardingCompleted) get().update({ onboardingCompleted: true });
  },
  openTour: () => set({ tourOpen: true, dialog: null, resourcesOpen: false }),
  finishTour: () => {
    set({ tourOpen: false });
    if (!get().settings.tourCompleted) get().update({ tourCompleted: true });
  },
  setResourcesOpen: (resourcesOpen) => set({ resourcesOpen }),
  bumpPresets: () => set((s) => ({ presetsVersion: s.presetsVersion + 1 })),
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  openExport: (preset) => set({ dialog: 'export', exportPreset: preset ?? null }),
  setExporting: (exporting) => set({ exporting }),
}));

type OverlayState = Pick<UiState, 'onboardingOpen' | 'tourOpen'> & { settings: Pick<UiSettings, 'onboardingCompleted' | 'tourCompleted'> };

/** 首次启动引导显示着（新装时自动出现，或重新运行，6.10） */
export function onboardingVisible(s: OverlayState): boolean {
  return s.onboardingOpen || !s.settings.onboardingCompleted;
}

/** 新手引导显示着：首次启动引导之后、还没看过时自动出现，或者从帮助菜单打开（6.14）。和首次启动引导不同时出现 */
export function tourVisible(s: OverlayState): boolean {
  return !onboardingVisible(s) && (s.tourOpen || !s.settings.tourCompleted);
}
