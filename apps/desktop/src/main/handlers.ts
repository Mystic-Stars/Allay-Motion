import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { app, dialog, shell, type BrowserWindow } from 'electron';
import type { AppInfo, PickedFile } from '../shared/ipc-contract';
import type { AddPackResult, ChooseGameDirResult } from '../shared/resources';
import { IPC } from '../shared/ipc-channels';
import { TITLEBAR_OVERLAY_HEIGHT } from '../shared/theme-colors';
import { UnknownJobError, type ExportService } from './export/export-service';
import type { FileGrants } from './file-grants';
import { IpcRejected, type createIpcRegistrar } from './ipc';
import type { ResourceService } from './resources/service';
import { SoundImports } from './resources/sound-imports';
import { SoundExtensionSchema } from '../shared/sound';
import type { SettingsStore } from './settings-store';
import type { ThumbCache } from './thumb-cache';
import type { ExportFileResult, StageResult } from '../shared/templates';
import type { PresetStore } from './templates/preset-store';
import type { ProjectService } from './project/service';
import { PROJECT_EXTENSION, type ProjectOpenResult, type ProjectSaveResult } from '../shared/project';
import type { TemplateService } from './templates/service';
import type { TemplateDevService } from './templates/dev-service';
import type { HostCommandChannel } from './host-commands';
import type { OpenFileQueue } from './open-files';
import type { FolderService } from './folders';
import type { UpdateService } from './updates/service';
import type { MacMenuState } from '../shared/mac-menu';
import { encodeCompositionPackage, readCompositionArchive, writeCompositionAtomic } from './templates/composition-package';
import type { CompositionPackageResult, ReadCompositionPackageResult } from '../shared/template-authoring';

const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

export interface HandlerDeps {
  registrar: ReturnType<typeof createIpcRegistrar>;
  settings: SettingsStore;
  grants: FileGrants;
  exports: ExportService;
  resources: ResourceService;
  thumbs: ThumbCache;
  templates: TemplateService;
  templateDev: TemplateDevService;
  hostCommands: HostCommandChannel;
  /** 文件关联与第二实例参数（M8）：令牌换路径 */
  openFiles: OpenFileQueue;
  /** 默认文件夹（界面增强） */
  folders: FolderService;
  /** 自动更新（docs/decisions.md“自动更新”） */
  updates: UpdateService;
  /** 界面就绪（host.ready） */
  onRendererReady(): void;
  onMacMenuState?(state: MacMenuState): void;
  onProjectRecentsChanged?(): void;
  presets: PresetStore;
  projects: ProjectService;
  /** 测试开关：工程的打开、保存对话框不弹出，直接用这个路径（只在未打包时非空） */
  projectPathForTests: string | null;
  testHooks: boolean;
  getMainWindow(): BrowserWindow | null;
}

/** 主进程的保存对话框；取消时为 null */
async function pickSavePath(win: BrowserWindow | null, defaultName: string, ext: string): Promise<string | null> {
  if (!win) return null;
  const result = await dialog.showSaveDialog(win, { defaultPath: defaultName, filters: [{ name: ext, extensions: [ext] }] });
  return result.canceled || !result.filePath ? null : result.filePath;
}

/** 未知的任务 ID 是调用方的错，拒绝这次调用，不当成主进程内部错误 */
async function knownJob<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof UnknownJobError) throw new IpcRejected('unknown export job');
    throw error;
  }
}

