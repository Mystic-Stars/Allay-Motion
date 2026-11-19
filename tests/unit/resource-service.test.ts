import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../apps/desktop/src/main/logger';
import { SOUND_EVENTS } from '../../packages/assets/src/index';
import { DownloadError, type CachedVanilla, type VanillaDownloader } from '../../apps/desktop/src/main/resources/download';
import { ResourceService } from '../../apps/desktop/src/main/resources/service';
import { SettingsStore } from '../../apps/desktop/src/main/settings-store';
import type { ResourceState } from '../../apps/desktop/src/shared/resources';
import { makeFakeMinecraft, packMcmeta, solidPng, tex, writeFiles, writeZip } from './helpers/resource-fixtures';

// 主进程资源栈服务（decisions.md M2b）：按设置组装资源栈、征求同意、资源包的增删开关排序、同层 .mcmeta、字体、下载结果。
// 全部用脚本生成的假数据（纯色色块），不碰网络，也不碰这台机器上真装的游戏。

let dir: string;
const log = createLogger(null, false);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'allay-rsvc-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeDownloader(impl: Partial<VanillaDownloader> = {}): VanillaDownloader {
  return {
    findCached: async () => null,
    downloadLatest: async () => {
      throw new DownloadError('offline in tests', 'network');
    },
    fetchObject: async () => {
      throw new Error('no network in tests');
    },
    fetchSoundObjects: async (_install, ids) => ({ fetched: 0, missing: [...ids] }),
    ...impl,
  } as VanillaDownloader;
}

async function makeService(opts: { game?: boolean; downloader?: VanillaDownloader } = {}) {
  const appData = join(dir, 'appdata');
  if (opts.game) makeFakeMinecraft(join(appData, '.minecraft'), [{ id: '1.21.1', type: 'release', releaseTime: '2024-08-08T00:00:00+00:00', jar: true, assetIndex: '17' }], '#00ff00');
  const userData = join(dir, 'userData');
  const settings = new SettingsStore(join(userData, 'settings.json'), log);
  await settings.load();
  const states: ResourceState[] = [];
  const svc = new ResourceService({
    userDataDir: userData,
    builtinDir: join(dir, 'no-builtin'),
    settings,
    log,
    gameEnv: { platform: 'win32', appData, home: appData },
    downloader: opts.downloader ?? fakeDownloader(),
    onChanged: (s) => states.push(s),
  });
  await svc.init();
  await svc.detectMinecraft();
  return { svc, settings, userData, states };
}

const STONE = 'minecraft:block/stone';

async function stoneColor(svc: ResourceService): Promise<string | null> {
  const t = await svc.readTexture(STONE);
  return t ? Buffer.from(t.png).toString('base64') : null;
}

