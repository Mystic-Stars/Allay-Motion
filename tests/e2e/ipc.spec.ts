import { expect, test } from '@playwright/test';
import { launchApp, makeUserDataDir, readMainLog, removeUserDataDir } from './helpers';

// T-ARC-6：向每个 IPC 方法发畸形参数；请求读取对话框没有授权过的路径。
// 判定：全部被拒绝，主进程不崩溃。

/**
 * 每个 window.allay 方法的畸形参数。新增方法时这里没有对应条目，测试会失败。
 * 绝不在这里放合法参数：files.pickImage 的合法调用会弹出对话框。
 */
const MALFORMED: Record<string, unknown[][]> = {
  'skins.list': [[1]],
  'skins.importPng': [[], ['C:\\skin.png'], ['classic', 'C:\\skin.png']],
  'skins.fetchJava': [[], ['name/../x', 'en'], ['ValidName', true], ['ValidName', 'en', 'https://example.test']],
  'skins.read': [[], ['skins:../../outside'], ['file:3f2504e0-4f89-41d3-9a0c-0305e82c3301']],
  'skins.remove': [[], ['skins:../outside'], ['3f2504e0-4f89-41d3-9a0c-0305e82c3301']],
  'app.info': [[1], [{}], ['x'], [null]],
  'settings.get': [[1], [{ theme: 'light' }], [null]],
  'settings.set': [
    [],
    [null],
    ['light'],
    [{ theme: 'purple' }],
    [{ unknownKey: true }],
    [{ language: 'fr' }],
    [{ layout: { left: { size: -1, collapsed: false } } }],
    [{ layout: { left: { size: 'wide', collapsed: false } } }],
    [{ layout: { center: { size: 100, collapsed: false } } }],
    [{ theme: 'light' }, 'extra'],
    [{ theme: 'light', layout: null }],
    [{ editor: { background: 'video' } }],
    [{ editor: { recent: { color: ['#000000'] } } }],
    [{ editor: { groups: { 'allay.builtin.block-wipe': { timing: 'yes' } } } }],
    [{ editor: { solidColor: 'red' } }],
    // 可选模块的开关表（MD-b）：键必须是目录名的格式，值必须是布尔
    [{ optionalModules: { 'Bad Name': true } }],
    [{ optionalModules: { 'code-editor': 'yes' } }],
    [{ optionalModules: ['code-editor'] }],
    [{ optionalModules: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`m${i}`, true])) }],
    ['x'.repeat(200_000)],
  ],
  'window.setTitleBarColors': [
    [],
    [{ color: 'red', symbolColor: '#FFFFFF' }],
    [{ color: '#000000' }],
    [{ color: '#000000', symbolColor: '#FFFFFF', height: 999 }],
    ['#000000', '#FFFFFF'],
  ],
  'window.reload': [[1], [{ url: 'https://example.com' }], ['app://renderer/index.html']],
  'files.pickImage': [[1], [{ defaultPath: 'C:\\Windows' }], ['C:\\']],
  'files.read': [
    [],
    [null],
    [42],
    ['C:\\Windows\\win.ini'],
    ['../../../../Windows/win.ini'],
    ['file:///C:/Windows/win.ini'],
    // 格式合法但从没被授权过的引用
    ['3f2504e0-4f89-41d3-9a0c-0305e82c3301'],
    [{ path: 'C:\\Windows\\win.ini' }],
  ],
  // 合法的 export.start 会弹保存对话框，这里只有畸形参数
  'export.start': [
    [],
    [null],
    [{ preset: 'prores4444' }],
    [{ preset: 'gif', width: 1920, height: 1080, fps: 60, totalFrames: 10, cutFrame: null, suggestedName: 'x' }],
    [{ preset: 'webm-vp9', width: 1920, height: 1080, fps: 60, totalFrames: 10, cutFrame: null, suggestedName: '' }],
    [{ preset: 'greenscreen-mp4', width: 1920, height: 1080, fps: 60, totalFrames: 10, cutFrame: null, suggestedName: 'x', encoder: 'libx264' }],
    [{ preset: 'prores4444', width: 1001, height: 563, fps: 60, totalFrames: 10, cutFrame: null, suggestedName: 'x' }],
    [{ preset: 'prores4444', width: 1920, height: 1080, fps: 61, totalFrames: 10, cutFrame: null, suggestedName: 'x' }],
    [{ preset: 'prores4444', width: 1920, height: 1080, fps: 60, totalFrames: 0, cutFrame: null, suggestedName: 'x' }],
    [{ preset: 'prores4444', width: 1920, height: 1080, fps: 60, totalFrames: 10, cutFrame: null, suggestedName: 'x', path: 'C:\\Windows\\x.mov' }],
    [{ preset: 'prores4444', width: 8192, height: 1080, fps: 60, totalFrames: 10, cutFrame: null, suggestedName: 'x' }],
  ],
  'export.writeFrame': [
    [],
    ['not-a-uuid', new Uint8Array(4)],
    ['3f2504e0-4f89-41d3-9a0c-0305e82c3301'],
    ['3f2504e0-4f89-41d3-9a0c-0305e82c3301', [1, 2, 3, 4]],
    ['3f2504e0-4f89-41d3-9a0c-0305e82c3301', 'pixels'],
    // 格式合法但不存在的任务
    ['3f2504e0-4f89-41d3-9a0c-0305e82c3301', new Uint8Array(16)],
  ],
  'export.writeAudio': [
    [],
    ['not-a-uuid', new Uint8Array(100)],
    ['3f2504e0-4f89-41d3-9a0c-0305e82c3301'],
    ['3f2504e0-4f89-41d3-9a0c-0305e82c3301', 'C:\\mix.wav'],
    // 太小（连 WAV 头都放不下）；超过上限的在单元测试里查（这里序列化几 MB 太慢）
    ['3f2504e0-4f89-41d3-9a0c-0305e82c3301', new Uint8Array(10)],
    // 格式合法但不存在的任务
    ['3f2504e0-4f89-41d3-9a0c-0305e82c3301', new Uint8Array(100)],
  ],
  'export.finish': [[], [42], ['C:\\out.mov'], ['3f2504e0-4f89-41d3-9a0c-0305e82c3301']],
  'export.cancel': [[], [null], ['../x'], ['3f2504e0-4f89-41d3-9a0c-0305e82c3301', 'extra']],
  'export.ffmpegInfo': [[1], ['C:\\ffmpeg.exe'], [{ path: 'x' }]],
  'export.probeEncoders': [[], ['true'], [1], [true, 'h264_mf'], [{ candidates: ['x'] }]],
  'export.outputFolder': [[1], ['C:\\Windows']],
  // 合法的 chooseFolder 会弹文件夹对话框，这里只有畸形参数；文件夹只能从对话框来，不接受路径
  'export.chooseFolder': [['C:\\Windows'], [{ folder: 'C:\\x' }]],
  // 格式合法但不存在（或没有完成）的任务也拒绝：只能显示这个进程里导出完成的文件
  'export.reveal': [[], ['C:\\Windows\\win.ini'], ['../x'], ['3f2504e0-4f89-41d3-9a0c-0305e82c3301'], ['3f2504e0-4f89-41d3-9a0c-0305e82c3301', 'x']],
  'export.copyDiagnostics': [[], [''], [42], ['x'.repeat(20_001)], [{ text: 'x' }], ['x', 'y']],
  'resources.layers': [[1], ['all']],
  'resources.stamp': [[1]],
  'resources.read': [
    [],
    [42],
    [null],
    ['../../../../Windows/win.ini'],
    ['C:\\Windows\\win.ini'],
    ['C:/Windows/win.ini'],
    ['/etc/passwd'],
    ['assets\\minecraft\\x.png'],
    ['assets//x.png'],
    ['x'.repeat(2000)],
    ['assets/minecraft/textures/block/stone.png', 'extra'],
  ],
  'resources.readTexture': [[], [42], [null], ['x'.repeat(600)]],
  'resources.soundLibrary': [[1], ['minecraft']],
  'sound.pick': [[], ['C:\\x.ogg'], ['effect', 'C:\\x.ogg']],
  'sound.list': [[1]],
  'sound.read': [[], ['../x'], ['C:\\x.ogg'], ['user-audio:123', 42]],
  'sound.fetchNames': [['https://example.com/file'], [42]],
  'resources.soundFiles': [[], [['minecraft:dig/stone1']], [['minecraft:dig/stone1'], 'yes'], [['../x'], false], [['C:\\x.ogg'], true], ['minecraft:dig/stone1', true], [Array.from({ length: 300 }, (_, i) => `minecraft:x${i}`), false]],
  'resources.soundVariants': [[], [42], [null], ['../x'], ['C:\\x'], ['no-namespace'], ['Minecraft:Block.Stone'], ['x'.repeat(300)]],
  'resources.list': [[42], ['../'], ['C:\\'], [null]],
  'resources.fontProviders': [[], [42], ['x'.repeat(600)]],
  'fonts.list': [[42], ['C:\\Windows']],
  'resources.detectMinecraft': [[1], ['C:\\Games']],
  'resources.setVanilla': [[], [null], [{ consent: 'yes' }], [{ dir: 'C:\\Games' }], [{ enabled: true }, 'x']],
  // 合法的 chooseGameDir、addPack 会弹对话框，这里只有畸形参数
  'resources.chooseGameDir': [[1], ['C:\\Games']],
  'resources.selectProfile': [[], ['C:\\Games']],
  'resources.officialVersions': [[1]],
  'resources.locateProfile': [[], ['C:\\Games', 'game'], ['local:' + '0'.repeat(32), 'C:\\Games']],
  'resources.instancePacks': [[], ['C:\\Games']],
  'resources.setInstancePack': [[], ['local:' + '0'.repeat(32), 'C:\\Games', true]],
  // 合法的 downloadVanilla 会联网，这里只有畸形参数
  'resources.downloadVanilla': [[1], [{ url: 'https://evil.example/x.jar' }]],
  'resources.cancelDownload': [[1]],
  'resources.addPack': [[], ['exe'], [{ path: 'C:\\x.zip' }], ['zip', 'C:\\x.zip']],
  // 不是 File 对象：preload 就拒绝了（页面自己构造的 File 没有路径，另外测）
  'resources.addDroppedPack': [[], [null], ['C:\\Windows\\win.ini'], [{ path: 'C:\\x.zip', name: 'x.zip' }]],
  'resources.removeLayer': [[], [42], ['x'.repeat(200)]],
  'resources.reorder': [['x'], [[1, 2]], [null], [Array.from({ length: 300 }, (_, i) => `p${i}`)]],
  'resources.setEnabled': [['vanilla'], ['vanilla', 'yes'], [42, true]],
  'templates.list': [[1], ['all']],
  'templates.read': [[], ['allay.builtin.block-wipe'], [42, '1.0.0'], ['../../x', '1.0.0'], ['Allay.Builtin', '1.0.0'], ['allay.builtin.block-wipe', '1.0.0', 'x']],
  'templates.readAsset': [
    [],
    [{ id: 'allay.builtin.block-wipe', version: '1.0.0' }],
    [{ id: 'allay.builtin.block-wipe' }, 'a.png'],
    [{ path: 'C:\\Windows\\win.ini' }, 'a.png'],
    [{ stagingId: 'not-a-uuid' }, 'a.png'],
    [{ id: 'allay.builtin.block-wipe', version: '1.0.0', stagingId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' }, 'a.png'],
    [{ id: 'allay.builtin.block-wipe', version: '1.0.0' }, 42],
    [{ id: 'allay.builtin.block-wipe', version: '1.0.0' }, 'x'.repeat(300)],
  ],
  // 合法的 install、exportPackage 会弹对话框，这里只有畸形参数
  'templates.install': [[1], ['C:\\x.allaytpl']],
  'templates.installDropped': [[], [null], ['C:\\x.allaytpl'], [{ path: 'C:\\x.allaytpl', name: 'x.allaytpl' }]],
  'templates.commitInstall': [
    [],
    ['not-a-uuid', { warnings: [] }],
    ['3f2504e0-4f89-41d3-9a0c-0305e82c3301'],
    ['3f2504e0-4f89-41d3-9a0c-0305e82c3301', { warnings: ['hacked'] }],
    ['3f2504e0-4f89-41d3-9a0c-0305e82c3301', { warnings: [], target: 'C:\\Windows' }],
  ],
  'templates.cancelInstall': [[], [42], ['../x']],
  'templates.remove': [[], ['allay.builtin.block-wipe'], ['C:\\Windows', '1.0.0']],
  'templates.exportPackage': [[], ['allay.builtin.block-wipe'], [{ path: 'C:\\x' }, '1.0.0']],
  'templates.saveDerived': [
    [],
    [null],
    [{ base: { id: 'allay.builtin.block-wipe', version: '1.0.0' } }],
    [{ base: { id: 'allay.builtin.block-wipe', version: '1.0.0' }, name: '', defaults: {}, hidden: [] }],
    [{ base: { id: 'allay.builtin.block-wipe', version: '1.0.0' }, name: 'x', defaults: {}, hidden: [], id: 'allay.builtin.evil' }],
    [{ base: { id: 'allay.builtin.block-wipe', version: '1.0.0' }, name: 'x', defaults: {}, hidden: [], files: { logo: 'C:\\Windows\\win.ini' } }],
  ],
  // 模板开发模式（MD-a）。合法的 openFolder 会打开资源管理器，这里只有畸形参数；路径一律不收
  'templates.copyBuiltin': [
    [],
    [null],
    ['allay.builtin.block-wipe', '1.0.0'],
    [{ id: 'allay.builtin.block-wipe' }],
    [{ id: '../x', version: '1.0.0' }],
    [{ id: 'allay.builtin.block-wipe', version: '1.0.0', name: '' }],
    [{ id: 'allay.builtin.block-wipe', version: '1.0.0', path: 'C:\\Windows' }],
    [{ id: 'allay.builtin.block-wipe', version: '1.0.0', newId: 'allay.builtin.evil' }],
    [{ id: 'allay.builtin.block-wipe', version: '1.0.0' }, 'extra'],
  ],
  'templates.writeDevFiles': [[], ['user.abc.x'], ['C:\\Windows', '1.0.0'], [{ path: 'C:\\x' }, '1.0.0'], ['user.abc.x', '1.0.0', 'C:\\x']],
  'templates.openFolder': [[], ['C:\\Windows'], ['C:\\Windows', '1.0.0'], ['..', '..'], ['user.abc.x', { path: 'C:\\x' }], ['user.abc.x', '1.0.0', 'template.js']],
  'presets.list': [[1]],
  'presets.save': [
    [],
    [null],
    [{ template: { id: 'Bad', version: '1.0.0' }, name: 'x', params: {} }],
    [{ template: { id: 'allay.builtin.block-wipe', version: '1.0.0' }, name: '', params: {} }],
    [{ template: { id: 'allay.builtin.block-wipe', version: '1.0.0' }, name: 'x', params: {}, path: 'C:\\x.allaypreset' }],
  ],
  'presets.remove': [[], ['../settings'], ['x']],
  // 合法的 importFile、exportFile 会弹对话框，这里只有畸形参数
  'presets.importFile': [[1], ['C:\\x.allaypreset']],
  'presets.exportFile': [[], ['../x'], [42]],
  // 合法的 open、save（句柄为 null）、saveAs 会弹对话框，这里只有畸形参数
  'project.open': [[1], ['C:\\x.allay'], [{ path: 'C:\\x.allay' }]],
  // 文件关联（M8）：只收主进程签发的令牌（UUID），不收路径
  'project.openRequested': [[], [null], ['C:\\x.allay'], [{ token: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' }], ['3f2504e0-4f89-41d3-9a0c-0305e82c3301', 'extra']],
  'templates.installRequested': [[], [null], ['C:\\x.allaytpl'], [{ path: 'C:\\x.allaytpl' }], ['3f2504e0-4f89-41d3-9a0c-0305e82c3301', 'extra']],
  'host.ready': [[1], ['C:\\x.allay']],
  'host.setMacMenuState': [[], [{ enabled: ['openProject'], textEditing: false, path: 'C:\\x.allay' }], [{ enabled: ['unknown'], textEditing: false }]],
  'project.openRecent': [[], ['C:\\x.allay'], [42], ['3f2504e0-4f89-41d3-9a0c-0305e82c3301', 'extra']],
  'project.save': [
    [],
    [null],
    ['C:\\x.allay', {}],
    // 格式合法但没签发过的句柄
    ['3f2504e0-4f89-41d3-9a0c-0305e82c3301', { name: 'x', template: { id: 'allay.builtin.block-wipe', version: '1.0.0' }, params: {}, output: { width: 1920, height: 1080, fps: 60 }, export: { preset: 'prores4444', quality: 'standard', shutterAngle: 180 }, preview: { background: 'checker' }, resourceHint: [] }],
    [null, { name: 'x', template: { id: 'allay.builtin.block-wipe', version: '1.0.0' }, params: {}, output: { width: 1920, height: 1080, fps: 61 }, export: { preset: 'prores4444', quality: 'standard', shutterAngle: 180 }, preview: { background: 'checker' }, resourceHint: [] }],
    [null, { name: 'x', template: { id: 'allay.builtin.block-wipe', version: '1.0.0' }, params: {}, output: { width: 1920, height: 1080, fps: 60 }, export: { preset: 'prores4444', quality: 'standard', shutterAngle: 180 }, preview: { background: 'checker' }, resourceHint: [], files: { logo: 'C:\\Windows\\win.ini' } }],
  ],
  'project.saveAs': [[], [null], [{ name: '' }], [{ name: 'x', path: 'C:\\x.allay' }]],
  'project.recents': [[1], ['x']],
  // 主进程到界面的命令通道（MD-b）：界面只能交回格式对的结果
  'host.commandResult': [
    [],
    [null],
    ['3f2504e0-4f89-41d3-9a0c-0305e82c3301'],
    [{ requestId: 'not-a-uuid', ok: true }],
    [{ requestId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', ok: 'yes' }],
    [{ requestId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', ok: false, error: 'exploded', message: 'x' }],
    [{ requestId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', ok: true, path: 'C:\\Windows' }],
    [{ requestId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', ok: true, output: 'x'.repeat(1_000_001) }],
    [{ requestId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', ok: true }, 'extra'],
  ],
  'cache.getThumb': [[], ['zz', 'k'], ['0123456789abcdef', '../x'], ['0123456789abcdef', 'a/b'], ['0123456789ABCDEF', 'k']],
  'cache.putThumb': [['0123456789abcdef', 'k'], ['0123456789abcdef', 'k', 'png'], ['0123456789abcdef', 'k', [137, 80, 78, 71]], ['../x', 'k', {}]],
  'cache.clear': [[1]],
  'cache.usage': [[1]],
};

test('T-ARC-6 每个 IPC 方法都拒绝畸形参数，未授权的路径读不到，主进程不崩溃', async () => {
  const dir = makeUserDataDir();
  const { app, page } = await launchApp(dir);
  try {
    // 列出 window.allay 暴露的所有方法（onXxx 订阅函数单独测）
    const methods = await page.evaluate(() => {
      const out: string[] = [];
      for (const [ns, obj] of Object.entries(window.allay as unknown as Record<string, Record<string, unknown>>)) {
        for (const [name, fn] of Object.entries(obj)) {
          if (typeof fn === 'function' && !/^on[A-Z]/.test(name)) out.push(`${ns}.${name}`);
        }
      }
      return out.sort();
    });
    expect(methods).toEqual(Object.keys(MALFORMED).sort());

    const before = await page.evaluate(() => window.allay.settings.get());

    for (const [method, cases] of Object.entries(MALFORMED)) {
      for (const args of cases) {
        const outcome = await page.evaluate(
          async ({ method, args }) => {
            const [ns, name] = method.split('.') as [string, string];
            const fn = (window.allay as unknown as Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>>)[ns]![name]!;
            try {
              await fn(...args);
              return 'resolved';
            } catch (e) {
              return `rejected: ${e instanceof Error ? e.message : String(e)}`;
            }
          },
          { method, args },
        );
        expect(outcome, `${method}(${JSON.stringify(args).slice(0, 80)})`).toMatch(/^rejected: .*(invalid arguments|unknown file reference|unknown export job|unknown project handle|expected a File)/);
      }
    }

    // 页面自己构造的 File 没有本机路径：主进程拿到空串，拒绝
    const fakeFile = await page.evaluate(async () => {
      try {
        await window.allay.resources.addDroppedPack(new File(['PK'], 'pack.zip', { type: 'application/zip' }));
        return 'resolved';
      } catch (e) {
        return `rejected: ${e instanceof Error ? e.message : String(e)}`;
      }
    });
    expect(fakeFile).toMatch(/^rejected: .*invalid arguments/);
    const fakeTemplate = await page.evaluate(async () => {
      try {
        await window.allay.templates.installDropped(new File(['PK'], 't.allaytpl'));
        return 'resolved';
      } catch (e) {
        return `rejected: ${e instanceof Error ? e.message : String(e)}`;
      }
    });
    expect(fakeTemplate).toMatch(/^rejected: .*invalid arguments/);

    // 订阅函数只接受函数
    const badSubscribe = await page.evaluate(() => {
      try {
        (window.allay.settings.onChanged as unknown as (x: unknown) => unknown)('not a function');
        return 'accepted';
      } catch {
        return 'rejected';
      }
    });
    expect(badSubscribe).toBe('rejected');

    // 主进程还活着，设置没有被畸形调用改动
    const info = await page.evaluate(() => window.allay.app.info());
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(await page.evaluate(() => window.allay.settings.get())).toEqual(before);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);

    const log = readMainLog(dir);
    expect(log).toContain('rejected malformed arguments');
    expect(log).toContain('unknown file reference');
    expect(log).not.toContain('handler failed');
  } finally {
    await app.close();
    removeUserDataDir(dir);
  }
});

test('T-AST-FONT：桌面只暴露资源字体目录，不提供独立字体上传或回退文件', async () => {
  const dir = makeUserDataDir();
  const { app, page } = await launchApp(dir);
  try {
    const result = await page.evaluate(async () => ({
      methods: Object.keys(window.allay.fonts),
      catalog: await window.allay.fonts.list(),
      fallback: 'fallbackFont' in window.allay.resources,
    }));
    expect(result).toEqual({ methods: ['list'], catalog: { resources: [] }, fallback: false });
  } finally {
    await app.close();
    removeUserDataDir(dir);
  }
});

test('T-ARC-6 来自主窗口以外的 IPC 调用被拒绝', async () => {
  const dir = makeUserDataDir();
  const { app } = await launchApp(dir);
  try {
    // 在主进程里模拟一个来自别的 webContents 的调用：直接调用已注册的处理函数
    const result = await app.evaluate(async ({ ipcMain }) => {
      type InvokeHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, InvokeHandler> })._invokeHandlers;
      const handler = handlers.get('app:info');
      if (!handler) return 'no handler';
      const fakeFrame = { url: 'https://evil.example/' };
      try {
        await handler({ sender: {}, senderFrame: fakeFrame });
        return 'resolved';
      } catch (e) {
        return `rejected: ${e instanceof Error ? e.message : String(e)}`;
      }
    });
    expect(result).toBe('rejected: untrusted sender');
    expect(readMainLog(dir)).toContain('rejected call from untrusted sender');
  } finally {
    await app.close();
    removeUserDataDir(dir);
  }
});
