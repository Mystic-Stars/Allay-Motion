import { dialog, type BrowserWindow } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type { SkinAddResult } from '../../shared/skins';
import type { createIpcRegistrar } from '../ipc';
import { SkinError } from './errors';
import { JavaSkinLookup } from './java';
import { SkinLibrary } from './library';

const consent = {
  'zh-CN': {
    title: '按 Java 正版名获取皮肤',
    body: '将玩家名“%s”发送至 Mojang 的官方服务，查询公开档案并下载皮肤。无需登录，不上传文件；只在本次确认后联网。皮肤会保存在本机。',
    cancel: '取消',
    confirm: '同意并获取',
  },
  en: {
    title: 'Fetch skin by Java username',
    body: 'Send “%s” to Mojang’s official services to look up the public profile and download its skin. No sign-in or file upload. This allows network access only for this request. The skin is saved locally.',
    cancel: 'Cancel',
    confirm: 'Agree and fetch',
  },
} as const;

export function registerSkinHandlers(
  registrar: ReturnType<typeof createIpcRegistrar>,
  userData: string,
  getWindow: () => BrowserWindow | null,
  native: Pick<typeof dialog, 'showOpenDialog' | 'showMessageBox'> = dialog,
  lookup: Pick<JavaSkinLookup, 'fetch'> = new JavaSkinLookup(),
): void {
  const library = new SkinLibrary(userData);
  let pending = false;
  const add = async (run: () => Promise<SkinAddResult>): Promise<SkinAddResult> => {
    if (pending) return { status: 'error', code: 'busy' };
    pending = true;
    try {
      return await run();
    } catch (error) {
      return { status: 'error', code: error instanceof SkinError ? error.code : 'storage' };
    } finally {
      pending = false;
    }
  };

  registrar.handle(IPC.skins.list, () => library.list());
  registrar.handle(IPC.skins.read, (_event, ref) => library.read(ref));
  registrar.handle(IPC.skins.remove, (_event, ref) => library.remove(ref));
  registrar.handle(IPC.skins.importPng, (_event, model) => add(async () => {
    const win = getWindow();
    if (!win) return { status: 'canceled' };
    const choice = await native.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'PNG', extensions: ['png'] }] });
    if (choice.canceled || !choice.filePaths[0]) return { status: 'canceled' };
    return { status: 'added', entry: await library.importFile(choice.filePaths[0], model) };
  }));
  registrar.handle(IPC.skins.fetchJava, (_event, name, locale) => add(async () => {
    const win = getWindow();
    if (!win) return { status: 'canceled' };
    const copy = consent[locale];
    const choice = await native.showMessageBox(win, {
      type: 'question', title: copy.title, message: copy.title, detail: copy.body.replace('%s', name),
      buttons: [copy.cancel, copy.confirm], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (choice.response !== 1 || win.isDestroyed()) return { status: 'canceled' };
    const skin = await lookup.fetch(name);
    return { status: 'added', entry: await library.add(skin.bytes, skin.name, skin.model, 'java') };
  }));
}
