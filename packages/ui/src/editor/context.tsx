import { createContext, useContext, type ReactNode } from 'react';

// 编辑器控件需要应用提供的东西：翻译、方块与物品目录、缩略图、图片选择、最近使用、连续操作的起止（撤销合并）。
// ui 包不依赖引擎和 Electron（1.4），这些都由渲染进程经这个 context 交进来。

export interface CatalogEntry {
  id: string;
  /** 两种语言的显示名（搜索时都参与匹配） */
  names: { 'zh-CN': string; en: string };
  group: string;
}

export interface CatalogGroup {
  key: string;
  label: string;
}

/** 音效库里的一个事件：local 能直接放；remote 在下载缓存里还没取回（试听、选中时按需取）；missing 放不出来 */
export interface SoundLibraryItem {
  id: string;
  state: 'local' | 'remote' | 'missing';
  kind: 'effect' | 'music';
  names: { 'zh-CN'?: string; en?: string; chinese: 'subtitle' | 'terminology' | 'missing' | 'custom' };
  source: 'vanilla' | 'pack-new' | 'definition-override' | 'file-override' | 'builtin' | 'imported';
  fileOverride?: boolean;
  variantCount: number;
}

export type RecentKind = 'color' | 'block' | 'item' | 'texture';

export interface EditorServices {
  /** 翻译：键是相对 editor. 的路径 */
  t(key: string, vars?: Record<string, string | number>): string;
  locale: string;
  /** 当前工程的帧率（DurationField 吸附到 1 / fps） */
  fps: number;
  blocks: readonly CatalogEntry[];
  items: readonly CatalogEntry[];
  blockGroups: readonly CatalogGroup[];
  itemGroups: readonly CatalogGroup[];
  /** 资源栈里有没有素材层；没有时缩略图显示占位和引导 */
  hasAssets: boolean;
  /** 资源栈的版本：变了以后缩略图重新取 */
  resourceStamp: string;
  /** 方块或物品的缩略图（blob: URL）；没有素材或失败时为 null */
  thumbnail(kind: 'block' | 'item', id: string): Promise<string | null>;
  /** 贴图的预览（资源 ID、asset:、file:）；拿不到时为 null */
  texturePreview(value: string): Promise<string | null>;
  /** 主进程的图片对话框；返回 file: 引用 */
  pickImage(): Promise<{ value: string; name: string } | null>;
  /** 资源栈里可选的贴图 ID（目录里方块和物品用到的贴图） */
  textureIds: readonly string[];
  /** 字体来源由宿主提供，动画字体不会用于编辑器自身。 */
  renderFont?(props: { value: string; onChange(value: string): void; label: string; testId: string }): ReactNode;
  /**
   * 音效选择器的库（M6b）：library 是资源栈合并后的 sounds.json 里的全部事件（按 ID 排序）；
   * common 是规格 3.8 的常用事件（置顶，只显示库里有的）。没有素材层时 library 为空
   */
  sounds: { library: readonly SoundLibraryItem[]; common: readonly string[]; loading: boolean };
  /** 试听；未提供时试听按钮禁用 */
  previewSound?(id: string): void;
  /** 用户在选择器里选中了一个音效（宿主按需取回还没下载的文件） */
  prepareSound?(id: string): void;
  importSound?(kind: SoundLibraryItem['kind']): Promise<string | null>;
  fetchSoundNames?(): Promise<void>;
  recent(kind: RecentKind): readonly string[];
  addRecent(kind: RecentKind, value: string): void;
  /** 一次连续操作（拖滑块、拖数字）开始和结束：之间的改动只算一条撤销记录（1.7） */
  gesture(phase: 'start' | 'end'): void;
  /** 引导用户添加素材（缩略图占位旁的按钮） */
  openResources?(): void;
  /** 选择器网格的缩略图还没好时，盖在网格上的加载编排（docs/07-allay-mascot.md 7.5 第 4 项）；不提供时只有每格的骨架 */
  pickerLoader?(loading: boolean): ReactNode;
}

const EditorContext = createContext<EditorServices | null>(null);

export const EditorProvider = EditorContext.Provider;

export function useEditor(): EditorServices {
  const ctx = useContext(EditorContext);
  if (!ctx) throw new Error('EditorProvider is missing');
  return ctx;
}

/** 连续操作的起止：按下时开始，在 window 上等松开（拖出控件外松开也算） */
export function beginGesture(services: EditorServices): void {
  services.gesture('start');
  const end = () => {
    window.removeEventListener('pointerup', end, true);
    window.removeEventListener('pointercancel', end, true);
    // 控件自己可能在松开时再提交一次最终值（滑块的 pointerup 在 window 的捕获阶段之后才处理）：等这一轮事件处理完再结束
    setTimeout(() => services.gesture('end'), 0);
  };
  window.addEventListener('pointerup', end, true);
  window.addEventListener('pointercancel', end, true);
}
