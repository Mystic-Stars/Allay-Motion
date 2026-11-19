// pnpm test:website 用的 Electron 主进程：在一个不显示的窗口里打开官网（vite preview 起的本机地址）。
// 用 Electron 自带的 Chromium 当浏览器（和 test:engine 一样），不需要另外下载浏览器；真实的 WebGL2、Worker、iframe。
// 官网自己不发外部请求；这里再记下所有不是本机地址的请求，测试据此判定（T-WEB-1）。
import { app, BrowserWindow, session } from 'electron';
import { join } from 'node:path';

const SITE_URL = process.env.ALLAY_SITE_URL ?? 'http://localhost:4180/';
const origin = new URL(SITE_URL).origin;
// 用户数据目录由测试指定（测试结束时删掉，不在 %TEMP% 里越积越多）
app.setPath('userData', process.env.ALLAY_SITE_USERDATA ?? join(app.getPath('temp'), `allay-website-test-${process.pid}`));

// 与引擎测试使用同一开关，便于在本机用 WARP / SwiftShader 复现 CI 的慢帧。
const ANGLE_BACKENDS = new Set(['d3d11-warp', 'swiftshader']);
if (ANGLE_BACKENDS.has(process.env.ALLAY_ENGINE_ANGLE ?? '')) {
  app.commandLine.appendSwitch('use-gl', 'angle');
  app.commandLine.appendSwitch('use-angle', process.env.ALLAY_ENGINE_ANGLE);
}

/** 不是本机地址的请求（devtools、blob、data 不算） */
globalThis.externalRequests = [];

app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
    const ok = details.url.startsWith(origin) || /^(blob|data|devtools|chrome-extension):/.test(details.url);
    if (!ok) globalThis.externalRequests.push(details.url);
    // 测试里一律不放外部请求出去（官网本来也不该发）
    cb({ cancel: !ok });
  });
  const win = new BrowserWindow({
    show: false,
    skipTaskbar: true,
    width: Number(process.env.ALLAY_SITE_WIDTH ?? 1440),
    height: 900,
    useContentSize: true,
    // 离屏渲染、固定 60 帧：不显示的窗口在 Windows 上会被降到每秒一帧左右，按时间播的动画在那种节奏下测不出真实的样子
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true },
  });
  win.webContents.setFrameRate(60);
  win.webContents.setAudioMuted(true);
  void win.loadURL(SITE_URL);
});
app.on('window-all-closed', () => app.quit());
