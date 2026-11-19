import { join } from 'node:path';
import { BrowserWindow, dialog, ipcMain, screen, type IpcMainEvent, type IpcMainInvokeEvent, type WebFrameMain } from 'electron';
import { CODE_INSPECTOR_CHANNELS as channels, type CodeInspectorPacket } from '../shared/code-inspector';
import { actionArgs, dirtyArgs, noArgs, publishArgs } from './code-inspector-contract';
import type { Logger } from './logger';
import { APP_ENTRY_URL, APP_ORIGIN } from './security-policy';

type Packet<T extends CodeInspectorPacket['type']> = Extract<CodeInspectorPacket, { type: T }>;
type CachedHeader = Packet<'document' | 'empty'>;
type Sender = IpcMainEvent | IpcMainInvokeEvent;

interface InspectorWindow {
  win: BrowserWindow;
  page: WebFrameMain | null;
  ready: WebFrameMain | null;
  dirty: boolean;
  prompt?: AbortController;
  loading?: Promise<void>;
}

interface Options {
  devOrigin: string | null;
  hiddenForTests: boolean;
  log: Logger;
}

function rateLimit(perSecond: number, burst: number) {
  let credits = burst;
  let last = performance.now();
  return () => {
    const now = performance.now();
    credits = Math.min(burst, credits + (now - last) * perSecond / 1000);
    last = now;
    if (credits < 1) return false;
    credits--;
    return true;
  };
}

function currentPage(win: BrowserWindow | null, page: WebFrameMain | null, url: string): page is WebFrameMain {
  return !!win && !win.isDestroyed() && !win.webContents.isDestroyed() && !!page
    && page === win.webContents.mainFrame && !page.detached && page.url === url;
}

function isSender(event: Sender, win: BrowserWindow | null, page: WebFrameMain | null, url: string): boolean {
  return currentPage(win, page, url) && event.sender === win?.webContents && event.senderFrame === page;
}

function inspectorBounds(parent: BrowserWindow, display: typeof screen) {
  const bounds = parent.getBounds();
  const area = display.getDisplayMatching(bounds).workArea;
  const right = bounds.x + bounds.width;
  const availableRight = area.x + area.width - right;
  const availableLeft = bounds.x - area.x;
  const side = Math.max(availableRight, availableLeft);
  const width = Math.min(720, side >= 380 ? side : area.width);
  const height = Math.min(800, area.height);
  const x = availableRight >= width ? right : availableLeft >= width ? bounds.x - width : area.x + area.width - width;
  return { x, y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - height), width, height };
}

const electron = { BrowserWindow, dialog, ipcMain, screen };

