import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { app, Menu, session, shell, type BrowserWindow } from 'electron';
import { IPC } from '../shared/ipc-channels';
import type { MacMenuState } from '../shared/mac-menu';
import type { RecentProject } from '../shared/project';
import { handleAppProtocol, registerAppScheme } from './app-protocol';
import { registerCodeInspector } from './code-inspector';
import { FileGrants } from './file-grants';
import { registerHandlers } from './handlers';
import { registerSkinHandlers } from './skins/handlers';
import { ProjectService } from './project/service';
import { ExportService } from './export/export-service';
import { createIpcRegistrar } from './ipc';
import { createLogger } from './logger';
import { macMenuTemplate } from './mac-menu';
import { createVanillaDownloader, MOJANG_HOSTS } from './resources/download';
import { ResourceService } from './resources/service';
import { APP_ENTRY_URL, APP_ORIGIN, assertLocalDevOrigin } from './security-policy';
import { hardenSession, installGlobalHardening } from './security';
import { FolderService } from './folders';
import { SettingsStore } from './settings-store';
import { readTestSwitches } from './test-switches';
import { ThumbCache } from './thumb-cache';
import { PresetStore } from './templates/preset-store';
import { TemplateService } from './templates/service';
import { TemplateDevService } from './templates/dev-service';
import { TemplateWatcher } from './templates/dev-watcher';
import { TEMPLATE_API_DTS } from './templates/template-api-dts';
import { HostCommandChannel } from './host-commands';
import { filesFromArgv, filesFromOpenEvent, OpenFileQueue } from './open-files';
import { Splash } from './splash';
import { createMainWindow } from './window';
import { startup } from './startup-timing';
import { UpdateService } from './updates/service';

startup.mark('main-loaded');

/** 主进程最多等启动画面的第一帧这么久，再继续启动（见 Splash.firstFrame） */
const SPLASH_FIRST_FRAME_WAIT_MS = 1000;

// ---- 必须在 ready 之前完成的事 ----

// 应用数据目录（1.9）：固定的内部目录名，不随包名或产品名变（换品牌时用户数据不丢）
app.setPath('userData', join(app.getPath('appData'), 'AllayMotion'));

// 仅限未打包的构建：测试用独立的数据目录，以及后台运行（窗口不显示、不抢焦点）。
// 只影响数据放哪、窗口显不显示；1.6 的安全设置在两种情况下完全相同。
const testSwitches = readTestSwitches(app.isPackaged, process.env);
if (testSwitches.userDataDir) app.setPath('userData', testSwitches.userDataDir);
const hiddenForTests = testSwitches.hiddenWindow;
// 不显示的窗口没有显示器的垂直同步，Chromium 退回每秒 1 帧的帧时钟；主线程有时要等到下一帧才继续处理消息，
// 可见窗口里这个等待不超过一帧（约 16 ms），隐藏窗口里会被拉长到将近 1 秒（docs/decisions.md M2b“T-ARC-5 的 1 秒空洞”）。
// 测试窗口去掉帧率限制，让帧时钟和可见窗口一样快。只影响帧的节拍，不碰 1.6 的任何安全设置；打包后 hiddenForTests 恒为假。
if (hiddenForTests) app.commandLine.appendSwitch('disable-frame-rate-limit');
// 测 WebGL2 不可用时的说明页（M8）：只在未打包时、设了测试开关时模拟“没有可用的显卡”——关掉 GPU，
// 也关掉软件渲染的兜底（SwiftShader），WebGL 因此取不到上下文。（--disable-webgl 在这个版本上拦不住 WebGL2，实测过）
if (testSwitches.noWebgl) {
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-software-rasterizer');
}

registerAppScheme();
app.enableSandbox();

// 开发服务器只在未打包时生效，且必须是本机地址（1.6 第 2、3 条）
const devOrigin = !app.isPackaged && process.env.ELECTRON_RENDERER_URL ? assertLocalDevOrigin(process.env.ELECTRON_RENDERER_URL) : null;