export function registerHandlers({ registrar, settings, grants, exports, resources, thumbs, templates, templateDev, hostCommands, openFiles, folders, updates, onRendererReady, onMacMenuState, onProjectRecentsChanged, presets, projects, projectPathForTests, testHooks, getMainWindow }: HandlerDeps): void {
  const { handle } = registrar;

  handle(IPC.app.info, (): AppInfo => ({
    version: app.getVersion(),
    platform: process.platform,
    userDataDir: app.getPath('userData'),
    systemLocale: app.getPreferredSystemLanguages()[0] ?? app.getLocale(),
    testHooks,
  }));

  handle(IPC.settings.get, () => settings.ui);
  handle(IPC.settings.set, (_event, patch) => settings.updateUi(patch));

  handle(IPC.window.setTitleBarColors, (_event, colors) => {
    const win = getMainWindow();
    // macOS 的窗口按钮（红绿灯）由系统绘制，颜色不可设（setTitleBarOverlay 只在 Windows、Linux 上有效）
    if (!win || win.isDestroyed() || process.platform === 'darwin') return;
    win.setTitleBarOverlay({ color: colors.color, symbolColor: colors.symbolColor, height: TITLEBAR_OVERLAY_HEIGHT });
  });

  // 只重新载入发起请求的那个窗口的页面（同一个 app:// 地址，不经导航拦截之外的任何路）
  handle(IPC.window.reload, (event) => {
    event.sender.reload();
  });

  handle(IPC.files.pickImage, async (): Promise<PickedFile | null> => {
    const win = getMainWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    });
    const path = result.filePaths[0];
    if (result.canceled || !path) return null;
    return { ref: grants.grant(path), name: basename(path) };
  });

  handle(IPC.files.read, async (_event, ref) => {
    const path = grants.resolve(ref);
    if (!path) throw new IpcRejected('unknown file reference');
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw new IpcRejected('file not readable');
    return new Uint8Array(await readFile(path));
  });

  handle(IPC.fonts.list, async (_event, profile) => {
    await resources.whenOpened();
    return { resources: await resources.fontIds(profile) };
  });

  // ---- resources（03-assets.md）----
  handle(IPC.resources.layers, async () => {
    await resources.whenOpened();
    return resources.state();
  });
  handle(IPC.resources.stamp, async () => {
    await resources.whenOpened();
    return resources.resourceStamp;
  });
  handle(IPC.resources.read, (_event, path, profile) => resources.read(path, profile));
  handle(IPC.resources.readTexture, (_event, id, profile) => resources.readTexture(id, profile));
  handle(IPC.resources.list, (_event, prefix, profile) => resources.list(prefix, profile));
  const soundImports = new SoundImports(app.getPath('userData'));
  handle(IPC.sound.pick, async (_event, kind) => {
    const win = getMainWindow();
    if (!win) return null;
    const selection = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Audio', extensions: [...SoundExtensionSchema.options] }] });
    const path = selection.filePaths[0];
    return !selection.canceled && path ? soundImports.add(path, kind) : null;
  });
  handle(IPC.sound.list, () => soundImports.list());
  handle(IPC.sound.read, (_event, id, profile) => id.startsWith('user-audio:') ? soundImports.read(id) : resources.readSound(id, profile));
  handle(IPC.sound.fetchNames, () => resources.fetchSoundNames());
  handle(IPC.resources.soundVariants, (_event, id, profile) => id.startsWith('user-audio:') ? soundImports.variants(id) : resources.soundVariants(id, profile));
  handle(IPC.resources.soundLibrary, (_event, profile) => resources.soundLibrary(profile));
  handle(IPC.resources.soundFiles, (_event, files, fetch, profile) => resources.soundFiles(files, fetch, profile));
  handle(IPC.resources.fontProviders, (_event, id, profile) => resources.fontProviders(id, profile));
  handle(IPC.resources.detectMinecraft, () => resources.detectMinecraft());
  handle(IPC.resources.setVanilla, (_event, patch) => resources.setVanilla(patch));
  handle(IPC.resources.selectProfile, (_event, id) => resources.selectProfile(id));
  handle(IPC.resources.officialVersions, () => resources.listOfficialVersions());
  handle(IPC.resources.instancePacks, (_event, id) => resources.instancePacks(id));
  handle(IPC.resources.setInstancePack, (_event, id, pack, enabled) => resources.setInstancePack(id, pack, enabled));
  handle(IPC.resources.locateProfile, async (_event, id, target) => {
    const path = await resources.locateProfile(id, target);
    if (!path) return false;
    shell.showItemInFolder(path);
    return true;
  });
  handle(IPC.resources.chooseGameDir, async (_event, reconnectId): Promise<ChooseGameDirResult> => {
    const win = getMainWindow();
    if (!win) return { canceled: true };
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    const dir = result.filePaths[0];
    if (result.canceled || !dir) return { canceled: true };
    return resources.useGameDir(dir, reconnectId);
  });
  handle(IPC.resources.downloadVanilla, (_event, versionId) => resources.downloadVanilla(versionId));
  handle(IPC.resources.cancelDownload, () => resources.cancelDownload());
  handle(IPC.resources.addPack, async (_event, kind, reconnectId): Promise<AddPackResult> => {
    const win = getMainWindow();
    if (!win) return { canceled: true };
    const result = await dialog.showOpenDialog(
      win,
      kind === 'zip' ? { properties: ['openFile'], filters: [{ name: 'ZIP / MCPACK', extensions: ['zip', 'mcpack'] }] } : { properties: ['openDirectory'] },
    );
    const path = result.filePaths[0];
    if (result.canceled || !path) return { canceled: true };
    return resources.addPackFromPath(path, reconnectId);
  });
  // 拖放：路径由 preload 用 webUtils.getPathForFile 从真实的 File 取得（1.6 第 6 条）
  handle(IPC.resources.addDroppedPack, (_event, path) => {
    if (!isAbsolute(path)) throw new IpcRejected('dropped file has no path');
    return resources.addPackFromPath(path);
  });
  handle(IPC.resources.removeLayer, (_event, id) => resources.removeLayer(id));
  handle(IPC.resources.reorder, (_event, ids) => resources.reorder(ids));
  handle(IPC.resources.setEnabled, (_event, id, enabled) => resources.setEnabled(id, enabled));

  // ---- templates（04-templates.md 4.7–4.9）----
  handle(IPC.templates.list, () => templates.list());
  handle(IPC.templates.read, (_event, id, version) => templates.read(id, version));
  handle(IPC.templates.readAsset, (_event, source, path) => templates.readAsset(source, path));
  handle(IPC.templates.install, async (): Promise<StageResult> => {
    const win = getMainWindow();
    if (!win) return { canceled: true };
    const result = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Template', extensions: ['allaytpl'] }] });
    const path = result.filePaths[0];
    if (result.canceled || !path) return { canceled: true };
    return templates.stage(path);
  });
  // 拖放：路径由 preload 用 webUtils.getPathForFile 从真实的 File 取得（1.6 第 6 条）
  handle(IPC.templates.installDropped, (_event, path) => {
    if (!isAbsolute(path)) throw new IpcRejected('dropped file has no path');
    return templates.stage(path);
  });
  // 文件关联（M8）：路径只在主进程，界面拿主进程签发的一次性令牌来换（1.6 第 6 条）
  handle(IPC.templates.installRequested, (_event, token): Promise<StageResult> | StageResult => {
    const path = openFiles.take(token, 'template');
    return path ? templates.stage(path) : { ok: false, error: { code: 'staging-expired', detail: 'open request is unknown or already used' } };
  });
  handle(IPC.templates.commitInstall, (_event, stagingId, report) => templates.commit(stagingId, report));
  handle(IPC.templates.cancelInstall, (_event, stagingId) => templates.cancel(stagingId));
  handle(IPC.templates.remove, (_event, id, version) => templates.remove(id, version));
  handle(IPC.templates.exportPackage, async (_event, id, version): Promise<ExportFileResult> => {
    const bytes = await templates.exportPackage(id, version);
    if (!bytes) throw new IpcRejected('unknown template');
    const path = await pickSavePath(getMainWindow(), `${id}-${version}.allaytpl`, 'allaytpl');
    if (!path) return { canceled: true };
    await writeFile(path, bytes);
    return { ok: true, path };
  });
  // 另存为派生模板：用户选的图片（file: 引用）由主进程按引用读出、复制进模板的 assets/（4.7）
  handle(IPC.templates.saveDerived, (_event, req) => templates.saveDerived(req, (ref) => grants.resolve(ref)));
  // 模板开发模式（MD）：路径全由主进程按 id 和版本决定，只认用户模板目录里的文件夹（1.6 第 6 条）
  handle(IPC.templates.copyBuiltin, (_event, req) => templateDev.copyBuiltin(req));
  handle(IPC.templates.writeDevFiles, (_event, id, version) => templateDev.writeDevFiles({ id, version }));
  handle(IPC.templates.openFolder, (_event, id, version) => templateDev.openFolder({ id, version }));
  handle(IPC.templates.readSource, (_event, { id, version }) => templates.readSource(id, version));
  handle(IPC.templates.writeSource, (_event, { id, version }, request) => templates.writeSource(id, version, request));
  handle(IPC.templates.createBlank, (_event, name) => templates.createBlank(name));
  handle(IPC.templates.freezeComposition, async (_event, request): Promise<CompositionPackageResult> => {
    try {
      const pkg = await templates.freezeComposition(request);
      const path = await pickSavePath(getMainWindow(), 'composition.allaytpl', 'allaytpl');
      if (!path) return { canceled: true };
      await writeCompositionAtomic(path, encodeCompositionPackage(pkg));
      await templates.compositionLibrary.remember(pkg);
      return { ok: true, entry: { id: pkg.id, name: pkg.name } };
    } catch (error) {
      return { ok: false, error: String(error).slice(0, 1000) };
    }
  });
  handle(IPC.templates.importComposition, async (): Promise<CompositionPackageResult> => {
    const win = getMainWindow();
    if (!win) return { canceled: true };
    const picked = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Composition template', extensions: ['allaytpl'] }] });
    const path = picked.filePaths[0];
    if (picked.canceled || !path) return { canceled: true };
    try {
      const pkg = await readCompositionArchive(path);
      await templates.compositionLibrary.remember(pkg);
      return { ok: true, entry: { id: pkg.id, name: pkg.name } };
    } catch (error) {
      return { ok: false, error: String(error).slice(0, 1000) };
    }
  });
  handle(IPC.templates.listCompositions, () => templates.compositionLibrary.list());
  handle(IPC.templates.openComposition, async (_event, id): Promise<ReadCompositionPackageResult> => {
    try {
      return { ok: true, package: await templates.openComposition(id) };
    } catch (error) {
      return { ok: false, error: String(error).slice(0, 1000) };
    }
  });

  // ---- 主进程到界面的命令通道（H11）：界面交回结果 ----
  handle(IPC.host.commandResult, (_event, result) => hostCommands.receive(result));
  handle(IPC.host.ready, () => onRendererReady());
  handle(IPC.host.macMenuState, (_event, state) => {
    if (!onMacMenuState) throw new IpcRejected('native menu is unavailable');
    onMacMenuState(state);
  });

  // ---- project（1.9）----
  const pickProjectToOpen = async (): Promise<string | null> => {
    if (projectPathForTests) return projectPathForTests;
    const win = getMainWindow();
    if (!win) return null;
    const defaultPath = await folders.projectOpenPath();
    const result = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Project', extensions: [PROJECT_EXTENSION] }], ...(defaultPath ? { defaultPath } : {}) });
    const path = result.filePaths[0];
    return result.canceled || !path ? null : path;
  };
  // 新工程的“保存”“另存为”：对话框从默认保存文件夹开始（能用时，6.11）
  const pickProjectToSave = async (name: string): Promise<string | null> => {
    if (projectPathForTests) return projectPathForTests;
    return pickSavePath(getMainWindow(), await folders.projectSavePath(`${name.replace(/[\\/:*?"<>|]/g, '_')}.${PROJECT_EXTENSION}`), PROJECT_EXTENSION);
  };
  handle(IPC.project.open, async (): Promise<ProjectOpenResult> => {
    const path = await pickProjectToOpen();
    return path ? projects.openPath(path).finally(onProjectRecentsChanged) : { canceled: true };
  });
  handle(IPC.project.openRequested, (_event, token): Promise<ProjectOpenResult> | ProjectOpenResult => {
    const path = openFiles.take(token, 'project');
    return path ? projects.openPath(path).finally(onProjectRecentsChanged) : { ok: false, error: 'missing' };
  });
  handle(IPC.project.openRecent, (_event, id) => projects.openRecent(id).finally(onProjectRecentsChanged));
  handle(IPC.project.save, async (_event, handle, data): Promise<ProjectSaveResult> => {
    const known = handle ? projects.pathOf(handle) : null;
    if (handle && !known) throw new IpcRejected('unknown project handle');
    const path = known ?? (await pickProjectToSave(data.name));
    return path ? projects.saveTo(path, data).finally(onProjectRecentsChanged) : { canceled: true };
  });
  handle(IPC.project.saveAs, async (_event, data): Promise<ProjectSaveResult> => {
    const path = await pickProjectToSave(data.name);
    return path ? projects.saveTo(path, data).finally(onProjectRecentsChanged) : { canceled: true };
  });
  handle(IPC.project.recents, () => projects.recents());

  // ---- presets（4.7）----
  handle(IPC.presets.list, () => presets.list());
  handle(IPC.presets.save, (_event, req) => presets.save(req));
  handle(IPC.presets.remove, (_event, id) => presets.remove(id));
  handle(IPC.presets.importFile, async () => {
    const win = getMainWindow();
    if (!win) return { canceled: true } as const;
    const result = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Preset', extensions: ['allaypreset'] }] });
    const path = result.filePaths[0];
    if (result.canceled || !path) return { canceled: true } as const;
    return presets.importFrom(path);
  });
  handle(IPC.presets.exportFile, async (_event, id): Promise<ExportFileResult> => {
    const text = await presets.contents(id);
    if (text === null) throw new IpcRejected('unknown preset');
    const path = await pickSavePath(getMainWindow(), 'preset.allaypreset', 'allaypreset');
    if (!path) return { canceled: true };
    await writeFile(path, text, 'utf8');
    return { ok: true, path };
  });

  // ---- cache（缩略图，3.10）----
  handle(IPC.cache.getThumb, (_event, stamp, key) => thumbs.get(stamp, key));
  handle(IPC.cache.putThumb, async (_event, stamp, key, png) => {
    if (!(await thumbs.put(stamp, key, png))) throw new IpcRejected('thumbnail is not a PNG');
  });
  handle(IPC.cache.clear, () => thumbs.clear());
  handle(IPC.cache.usage, () => thumbs.usage());

  // ---- folders（6.11）：渲染进程只说哪一个，路径来自主进程的文件夹对话框 ----
  handle(IPC.folders.get, () => folders.all());
  handle(IPC.folders.choose, (_event, kind) => folders.choose(kind));
  handle(IPC.folders.reset, (_event, kind) => folders.reset(kind));

  // ---- updates：联网只在主进程（docs/decisions.md“自动更新”）----
  handle(IPC.updates.state, () => updates.current);
  handle(IPC.updates.check, () => updates.check(true));
  handle(IPC.updates.download, () => updates.download());
  handle(IPC.updates.cancel, () => updates.cancel());
  handle(IPC.updates.install, () => updates.install());

  handle(IPC.export.ffmpegInfo, () => exports.ffmpegInfo());
  handle(IPC.export.start, (_event, req) => exports.start(req));
  handle(IPC.export.writeFrame, (_event, jobId, pixels) => knownJob(() => exports.writeFrame(jobId, pixels)));
  handle(IPC.export.writeAudio, (_event, jobId, wav) => knownJob(() => exports.writeAudio(jobId, wav)));
  handle(IPC.export.finish, (_event, jobId) => knownJob(() => exports.finish(jobId)));
  // 取消一个已经结束或不存在的任务不算错
  handle(IPC.export.cancel, (_event, jobId) => exports.cancel(jobId));
  handle(IPC.export.probeEncoders, (_event, force) => exports.probeEncoders(force));
  handle(IPC.export.outputFolder, () => exports.outputFolder());
  handle(IPC.export.chooseFolder, () => exports.chooseFolder());
  handle(IPC.export.reveal, (_event, jobId) => knownJob(async () => exports.reveal(jobId)));
  handle(IPC.export.copyDiagnostics, (_event, text) => exports.copyDiagnostics(text));
}