export function registerCodeInspector({ devOrigin, hiddenForTests, log }: Options, runtime = electron) {
  const parentUrl = devOrigin ? `${devOrigin}/` : APP_ENTRY_URL;
  const childUrl = `${devOrigin ?? APP_ORIGIN}/code-inspector.html`;
  let parent: BrowserWindow | null = null;
  let parentPage: WebFrameMain | null = null;
  let child: InspectorWindow | null = null;
  let shuttingDown = false;
  let header: CachedHeader | undefined;
  let newestToken = -1;
  let params: Packet<'params'> | undefined;
  let frame: Packet<'frame'> | undefined;
  let setup: Packet<'setup'> | undefined;

  const allowOpen = rateLimit(4, 4);
  const allowHeader = rateLimit(12, 16);
  const allowParams = rateLimit(120, 16);
  const allowFrame = rateLimit(120, 16);
  const allowSetup = rateLimit(120, 16);
  const allowReady = rateLimit(4, 4);
  const allowAction = rateLimit(4, 4);
  const allowDirty = rateLimit(120, 16);

  const parentIsCurrent = () => currentPage(parent, parentPage, parentUrl);
  const fromParent = (event: Sender) => !shuttingDown && isSender(event, parent, parentPage, parentUrl);
  const fromChild = (event: Sender, target: InspectorWindow) => !shuttingDown && parentIsCurrent()
    && isSender(event, target.win, target.page, childUrl);

  function notifyOpen(open: boolean): void {
    if (!shuttingDown && currentPage(parent, parentPage, parentUrl)) parentPage.send(channels.openChanged, open);
  }

  function destroyChild(): void {
    if (!child) return;
    child.prompt?.abort();
    if (!child.win.isDestroyed()) child.win.destroy();
  }

  function resetParentPage(): void {
    parentPage = null;
    header = params = frame = setup = undefined;
    newestToken = -1;
    destroyChild();
  }

  function attach(win: BrowserWindow): void {
    resetParentPage();
    parent = win;
    win.webContents.on('did-start-navigation', (details) => {
      if (parent === win && details.isMainFrame && !details.isSameDocument) resetParentPage();
    });
    win.webContents.on('did-navigate', () => {
      if (parent === win) parentPage = win.webContents.mainFrame;
    });
    win.webContents.on('render-process-gone', () => {
      if (parent === win) resetParentPage();
    });
    win.once('closed', () => {
      if (parent !== win) return;
      resetParentPage();
      parent = null;
    });
  }

  function deliver(packet: CodeInspectorPacket): void {
    if (child && currentPage(child.win, child.ready, childUrl)) child.ready.send(channels.packet, packet);
  }

  function accept(packet: CodeInspectorPacket): void {
    switch (packet.type) {
      case 'document':
        if (packet.token < newestToken || (packet.token === newestToken && header?.type !== 'document')) return;
        if (header?.type === 'document' && header.token === packet.token) {
          if (header.id !== packet.id || header.version !== packet.version || header.clipId !== packet.clipId) return;
        } else {
          params = frame = setup = undefined;
        }
        newestToken = packet.token;
        header = packet;
        break;
      case 'empty':
        header = packet;
        params = frame = setup = undefined;
        break;
      default:
        if (header?.type !== 'document' || packet.token !== header.token) return;
        if (packet.type === 'params') params = packet;
        if (packet.type === 'frame') frame = packet;
        if (packet.type === 'setup') setup = packet;
    }
    deliver(packet);
  }

  function confirmClose(target: InspectorWindow): void {
    if (hiddenForTests || target.prompt) return;
    const prompt = new AbortController();
    target.prompt = prompt;
    const chinese = header?.language === 'zh-CN';
    void runtime.dialog.showMessageBox(target.win, {
      type: 'warning',
      message: chinese ? '有未保存的更改。要放弃更改并关闭吗？' : 'Discard unsaved changes and close?',
      buttons: chinese ? ['取消', '放弃更改'] : ['Cancel', 'Discard Changes'],
      defaultId: 0,
      cancelId: 0,
      signal: prompt.signal,
    }).then(({ response }) => {
      if (response === 1 && child === target && !target.win.isDestroyed() && !prompt.signal.aborted) target.win.destroy();
    }).catch((error: unknown) => log.warn('code-inspector', 'close confirmation failed', { error })).finally(() => {
      if (target.prompt === prompt) target.prompt = undefined;
    });
  }

  async function open(owner: BrowserWindow): Promise<void> {
    if (child && !child.win.isDestroyed()) {
      if (!hiddenForTests) {
        if (child.win.isMinimized()) child.win.restore();
        if (child.win.isVisible()) child.win.focus();
      }
      return child.loading;
    }
    const win = new runtime.BrowserWindow({
      ...inspectorBounds(owner, runtime.screen),
      minWidth: 380,
      minHeight: 340,
      show: false,
      modal: false,
      focusable: !hiddenForTests,
      skipTaskbar: hiddenForTests,
      webPreferences: {
        session: owner.webContents.session,
        preload: join(__dirname, '../preload/code-inspector.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        backgroundThrottling: false,
        devTools: false,
        spellcheck: false,
        webviewTag: false,
      },
    });
    const target: InspectorWindow = { win, page: null, ready: null, dirty: false };
    child = target;
    if (process.platform !== 'darwin') win.removeMenu();
    if (hiddenForTests) win.webContents.setAudioMuted(true);
    win.webContents.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      target.page = target.ready = null;
      target.dirty = false;
      target.prompt?.abort();
    });
    win.webContents.on('did-navigate', () => { target.page = win.webContents.mainFrame; });
    win.webContents.on('render-process-gone', () => { if (child === target) destroyChild(); });
    win.webContents.on('will-prevent-unload', (event) => event.preventDefault());
    win.on('close', (event) => {
      if (shuttingDown || !target.dirty) return;
      event.preventDefault();
      confirmClose(target);
    });
    win.once('closed', () => {
      target.prompt?.abort();
      if (child !== target) return;
      child = null;
      header = params = frame = setup = undefined;
      notifyOpen(false);
    });
    notifyOpen(true);
    target.loading = win.loadURL(childUrl).then(() => {
      if (!hiddenForTests && !shuttingDown && child === target && currentPage(win, target.page, childUrl)) win.show();
    }).catch((error: unknown) => {
      if (child !== target || win.isDestroyed() || shuttingDown) return;
      destroyChild();
      log.warn('code-inspector', 'window load failed', { error });
      throw new Error('code inspector could not load');
    });
    return target.loading;
  }

  runtime.ipcMain.handle(channels.open, (event, ...args: unknown[]) => {
    if (!parent || !fromParent(event) || !allowOpen() || !noArgs.safeParse(args).success) {
      throw new Error('code inspector open rejected');
    }
    return open(parent);
  });
  runtime.ipcMain.on(channels.publish, (event, ...args: unknown[]) => {
    if (!child || !fromParent(event)) return;
    const raw = args[0];
    const type = raw && typeof raw === 'object' && 'type' in raw ? raw.type : null;
    const allowed = type === 'frame' ? allowFrame() : type === 'params' ? allowParams() : type === 'setup' ? allowSetup() : allowHeader();
    if (!allowed) return;
    const parsed = publishArgs.safeParse(args);
    if (parsed.success) accept(parsed.data[0]);
  });
  runtime.ipcMain.on(channels.ready, (event, ...args: unknown[]) => {
    if (!child || !fromChild(event, child) || !allowReady() || !noArgs.safeParse(args).success) return;
    child.ready = child.page;
    if (header) deliver(header);
    if (params) deliver(params);
    if (setup) deliver(setup);
    if (frame) deliver(frame);
  });
  runtime.ipcMain.on(channels.dirty, (event, ...args: unknown[]) => {
    if (!child?.ready || !fromChild(event, child) || !allowDirty()) return;
    const parsed = dirtyArgs.safeParse(args);
    if (parsed.success) child.dirty = parsed.data[0];
  });
  runtime.ipcMain.on(channels.action, (event, ...args: unknown[]) => {
    if (!child?.ready || !fromChild(event, child) || !allowAction()) return;
    const parsed = actionArgs.safeParse(args);
    if (!parsed.success || !currentPage(parent, parentPage, parentUrl)) return;
    const [action] = parsed.data;
    if (action.type !== 'authoring') {
      if (header?.type !== 'document' || action.token !== header.token) return;
      if (action.type === 'save' && (!header.editable || action.baseVersion !== header.baseVersion)) return;
    }
    parentPage.send(channels.parentAction, action);
  });

  return {
    attach,
    shutdown() {
      shuttingDown = true;
      resetParentPage();
    },
  };
}