const log = createLogger(join(app.getPath('userData'), 'logs'));
installGlobalHardening(devOrigin, log);
startup.attach(log);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let mainWindow: BrowserWindow | null = null;
  const codeInspector = registerCodeInspector({ devOrigin, hiddenForTests, log });
  const settings = new SettingsStore(join(app.getPath('userData'), 'settings.json'), log);
  const folders = new FolderService({ settings, log, getMainWindow: () => mainWindow, pickForTests: testSwitches.pickFolder });
  const exports = new ExportService({
    folders,
    log,
    settings,
    getMainWindow: () => mainWindow,
    ffmpegOverride: testSwitches.ffmpeg,
    testTarget: testSwitches.exportTarget,
    h264Candidates: testSwitches.h264Candidates,
  });

  const userData = app.getPath('userData');
  // 仓库根目录下的 resources/（开发）或安装目录的 resources/（打包后）
  const bundledResources = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), '../../resources');
  // 悦灵的烘焙产物（docs/decisions.md M5a、M5b）：打包后在安装目录的 resources/mascot，开发时在 packages/mascot/generated；
  // 测试可以换成自己生成的假图集或空目录。缺了界面就用占位实现
  const mascotDir = app.isPackaged ? join(process.resourcesPath, 'mascot') : (testSwitches.mascotDir ?? join(app.getAppPath(), '../../packages/mascot/generated'));
  const resources = new ResourceService({
    userDataDir: userData,
    builtinDir: join(bundledResources, 'builtin-pack'),
    settings,
    log,
    // 测试用 ALLAY_E2E_GAME_APPDATA 代替 %APPDATA%（只在未打包时生效），不碰这台机器上真装的游戏
    gameEnv: { platform: process.platform, appData: testSwitches.gameAppData ?? process.env.APPDATA, home: testSwitches.gameAppData ?? homedir() },
    // 运行时下载原版 jar：只在主进程、只在用户点了按钮后（decisions.md M2a）。
    // 假服务器只有未打包且设了测试环境变量时才会传入；打包后 createVanillaDownloader 拒绝 testOrigins
    downloader: createVanillaDownloader({
      cacheDir: join(userData, 'vanilla-cache'),
      packaged: app.isPackaged,
      ...(testSwitches.mojangOrigin ? { testOrigins: Object.fromEntries(MOJANG_HOSTS.map((h) => [h, testSwitches.mojangOrigin!])) } : {}),
    }),
    onChanged: (state) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.resources.changed, state);
    },
  });
  const thumbs = new ThumbCache(userData);
  let updateService: UpdateService | undefined;
  // 模板：内置的来自 resources/templates/（pnpm templates:build 的产物），用户的在 userData/templates/（4.8、4.9）
  const templates = new TemplateService({ builtinDir: join(bundledResources, 'templates'), userDataDir: userData, appVersion: app.getVersion(), log });
  const presets = new PresetStore(userData, log);
  const templatesReady = templates.init().catch((error: unknown) => log.error('templates', 'init failed', { error }));
  // 模板开发模式（MD）：监视 userData/templates/，外部改动经 templates:changed 推给渲染进程。
  // shell.openPath 只会收到模板的文件夹（dev-service 里按 id 和版本解析、确认在用户模板目录之内）
  const templateDev = new TemplateDevService({
    templates,
    watcher: new TemplateWatcher({ root: join(userData, 'templates'), log }),
    templateApiDts: TEMPLATE_API_DTS,
    openFolder: (dir) => shell.openPath(dir),
    log,
  });
  templateDev.onChange((change) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.templates.changed, change);
  });

  // 主进程到界面的命令通道（H11）。测试开关打开时（只在未打包时）挂到全局，e2e 从主进程一侧调用它
  const hostCommands = new HostCommandChannel({
    send: (request) => {
      if (!mainWindow || mainWindow.isDestroyed()) return false;
      mainWindow.webContents.send(IPC.host.command, request);
      return true;
    },
    log,
  });
  if (testSwitches.testHooks) (globalThis as { __allayHostCommands?: HostCommandChannel }).__allayHostCommands = hostCommands;

  // 文件关联与第二实例参数（M8）：路径换成一次性令牌，经命令通道请界面打开；界面就绪（host.ready）之前排队
  const openFiles = new OpenFileQueue({ run: (command, input, opts) => hostCommands.run(command, input, opts), log });
  if (testSwitches.testHooks) (globalThis as { __allayOpenFiles?: OpenFileQueue }).__allayOpenFiles = openFiles;
  openFiles.enqueue(filesFromArgv(process.argv, process.cwd()));
  // macOS 不经启动参数传关联文件，而是发 open-file（应用没开时在 ready 之前就会来，所以在这里就注册）；
  // 应用开着时系统也把它交给已有的进程，不会起第二实例。Windows 上不会有这个事件
  app.on('open-file', (event, path) => {
    event.preventDefault();
    openFiles.enqueue(filesFromOpenEvent(path));
  });

  app.on('second-instance', (_event, argv, workingDirectory) => {
    openFiles.enqueue(filesFromArgv(argv, workingDirectory));
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on('window-all-closed', () => app.quit());

  // 退出前等设置写完、取消进行中的导出（不留临时文件）
  let quitting = false;
  let flushed = false;
  app.on('before-quit', (event) => {
    if (flushed) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    codeInspector.shutdown();
    resources.cancelDownload();
    updateService?.stop();
    void Promise.allSettled([settings.flush(), exports.cancelAll()]).finally(() => {
      resources.close();
      templateDev.close();
      flushed = true;
      app.quit();
    });
  });

  void app.whenReady().then(async () => {
    if (quitting) return;
    startup.mark('app-ready');
    log.info('app', 'starting', { version: app.getVersion(), packaged: app.isPackaged, dev: devOrigin !== null });
    hardenSession(session.defaultSession, devOrigin, log);
    handleAppProtocol(join(__dirname, '../renderer'), log, mascotDir);

    // 同步读：启动画面要按主题和语言挑页面，越早建越早出现（T-ARC-7）
    settings.loadSync();
    startup.mark('settings-loaded');

    // 自动更新（docs/decisions.md“自动更新”）：只有打包后的应用会自动检查；安装时运行安装包或打开 dmg，然后退出
    const updates = new UpdateService({
      currentVersion: app.getVersion(),
      packaged: app.isPackaged,
      downloadDir: join(userData, 'updates'),
      platform: process.platform,
      arch: process.arch,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      prefs: () => settings.ui.updates,
      log,
      onChanged: (state) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.updates.changed, state);
      },
      quit: () => app.quit(),
      openPath: (path) => shell.openPath(path),
      tempDir: tmpdir(),
      // 安装目录旁边（安装盘上）：系统临时文件夹所在磁盘不够时让安装程序用它（docs/decisions.md“安装时临时空间不足”）
      fallbackTempDir: app.isPackaged && process.platform === 'win32' ? join(dirname(dirname(process.execPath)), 'AllayMotion-update-temp') : null,
    });
    updateService = updates;

    // 启动画面（7.6 C）：设置读完就显示（要按主题和语言挑页面），主窗口就绪后淡出。后台测试默认不建，设了开关才建（不显示）
    let splash: Splash | null =
      !hiddenForTests || testSwitches.splash
        ? new Splash({ origin: devOrigin ?? APP_ORIGIN, ui: settings.ui, mascotDir, log, hiddenForTests })
        : null;

    const registrar = createIpcRegistrar({ getMainWindow: () => mainWindow, devOrigin, log });
    // 模板列表在注册 IPC 之前准备好：渲染进程第一次 templates.list 就能拿到内置模板
    if (splash) await splash.firstFrame(SPLASH_FIRST_FRAME_WAIT_MS);
    await templatesReady;
    if (quitting) return;
    // 监视在模板列表就绪之后开始，不阻塞窗口（只读一遍现有用户模板的文件算哈希）
    void templateDev.start().catch((error: unknown) => log.warn('templates', 'template folder watcher did not start', { error: String(error) }));
    const grants = new FileGrants();
    const projects = new ProjectService({ userDataDir: userData, appVersion: app.getVersion(), grants, log });
    const isMac = process.platform === 'darwin';
    let menuState: MacMenuState | null = null;
    let rendererReady = false;
    let recents: Pick<RecentProject, 'id' | 'name'>[] = [];
    let menuSignature = '';
    const refreshMenu = () => {
      if (!isMac) return;
      const { language, theme, editor } = settings.ui;
      const fullScreen = mainWindow?.isFullScreen() ?? false;
      const state = rendererReady ? menuState : null;
      const signature = JSON.stringify([language, theme, editor.background, editor.guides, fullScreen, state, recents]);
      if (signature === menuSignature) return;
      menuSignature = signature;
      Menu.setApplicationMenu(Menu.buildFromTemplate(macMenuTemplate({
        appName: app.name,
        systemLocale: app.getPreferredSystemLanguages()[0] ?? app.getLocale(),
        ui: settings.ui,
        state,
        recents,
        fullScreen,
        run: (command, input) => {
          if (!rendererReady || !menuState?.enabled.includes(command)) return;
          void hostCommands.run(command, input, { source: 'mac-menu', timeoutMs: 5 * 60_000 }).then((result) => {
            if (!result.ok && result.error !== 'disabled') log.warn('mac-menu', 'command failed', { command, error: result.error });
          });
        },
      })));
    };
    const refreshRecents = () => {
      void projects.recents().then((items) => {
        recents = items.map(({ id, name }) => ({ id, name }));
        refreshMenu();
      }).catch((error: unknown) => log.warn('mac-menu', 'recent projects unavailable', { error: String(error) }));
    };
    refreshMenu();
    if (isMac) refreshRecents();
    registerHandlers({
      registrar,
      settings,
      grants,
      exports,
      resources,
      thumbs,
      templates,
      templateDev,
      hostCommands,
      openFiles,
      folders,
      updates,
      onRendererReady: () => {
        startup.mark('renderer-ready');
        rendererReady = true;
        refreshMenu();
        openFiles.markReady();
      },
      ...(isMac && {
        onMacMenuState: (state: MacMenuState) => {
          menuState = state;
          refreshMenu();
        },
        onProjectRecentsChanged: refreshRecents,
      }),
      presets,
      projects,
      projectPathForTests: testSwitches.projectPath,
      testHooks: testSwitches.testHooks,
      getMainWindow: () => mainWindow,
    });
    registerSkinHandlers(registrar, userData, () => mainWindow);
    // 资源栈：内置层和资源包先打开，原版层在后台离线探测（3.4），结果经 resources:changed 推给渲染进程
    void resources.init();
    // 启动时跑一次 ffmpeg -version 并记进日志（5.6），不阻塞窗口
    void exports.ffmpegInfo();
    let updatePrefs = settings.ui.updates;
    settings.onUiChanged((ui) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.settings.changed, ui);
      refreshMenu();
      if (ui.updates !== updatePrefs) {
        updates.prefsChanged(updatePrefs, ui.updates);
        updatePrefs = ui.updates;
      }
    });
    // 自动检查更新（设置为 off 时每次都跳过；未打包的构建不自动检查）
    updates.start();

    mainWindow = createMainWindow({
      settings,
      theme: settings.ui.theme,
      log,
      hiddenForTests,
      beforeShow: () => splash?.ready() ?? Promise.resolve(),
      onShown: () => {
        splash?.close();
        splash = null;
      },
    });
    codeInspector.attach(mainWindow);
    // 后台测试的窗口不显示，没有 onShown：页面加载完就关掉启动画面（仍然等满最短时长）
    if (hiddenForTests && splash) {
      const s = splash;
      mainWindow.once('ready-to-show', () => void s.ready().then(() => s.close()));
    }
    // 文件夹形式的资源包：窗口重新获得焦点时重扫（3.5）
    mainWindow.on('focus', () => void resources.rescanFolders());
    // 页面重新加载（开发时）：等新页面再次 host.ready 才继续执行文件关联的请求
    const resetRendererMenu = () => {
      rendererReady = false;
      menuState = null;
      refreshMenu();
    };
    mainWindow.webContents.on('did-start-loading', () => {
      openFiles.markNotReady();
      if (isMac) resetRendererMenu();
    });
    if (isMac) {
      mainWindow.webContents.on('render-process-gone', resetRendererMenu);
      mainWindow.on('enter-full-screen', refreshMenu);
      mainWindow.on('leave-full-screen', refreshMenu);
    }
    mainWindow.on('closed', () => {
      mainWindow = null;
      if (isMac) resetRendererMenu();
      openFiles.markNotReady();
      hostCommands.cancelAll();
      splash?.close();
    });
    await mainWindow.loadURL(devOrigin ?? APP_ENTRY_URL);
  });
}
