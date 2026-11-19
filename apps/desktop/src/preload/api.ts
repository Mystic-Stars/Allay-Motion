import type { FontCatalog } from '../shared/fonts';
import type { CodeInspectorParentApi } from '../shared/code-inspector';
import type {
  ChooseFolderResult,
  ExportFinishResult,
  ExportStartRequest,
  ExportStartResult,
  ExportStepResult,
  FfmpegInfo,
  H264Probe,
} from '../shared/export';
import type { AppInfo, PickedFile, TitleBarColors } from '../shared/ipc-contract';
import type { HostCommandRequest, HostCommandResult } from '../shared/host-commands';
import type { MacMenuState } from '../shared/mac-menu';
import type { AddPackResult, CacheUsage, ChooseGameDirResult, DownloadResult, FontProvidersResult, InstancePackInfo, OfficialVersion, ResourceLocation, ResourceState, SoundFilesResult, SoundLibrary, SoundVariantInfo } from '../shared/resources';
import type { ProjectData, ProjectOpenResult, ProjectSaveResult, RecentProject } from '../shared/project';
import type { UiSettings, UiSettingsPatch } from '../shared/settings';
import type { FolderChooseResult, FolderInfo, FolderKind, FoldersInfo } from '../shared/folders';
import type { UpdateState } from '../shared/updates';
import type { SourceReadResult, TemplateId, WriteResult } from '@allay/host-api';
import type { CompositionPackageEntry, CompositionPackageResult, FreezeCompositionRequest, ReadCompositionPackageResult, WriteSourceRequest } from '../shared/template-authoring';
import type { SkinsApi } from '../shared/skins';
import type { ImportedSound } from '../shared/sound';
import type {
  CommitResult,
  CopyBuiltinRequest,
  ExportFileResult,
  InstallReport,
  PresetEntry,
  PresetImportResult,
  SaveDerivedRequest,
  SavePresetRequest,
  StageResult,
  TemplateBundle,
  TemplateDevChange,
  TemplateDevResult,
  TemplateEntry,
} from '../shared/templates';