describe('ResourceService', () => {
  it('没有游戏、没有资源包：只有空的内置层，hasAssets 为假（界面显示引导状态）', async () => {
    const { svc, states } = await makeService();
    const s = svc.state();
    expect(s.detecting).toBe(false);
    expect(s.hasAssets).toBe(false);
    expect(s.vanilla.active).toBeNull();
    expect(s.layers.map((l) => l.kind)).toEqual(['builtin']);
    expect(s.layers[0]!.empty).toBe(true);
    expect(s.vanilla).toMatchObject({ consent: null, local: null, cached: null, active: null });
    expect(s.stamp).toMatch(/^[0-9a-f]{16}$/);
    expect(states.length).toBeGreaterThan(0);
    expect(await svc.readTexture(STONE)).toBeNull();
    svc.close();
  });

  it('发现本机游戏但还没同意：不进资源栈；同意后进入，stamp 变化；关掉后退出', async () => {
    const { svc } = await makeService({ game: true });
    let s = svc.state();
    expect(s.vanilla.local?.versionId).toBe('1.21.1');
    expect(s.layers.map((l) => l.kind)).toEqual(['builtin']);
    const before = s.stamp;
    s = await svc.setVanilla({ consent: true });
    expect(s.layers.map((l) => l.kind)).toEqual(['builtin', 'vanilla']);
    expect(s.vanilla.active).toBe('local');
    expect(s.hasAssets).toBe(true);
    expect(s.stamp).not.toBe(before);
    expect(await stoneColor(svc)).toBe(Buffer.from(solidPng('#00ff00')).toString('base64'));
    s = await svc.setEnabled('vanilla', false);
    expect(s.hasAssets).toBe(false);
    expect(await svc.readTexture(STONE)).toBeNull();
    svc.close();
  });

  it('资源包：添加（zip、文件夹）、叠加顺序、开关、重排、删除；.mcmeta 跟着胜出的那一层', async () => {
    const { svc, userData } = await makeService({ game: true });
    await svc.setVanilla({ consent: true });
    const zip = join(dir, 'Red Pack.zip');
    writeZip(zip, [
      { name: 'pack.mcmeta', data: packMcmeta('red') },
      { name: tex('stone'), data: solidPng('#ff0000', 32) },
      { name: `${tex('stone')}.mcmeta`, data: JSON.stringify({ animation: { frametime: 2 } }) },
    ]);
    const folder = join(dir, 'Blue Folder');
    writeFiles(folder, { 'pack.mcmeta': packMcmeta('blue'), [tex('stone')]: solidPng('#0000ff') });

    const red = await svc.addPackFromPath(zip);
    expect(red).toMatchObject({ ok: true });
    let t = await svc.readTexture(STONE);
    expect(t?.mcmeta).toContain('frametime');
    const blue = await svc.addPackFromPath(folder);
    expect(blue).toMatchObject({ ok: true });
    // 文件夹在最上面：蓝色，而且它没有 .mcmeta，不能拿到红色包的
    t = await svc.readTexture(STONE);
    expect(Buffer.from(t!.png).equals(Buffer.from(solidPng('#0000ff')))).toBe(true);
    expect(t!.mcmeta).toBeNull();

    const ids = svc.state().layers.filter((l) => l.kind === 'pack').map((l) => l.id);
    expect(svc.state().layers.map((l) => l.name)).toEqual(['builtin', '1.21.1', 'Red Pack', 'Blue Folder']);
    // 重排：红色到最上面
    let s = await svc.reorder([ids[1]!, ids[0]!]);
    expect(s.layers.map((l) => l.name)).toEqual(['builtin', '1.21.1', 'Blue Folder', 'Red Pack']);
    expect((await svc.readTexture(STONE))!.mcmeta).toContain('frametime');
    // 关掉红色：回到蓝色
    s = await svc.setEnabled(ids[0]!, false);
    expect(s.layers.find((l) => l.id === ids[0])?.enabled).toBe(false);
    expect(Buffer.from((await svc.readTexture(STONE))!.png).equals(Buffer.from(solidPng('#0000ff')))).toBe(true);
    // 删除红色：应用数据目录里的 zip 副本一起删
    expect(readdirSync(join(userData, 'packs')).filter((f) => f.endsWith('.zip'))).toHaveLength(1);
    s = await svc.removeLayer(ids[0]!);
    expect(s.layers.some((l) => l.id === ids[0])).toBe(false);
    expect(readdirSync(join(userData, 'packs')).filter((f) => f.endsWith('.zip'))).toHaveLength(0);
    svc.close();
  });

  it('恶意 zip 被拒绝：应用数据目录里不多出任何 zip，资源栈不变', async () => {
    const { svc, userData } = await makeService();
    const before = svc.state().stamp;
    const evil = join(dir, 'evil.zip');
    writeZip(evil, [{ name: '../escape.txt', data: 'x' }, { name: tex('stone'), data: solidPng('#ff00ff') }]);
    expect(await svc.addPackFromPath(evil)).toMatchObject({ ok: false, error: 'rejected' });
    expect(existsSync(join(dir, 'escape.txt'))).toBe(false);
    const packs = join(userData, 'packs');
    expect(existsSync(packs) ? readdirSync(packs) : []).toEqual([]);
    expect(svc.state().stamp).toBe(before);
    expect(await svc.addPackFromPath(join(dir, 'nope.txt'))).toMatchObject({ ok: false });
    svc.close();
  });

  it('设置里登记的资源包丢了：列为打不开的包，不影响其他层', async () => {
    const { svc, settings } = await makeService();
    const folder = join(dir, 'gone');
    writeFiles(folder, { [tex('stone')]: solidPng('#0000ff') });
    await svc.addPackFromPath(folder);
    svc.close();
    rmSync(folder, { recursive: true, force: true });
    const again = new ResourceService({
      userDataDir: join(dir, 'userData'),
      builtinDir: join(dir, 'no-builtin'),
      settings,
      log,
      gameEnv: { platform: 'win32', appData: join(dir, 'appdata'), home: dir },
      downloader: fakeDownloader(),
      onChanged: () => undefined,
    });
    await again.init();
    const s = again.state();
    expect(s.brokenPacks).toEqual([expect.objectContaining({ name: 'gone', problem: 'missing' })]);
    expect(s.layers.map((l) => l.kind)).toEqual(['builtin']);
    expect(await again.fontProviders('minecraft:default')).toBeNull();
    again.close();
  });

  it('T-AST-FONT：只列出启用包的字体；旧引用走游戏默认，保留包内 TTF provider', async () => {
    const { svc } = await makeService();
    const folder = join(dir, 'font-pack');
    writeFiles(folder, {
      'assets/minecraft/font/default.json': JSON.stringify({ providers: [{ type: 'reference', id: 'minecraft:include/space' }, { type: 'bitmap', file: 'minecraft:font/ascii.png', ascent: 7, chars: ['AB'] }, { type: 'unihex', hex_file: 'x' }] }),
      'assets/minecraft/font/include/space.json': JSON.stringify({ providers: [{ type: 'space', advances: { ' ': 4 } }] }),
      'assets/minecraft/textures/font/ascii.png': solidPng('#abcdef'),
      'assets/example/font/hud.json': JSON.stringify({ providers: [{ type: 'ttf', file: 'example:hud.ttf' }] }),
      'assets/example/font/hud.ttf': new Uint8Array(12),
      'assets/allay/font/fallback.json': JSON.stringify({ providers: [{ type: 'space', advances: { ' ': 9 } }] }),
    });
    await svc.addPackFromPath(folder);
    const f = await svc.fontProviders('minecraft:default');
    expect(f?.providers).toEqual([
      { type: 'space', advances: [[32, 4]] },
      { type: 'bitmap', file: 'assets/minecraft/textures/font/ascii.png', ascent: 7, height: 8, rows: [[65, 66]] },
    ]);
    expect(f?.skipped).toContain('unihex(invalid)');
    expect(await svc.fontIds()).toEqual(['example:hud', 'minecraft:default', 'minecraft:include/space']);
    expect((await svc.fontProviders('example:hud'))?.providers[0]).toMatchObject({ type: 'ttf', file: 'assets/example/font/hud.ttf' });
    for (const legacy of ['allay:fallback', `user-font:${'a'.repeat(64)}`]) expect(await svc.fontProviders(legacy)).toEqual(f);
    expect(await svc.fontProviders('minecraft:nope')).toBeNull();
    await svc.removeLayer(svc.state().layers.find((layer) => layer.kind === 'pack')!.id);
    expect(await svc.fontIds()).toEqual([]);
    expect(await svc.fontProviders('example:hud')).toBeNull();
    svc.close();
  });

  it('下载：成功后同意并用下载的原版层；失败给出错误类型；进行中再点返回 busy；取消', async () => {
    const appData = join(dir, 'cache-game');
    makeFakeMinecraft(appData, [{ id: '26.3', type: 'release', releaseTime: '2026-09-15T00:00:00+00:00', jar: true }], '#ffff00');
    const cached: CachedVanilla = {
      source: 'downloaded',
      gameDir: appData,
      versionId: '26.3',
      releaseTime: '2026-09-15T00:00:00+00:00',
      jarPath: join(appData, 'versions', '26.3', '26.3.jar'),
      assetIndexPath: null,
      objectsDir: join(appData, 'objects'),
    };
    let release: () => void = () => undefined;
    let mode: 'ok' | 'fail' | 'hang' = 'fail';
    let have = false;
    const soundFetches: { version: string; ids: string[] }[] = [];
    const downloader = fakeDownloader({
      findCached: async () => (have ? cached : null),
      downloadLatest: async ({ signal, onProgress } = {}) => {
        onProgress?.({ phase: 'jar', received: 10, total: 100 });
        if (mode === 'fail') throw new DownloadError('bad sha1', 'hash');
        if (mode === 'hang')
          await new Promise<void>((resolve, reject) => {
            release = resolve;
            signal?.addEventListener('abort', () => reject(new DownloadError('aborted', 'aborted')));
          });
        have = true;
        return cached;
      },
      // M6b：音效对象在同一次下载里紧接着取回，事件表就是选择器里的那些
      fetchSoundObjects: async (install, ids) => {
        soundFetches.push({ version: install.versionId, ids: [...ids] });
        return { fetched: 0, missing: [] };
      },
    });
    const { svc } = await makeService({ downloader });
    expect(await svc.downloadVanilla()).toEqual({ ok: false, error: 'verify' });
    // 失败时记下停在哪一步（docs/decisions.md 界面增强）
    expect(svc.state().download).toMatchObject({ status: 'failed', error: 'verify', progress: { stage: 'jar' } });
    expect(svc.state().download).toMatchObject({ progress: { stages: [{ status: 'done' }, { status: 'failed' }, { status: 'pending' }, { status: 'pending' }, { status: 'pending' }] } });

    mode = 'hang';
    const p = svc.downloadVanilla();
    expect(svc.state().download.status).toBe('running');
    expect(await svc.downloadVanilla()).toEqual({ ok: false, error: 'busy' });
    svc.cancelDownload();
    expect(await p).toEqual({ canceled: true });
    expect(svc.state().download).toMatchObject({ status: 'canceled', progress: { stage: 'jar' } });
    release();

    mode = 'ok';
    expect(await svc.downloadVanilla()).toEqual({ ok: true });
    const s = svc.state();
    expect(s.download).toMatchObject({ status: 'done', progress: { fraction: 1, activity: 'done' } });
    expect(s.vanilla).toMatchObject({ consent: true, active: 'cached', cached: { versionId: '26.3' } });
    expect(soundFetches).toEqual([{ version: '26.3', ids: [...SOUND_EVENTS] }]);
    expect(s.layers.find((l) => l.kind === 'vanilla')?.source).toBe('downloaded');
    expect(Buffer.from((await svc.readTexture(STONE))!.png).equals(Buffer.from(solidPng('#ffff00')))).toBe(true);
    svc.close();
  });

  it('M6b 音效事件的变体：各层 sounds.json 按游戏的规则合并（上层追加，replace 替换），资源栈变了重新合并', async () => {
    const { svc } = await makeService();
    expect(await svc.soundVariants('minecraft:block.stone.place')).toBeNull();
    const a = join(dir, 'pack-a');
    const b = join(dir, 'pack-b');
    writeFiles(a, { 'pack.mcmeta': packMcmeta('a'), 'assets/minecraft/sounds.json': JSON.stringify({ 'block.stone.place': { sounds: ['test/a1', { name: 'test/a2', volume: 0.5, pitch: 2, weight: 3 }] } }) });
    writeFiles(b, {
      'pack.mcmeta': packMcmeta('b'),
      'assets/minecraft/sounds.json': JSON.stringify({ 'block.stone.place': { sounds: ['test/b1'] }, 'ui.toast.in': { replace: true, sounds: ['test/toast'] } }),
    });
    expect(await svc.addPackFromPath(a)).toMatchObject({ ok: true });
    expect(await svc.soundVariants('minecraft:block.stone.place')).toEqual([
      { file: 'minecraft:test/a1', volume: 1, pitch: 1, weight: 1, kind: 'effect' },
      { file: 'minecraft:test/a2', volume: 0.5, pitch: 2, weight: 3, kind: 'effect' },
    ]);
    expect(await svc.addPackFromPath(b)).toMatchObject({ ok: true });
    // b 在上层：追加
    expect((await svc.soundVariants('minecraft:block.stone.place'))?.map((v) => v.file)).toEqual(['minecraft:test/a1', 'minecraft:test/a2', 'minecraft:test/b1']);
    expect((await svc.soundVariants('minecraft:ui.toast.in'))?.map((v) => v.file)).toEqual(['minecraft:test/toast']);
    expect(await svc.soundVariants('allay:whoosh')).toBeNull();
    svc.close();
  });

  it('M6b 音效库：资源栈合并后 sounds.json 的全部事件（各命名空间），文件在不在决定状态；资源栈变了库跟着变', async () => {
    const { svc } = await makeService();
    expect((await svc.soundLibrary()).events).toEqual([]);
    const pack = join(dir, 'pack-sounds');
    writeFiles(pack, {
      'pack.mcmeta': packMcmeta('s'),
      'assets/minecraft/sounds.json': JSON.stringify({ 'block.stone.place': { sounds: ['test/a'] }, 'ambient.cave': { sounds: ['test/nofile'] } }),
      'assets/minecraft/sounds/test/a.ogg': 'OggS-a',
      'assets/mypack/sounds.json': JSON.stringify({ 'fx.boom': { sounds: ['boom'] } }),
      'assets/mypack/sounds/boom.wav': 'RIFF-boom',
    });
    expect(await svc.addPackFromPath(pack)).toMatchObject({ ok: true });
    const lib = await svc.soundLibrary();
    expect(lib.stamp).toBe(svc.resourceStamp);
    expect(lib.events).toMatchObject([
      { id: 'minecraft:ambient.cave', state: 'missing' },
      { id: 'minecraft:block.stone.place', state: 'local' },
      { id: 'mypack:fx.boom', state: 'local' },
    ]);
    const id = svc.state().layers.find((l) => l.kind === 'pack')!.id;
    await svc.setEnabled(id, false);
    expect((await svc.soundLibrary()).events).toEqual([]);
    svc.close();
  });

  it('M6b 下载缓存的原版层：还没取回的音效是 remote，只有 soundFiles(…, true) 才经 fetchObject 取回；取不到时报错误类型、状态不变', async () => {
    const appData = join(dir, 'appdata');
    const objectsDir = join(dir, 'cache-objects');
    // 模拟“下载原版资源”时已经取回了 sounds.json，但没取 dig/stone1
    const soundsJson = JSON.stringify({ 'block.stone.place': { sounds: ['dig/stone1'] } });
    writeFiles(objectsDir, { [`aa/${'a'.repeat(40)}`]: soundsJson });
    const cached: CachedVanilla = {
      source: 'downloaded',
      gameDir: join(dir, 'cache'),
      versionId: '26.3',
      releaseTime: '2026-09-15T00:00:00+00:00',
      jarPath: join(appData, '.minecraft', 'versions', '1.21.1', '1.21.1.jar'),
      assetIndexPath: join(appData, '.minecraft', 'assets', 'indexes', '17.json'),
      objectsDir,
    };
    let online = false;
    const fetched: string[] = [];
    const downloader = fakeDownloader({
      findCached: async () => cached,
      fetchObject: async (hash, size) => {
        if (!online) throw new DownloadError('offline', 'network');
        fetched.push(hash);
        const file = join(objectsDir, hash.slice(0, 2), hash);
        writeFiles(objectsDir, { [`${hash.slice(0, 2)}/${hash}`]: 'x'.repeat(size) });
        return file;
      },
    });
    const { svc } = await makeService({ game: true, downloader });
    await svc.setVanilla({ consent: true });
    expect(svc.state().vanilla.active).toBe('cached');
    expect((await svc.soundLibrary()).events).toMatchObject([{ id: 'minecraft:block.stone.place', state: 'remote', source: 'vanilla' }]);
    expect(await svc.soundFiles(['minecraft:dig/stone1', 'minecraft:nope'], false)).toEqual({ ok: true, states: { 'minecraft:dig/stone1': 'remote', 'minecraft:nope': 'missing' } });
    expect(fetched).toEqual([]);
    // 离线：取不到，报 network，状态仍是 remote，不报错
    expect(await svc.soundFiles(['minecraft:dig/stone1'], true)).toEqual({ ok: false, error: 'network', states: { 'minecraft:dig/stone1': 'remote' } });
    online = true;
    expect(await svc.soundFiles(['minecraft:dig/stone1'], true)).toEqual({ ok: true, states: { 'minecraft:dig/stone1': 'local' } });
    expect(fetched).toEqual(['b'.repeat(40)]);
    expect((await svc.soundLibrary()).events).toMatchObject([{ id: 'minecraft:block.stone.place', state: 'local', source: 'vanilla' }]);
    svc.close();
  });

  it('M6b 本机游戏的原版层：对象在本地就是 local；不在本地的对象标成 missing（不从本机游戏的层按需联网）', async () => {
    const { svc } = await makeService({ game: true });
    await svc.setVanilla({ consent: true });
    expect(svc.state().vanilla.active).toBe('local');
    expect((await svc.soundLibrary()).events).toMatchObject([{ id: 'minecraft:block.stone.place', state: 'local', source: 'vanilla' }]);
    rmSync(join(dir, 'appdata', '.minecraft', 'assets', 'objects', 'bb'), { recursive: true });
    expect(await svc.soundFiles(['minecraft:dig/stone1'], true)).toEqual({ ok: true, states: { 'minecraft:dig/stone1': 'missing' } });
    svc.close();
  });

  it('原版 jar 不见了：静默退回，并在资源面板里提示', async () => {
    const { svc } = await makeService({ game: true });
    await svc.setVanilla({ consent: true });
    svc.close();
    rmSync(join(dir, 'appdata', '.minecraft', 'versions', '1.21.1', '1.21.1.jar'));
    const s = await svc.detectMinecraft();
    expect(s.vanilla.local).toBeNull();
    expect(s.vanilla.problem).toBe('missing');
    expect(s.layers.map((l) => l.kind)).toEqual(['builtin']);
  });
});
