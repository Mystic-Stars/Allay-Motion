import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import type { BrowserWindow, BrowserWindowConstructorOptions, MessageBoxReturnValue } from 'electron';
import { beforeEach, expect, it, vi } from 'vitest';
import { registerCodeInspector } from '../../apps/desktop/src/main/code-inspector';
import type { Logger } from '../../apps/desktop/src/main/logger';
import { CODE_INSPECTOR_CHANNELS as channels } from '../../apps/desktop/src/shared/code-inspector';

class WindowFixture extends EventEmitter {
  readonly webContents = Object.assign(new EventEmitter(), {
    mainFrame: { url: '', detached: false, send: vi.fn() },
    session: {},
    isDestroyed: () => this.destroyed,
    setAudioMuted: vi.fn(),
  });
  readonly show = vi.fn();
  readonly focus = vi.fn();
  readonly removeMenu = vi.fn();
  destroyed = false;

  constructor(readonly options: BrowserWindowConstructorOptions) {
    super();
    windows.push(this);
  }

  async loadURL(url: string) {
    this.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    this.webContents.mainFrame = { url, detached: false, send: vi.fn() };
    this.webContents.emit('did-navigate');
  }

  getBounds() { return { x: 0, y: 0, width: 1000, height: 800 }; }
  isDestroyed() { return this.destroyed; }
  isMinimized() { return false; }
  isVisible() { return this.show.mock.calls.length > 0; }
  destroy() { this.destroyed = true; this.emit('closed'); }
  close() {
    const preventDefault = vi.fn();
    this.emit('close', { preventDefault });
    if (!preventDefault.mock.calls.length) this.destroy();
  }
  sender(senderFrame = this.webContents.mainFrame) { return { sender: this.webContents, senderFrame }; }
}

const windows: WindowFixture[] = [];
const ipc = new Map<string, (...args: unknown[]) => void>();
const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
const prompt = vi.fn<() => Promise<MessageBoxReturnValue>>();

const runtime = {
  BrowserWindow: WindowFixture,
  dialog: { showMessageBox: prompt },
  ipcMain: { on: ipc.set.bind(ipc), handle: handlers.set.bind(handlers) },
  screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
} as unknown as NonNullable<Parameters<typeof registerCodeInspector>[1]>;

async function setup(hiddenForTests: boolean) {
  const controller = registerCodeInspector({ devOrigin: 'http://localhost:5173', hiddenForTests, log: { warn: vi.fn() } as unknown as Logger }, runtime);
  const parent = new WindowFixture({});
  controller.attach(parent as unknown as BrowserWindow);
  await parent.loadURL('http://localhost:5173/');
  return { controller, parent, open: () => handlers.get(channels.open)!(parent.sender()) };
}

beforeEach(() => { windows.length = 0; ipc.clear(); handlers.clear(); prompt.mockReset(); });