/** 主窗口渲染进程能看到的唯一接口：window.allay（docs/01-product-architecture.md 1.8） */
export interface AllayApi {
  codeInspector?: CodeInspectorParentApi;
  skins?: SkinsApi;
  sound: {
    pick(kind: ImportedSound['kind']): Promise<ImportedSound | null>;
    list(): Promise<ImportedSound[]>;
    read(file: string, profileId?: string): Promise<Uint8Array | null>;
    fetchNames(): Promise<void>;
  };
  app: {
    info(): Promise<AppInfo>;
  };
  settings: {
    get(): Promise<UiSettings>;
    set(patch: UiSettingsPatch): Promise<UiSettings>;
    /** 返回取消订阅的函数 */
    onChanged(callback: (settings: UiSettings) => void): () => void;
  };
  window: {
    setTitleBarColors(colors: TitleBarColors): Promise<void>;
    /** 重新载入界面（错误页用；未保存的改动会丢） */
    reload(): Promise<void>;
  };
  fonts: {
    list(profileId?: string): Promise<FontCatalog>;
  };
  files: {
    /** 弹出主进程的文件对话框；取消时为 null */
    pickImage(): Promise<PickedFile | null>;
    /** 只能读 pickImage 授权过的引用 */
    read(ref: string): Promise<Uint8Array>;
  };
  export: {
    /** 启动 FFmpeg；还没选过输出文件夹时先弹主进程的文件夹对话框，用户取消时 canceled 为真 */
    start(req: ExportStartRequest): Promise<ExportStartResult>;
    /** 写一帧直通 alpha 的 RGBA8；数据进了 FFmpeg（必要时等到 drain）才返回 */
    writeFrame(jobId: string, pixels: Uint8Array): Promise<ExportStepResult>;
    /** 有音轨的任务（start 时 audio 为真）：交来混好的 48 kHz 立体声 16 位 WAV，主进程随后启动 FFmpeg。在第一帧之前调用 */
    writeAudio(jobId: string, wav: Uint8Array): Promise<ExportStepResult>;
    finish(jobId: string): Promise<ExportFinishResult>;
    cancel(jobId: string): Promise<void>;
    ffmpegInfo(): Promise<FfmpegInfo>;
    /** H.264 编码器探测（5.3）；force 为真时忽略缓存重新试编码。FFmpeg 不能用时为 null */
    probeEncoders(force: boolean): Promise<H264Probe | null>;
    /** 当前的输出文件夹（显示用）；还没选过时为 null */
    outputFolder(): Promise<string | null>;
    /** 弹出主进程的文件夹对话框，选中的记进设置 */
    chooseFolder(): Promise<ChooseFolderResult>;
    /** 在文件夹中显示这个任务的输出（只认导出完成的任务） */
    reveal(jobId: string): Promise<void>;
    /** 把诊断信息写进系统剪贴板 */
    copyDiagnostics(text: string): Promise<void>;
  };
  resources: {
    /** 资源栈的完整状态（各层、原版层来源、下载进度、resourceStamp） */
    layers(): Promise<ResourceState>;
    stamp(): Promise<string>;
    /** 资源栈里的一个文件（例如 assets/minecraft/textures/block/stone.png）；没有时为 null */
    read(path: string, profileId?: string): Promise<Uint8Array | null>;
    /** 贴图 PNG 和同一层的 .mcmeta */
    readTexture(id: string, profileId?: string): Promise<{ png: Uint8Array; mcmeta: string | null } | null>;
    /** 音效事件的全部变体（资源栈里合并后的 sounds.json）；没有这个事件时为 null */
    soundVariants(eventId: string, profileId?: string): Promise<SoundVariantInfo[] | null>;
    /** 音效选择器的库：资源栈合并后的 sounds.json 里的全部事件和可用状态 */
    soundLibrary(profileId?: string): Promise<SoundLibrary>;
    /**
     * 音效文件（音效名）的状态；fetch 为真时联网取回下载缓存的原版层里还没取的对象。
     * 只在用户试听、选中音效，或导出前确认取回时调用
     */
    soundFiles(files: string[], fetch: boolean, profileId?: string): Promise<SoundFilesResult>;
    list(prefix: string, profileId?: string): Promise<string[]>;
    fontProviders(fontId: string, profileId?: string): Promise<FontProvidersResult | null>;
    /** 重新离线探测本机游戏和下载缓存 */
    detectMinecraft(): Promise<ResourceState>;
    setVanilla(patch: { consent?: boolean; enabled?: boolean }): Promise<ResourceState>;
    /** 弹出主进程的目录对话框选游戏目录 */
    chooseGameDir(reconnectId?: string): Promise<ChooseGameDirResult>;
    selectProfile(profileId: string | null): Promise<ResourceState>;
    officialVersions(): Promise<OfficialVersion[]>;
    locateProfile(profileId: string, target: ResourceLocation): Promise<boolean>;
    instancePacks(profileId: string): Promise<InstancePackInfo[]>;
    setInstancePack(profileId: string, packId: string, enabled: boolean): Promise<ResourceState>;
    /** 联网：从 Mojang 官方服务器下载最新正式版客户端 jar。只在用户点了按钮后调用 */
    downloadVanilla(versionId?: string): Promise<DownloadResult>;
    cancelDownload(): Promise<void>;
    /** 弹出主进程的对话框添加资源包 */
    addPack(kind: 'zip' | 'folder', reconnectId?: string): Promise<AddPackResult>;
    /** 拖进窗口的资源包：只接收 File 对象，路径由 preload 取 */
    addDroppedPack(file: File): Promise<AddPackResult>;
    removeLayer(id: string): Promise<ResourceState>;
    /** 资源包从下往上的新顺序 */
    reorder(ids: string[]): Promise<ResourceState>;
    setEnabled(id: string, enabled: boolean): Promise<ResourceState>;
    onChanged(callback: (state: ResourceState) => void): () => void;
  };
  templates: {
    /** 内置和已安装的全部模板 */
    list(): Promise<TemplateEntry[]>;
    /** 装载需要的 manifest（派生模板已套上 overrides）和代码；不存在或基模板缺失时为 null */
    read(id: string, version: string): Promise<TemplateBundle | null>;
    /** 模板包 assets/ 里的文件（asset: 引用） */
    readAsset(source: { id: string; version: string } | { stagingId: string }, path: string): Promise<Uint8Array | null>;
    /** 弹出主进程的对话框选 .allaytpl，做 4.8 的第 1–3 步并解压到暂存区 */
    install(): Promise<StageResult>;
    /** 拖进窗口的模板包：只接收 File 对象，路径由 preload 取 */
    installDropped(file: File): Promise<StageResult>;
    /** 文件关联（M8）：主进程经命令通道发来的令牌换成暂存的模板包；令牌不认识或用过了时 rejected */
    installRequested(token: string): Promise<StageResult>;
    /** 试运行之后：把暂存的包装上，记下试运行的警告 */
    commitInstall(stagingId: string, report: InstallReport): Promise<CommitResult>;
    cancelInstall(stagingId: string): Promise<void>;
    /** 只能删用户模板 */
    remove(id: string, version: string): Promise<boolean>;
    /** 弹出主进程的保存对话框，导出成 .allaytpl */
    exportPackage(id: string, version: string): Promise<ExportFileResult>;
    /** 另存为派生模板（4.7） */
    saveDerived(req: SaveDerivedRequest): Promise<{ ok: true; entry: TemplateEntry } | { ok: false; error: string }>;
    // ---- 模板开发模式（MD）：界面接线在 MD-b ----
    /** 把内置模板复制成可编辑的用户模板（新 id，版本 1.0.0），并写好 template-api.d.ts 和 jsconfig.json */
    copyBuiltin(req: CopyBuiltinRequest): Promise<TemplateDevResult<{ entry: TemplateEntry }>>;
    /** 往用户模板的文件夹写 template-api.d.ts 和 jsconfig.json */
    writeDevFiles(id: string, version: string): Promise<TemplateDevResult>;
    /** 在系统文件管理器里打开用户模板的文件夹 */
    openFolder(id: string, version: string): Promise<TemplateDevResult>;
    readSource(ref: TemplateId): Promise<SourceReadResult>;
    writeSource(ref: TemplateId, request: WriteSourceRequest): Promise<WriteResult>;
    createBlank(name: string): Promise<TemplateEntry | null>;
    freezeComposition(request: FreezeCompositionRequest): Promise<CompositionPackageResult>;
    importComposition(): Promise<CompositionPackageResult>;
    listCompositions(): Promise<CompositionPackageEntry[]>;
    openComposition(id: string): Promise<ReadCompositionPackageResult>;
    /** 用户模板文件夹在应用之外被改动（应用自己的写入不触发）；返回取消订阅的函数 */
    onChanged(callback: (change: TemplateDevChange) => void): () => void;
  };
  presets: {
    list(): Promise<PresetEntry[]>;
    save(req: SavePresetRequest): Promise<PresetEntry>;
    remove(id: string): Promise<boolean>;
    /** 弹出主进程的对话框导入 .allaypreset */
    importFile(): Promise<PresetImportResult>;
    /** 弹出主进程的保存对话框导出 */
    exportFile(id: string): Promise<ExportFileResult>;
  };
  project: {
    /** 弹出主进程的打开对话框 */
    open(): Promise<ProjectOpenResult>;
    /** 文件关联（M8）：主进程经命令通道发来的令牌换成打开的工程；令牌不认识或用过了时 missing */
    openRequested(token: string): Promise<ProjectOpenResult>;
    openRecent(id: string): Promise<ProjectOpenResult>;
    /** 保存到句柄对应的文件；句柄为 null 时弹出保存对话框 */
    save(handle: string | null, data: ProjectData): Promise<ProjectSaveResult>;
    /** 弹出保存对话框 */
    saveAs(data: ProjectData): Promise<ProjectSaveResult>;
    recents(): Promise<RecentProject[]>;
  };
  host: {
    /** 主进程请界面执行命令（H11）；请求在界面一侧再按 schema 校验。返回取消订阅的函数 */
    onCommand(callback: (request: HostCommandRequest) => void): () => void;
    /** 交回命令的结果；主进程按 schema 校验 */
    commandResult(result: HostCommandResult): Promise<boolean>;
    setMacMenuState?(state: MacMenuState): Promise<void>;
    /** 界面就绪：首屏画完、初始模板装好、命令通道接好之后调用一次（M8） */
    ready(): Promise<void>;
  };
  /** 默认文件夹（6.11）：只传“哪一个”，路径由主进程的文件夹对话框选，回来的路径只用于显示 */
  folders: {
    get(): Promise<FoldersInfo>;
    choose(kind: FolderKind): Promise<FolderChooseResult>;
    reset(kind: FolderKind): Promise<FolderInfo>;
  };
  /** 自动更新：联网、下载和安装都在主进程，界面只看状态、发指令 */
  updates: {
    state(): Promise<UpdateState>;
    /** 手动检查（设置页的“检查更新”） */
    check(): Promise<UpdateState>;
    /** 下载并校验这台机器的安装包 */
    download(): Promise<UpdateState>;
    cancel(): Promise<void>;
    /** 运行下好的安装包并退出应用 */
    install(): Promise<UpdateState>;
    onChanged(callback: (state: UpdateState) => void): () => void;
  };
  cache: {
    getThumb(stamp: string, key: string): Promise<Uint8Array | null>;
    putThumb(stamp: string, key: string, png: Uint8Array): Promise<void>;
    clear(): Promise<void>;
    usage(): Promise<CacheUsage>;
  };
}