it('T-ARC-6 只接受注册主框架，重载与重开不混入陈旧消息', async () => {
  const { parent, open } = await setup(true);
  const document = {
    type: 'document', token: 1, id: 'test.template', version: '1', title: 'Test',
    source: '', manifest: '{}', editable: true, baseVersion: 'base', language: 'en', theme: 'light',
  };
  const params = { type: 'params', token: 1, params: { scale: 1 }, fps: 60 };
  const frame = { type: 'frame', token: 1, time: 0, frame: 0, lines: [1], playing: false };
  const setupTrace = { type: 'setup', token: 1, lines: [3, 4] };
  await open();
  ipc.get(channels.publish)!(parent.sender(), document);
  ipc.get(channels.publish)!(parent.sender(), params);
  ipc.get(channels.publish)!(parent.sender(), frame);
  ipc.get(channels.publish)!(parent.sender(), setupTrace);
  await open();
  expect(windows).toHaveLength(2);
  const child = windows[1]!;
  expect(child.webContents.mainFrame.url).toBe('http://localhost:5173/code-inspector.html');
  expect(child.options).toMatchObject({ show: false, focusable: false, modal: false, skipTaskbar: true });
  expect(child.show).not.toHaveBeenCalled();
  expect(child.focus).not.toHaveBeenCalled();
  expect(() => handlers.get(channels.open)!(child.sender())).toThrow('rejected');
  ipc.get(channels.publish)!(child.sender(), { ...document, token: 5 });
  ipc.get(channels.publish)!(parent.sender(), { ...frame, token: 4 });
  ipc.get(channels.publish)!(parent.sender(), { ...setupTrace, token: 4 });
  ipc.get(channels.publish)!(parent.sender(), { ...setupTrace, lines: [0] });
  ipc.get(channels.publish)!(parent.sender(), { ...setupTrace, lines: Array<number>(4097).fill(1) });
  ipc.get(channels.ready)!(child.sender());
  const replay = [[channels.packet, document], [channels.packet, params], [channels.packet, setupTrace], [channels.packet, frame]];
  expect(child.webContents.mainFrame.send.mock.calls).toEqual(replay);

  const old = child.sender();
  await child.loadURL(child.webContents.mainFrame.url);
  ipc.get(channels.ready)!(child.sender());
  expect(child.webContents.mainFrame.send.mock.calls).toEqual(replay);
  const { send } = parent.webContents.mainFrame;
  send.mockClear();
  ipc.get(channels.action)!(old, { type: 'copy', token: 1 });
  ipc.get(channels.action)!(parent.sender(), { type: 'authoring' });
  const copy = { type: 'copy', token: 1 };
  const childFrame = child.webContents.mainFrame;
  childFrame.url += '#different';
  ipc.get(channels.action)!(child.sender(), copy);
  childFrame.url = 'http://localhost:5173/code-inspector.html';
  ipc.get(channels.action)!(child.sender(), { type: 'save', token: 1, source: '', manifest: '{}', baseVersion: 'stale' });
  ipc.get(channels.action)!(child.sender(), { ...copy, path: 'not allowed' });
  ipc.get(channels.action)!(child.sender(), copy);
  expect(send.mock.calls).toEqual([[channels.parentAction, copy]]);

  child.close();
  await open();
  const reopened = windows[2]!;
  ipc.get(channels.ready)!(reopened.sender());
  ipc.get(channels.action)!(child.sender(), copy);
  expect(reopened.webContents.mainFrame.send).not.toHaveBeenCalled();
  expect(send.mock.calls).toEqual([[channels.parentAction, copy], [channels.openChanged, false], [channels.openChanged, true]]);
  ipc.get(channels.publish)!(parent.sender(), { ...document, token: 2 });
  ipc.get(channels.publish)!(parent.sender(), { ...frame, token: 2 });
  ipc.get(channels.publish)!(parent.sender(), setupTrace);
  ipc.get(channels.publish)!(parent.sender(), { ...setupTrace, token: 2, lines: [] });
  ipc.get(channels.publish)!(parent.sender(), document);
  expect(reopened.webContents.mainFrame.send.mock.calls).toEqual([
    [channels.packet, { ...document, token: 2 }], [channels.packet, { ...frame, token: 2 }], [channels.packet, { ...setupTrace, token: 2, lines: [] }],
  ]);
  parent.close();
  expect(reopened.destroyed).toBe(true);
});

it('T-ARC-6 有脏状态时取消关闭或确认放弃；应用退出不等待确认', async () => {
  const { controller, open } = await setup(false);
  await open();
  const child = windows[1]!;
  ipc.get(channels.ready)!(child.sender());
  ipc.get(channels.dirty)!(child.sender(), true);
  prompt.mockResolvedValueOnce({ response: 0, checkboxChecked: false });
  child.close();
  await setImmediate();
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(child.destroyed).toBe(false);
  prompt.mockResolvedValueOnce({ response: 1, checkboxChecked: false });
  child.close();
  await vi.waitFor(() => expect(child.destroyed).toBe(true));
  await open();
  const reopened = windows[2]!;
  ipc.get(channels.ready)!(reopened.sender());
  ipc.get(channels.dirty)!(reopened.sender(), true);
  controller.shutdown();
  expect(reopened.destroyed).toBe(true);
  expect(prompt).toHaveBeenCalledTimes(2);
});
