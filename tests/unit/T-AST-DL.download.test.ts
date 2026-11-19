import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../apps/desktop/src/main/logger';
import { ResourceService } from '../../apps/desktop/src/main/resources/service';
import { SettingsStore } from '../../apps/desktop/src/main/settings-store';
import {
  checkMojangUrl,
  chooseVanillaSource,
  createVanillaDownloader,
  DownloadError,
  MOJANG_HOSTS,
  openVanillaLayer,
  type CachedVanilla,
  type VanillaInstall,
} from '../../apps/desktop/src/main/resources';
import type { DownloadProgressView } from '../../apps/desktop/src/shared/resources';
import { buildZip, makeFakeMinecraft, packMcmeta, solidPng, tex, writeFiles } from './helpers/resource-fixtures';

// T-AST-DL：运行时从 Mojang 下载客户端 jar。全部对着本机的假 HTTP 服务器测，不访问真实网络。
// 假清单、假 jar（纯色测试色块）、假资源索引都由脚本生成。

type Route = Buffer | { status: number; headers?: Record<string, string>; body?: Buffer } | { slow: Buffer[]; delayMs: number };

let dir: string;
let server: Server;
let origin: string;
let routes: Map<string, Route>;
let log: string[];

const sha1 = (b: Buffer) => createHash('sha1').update(b).digest('hex');

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'allay-t-ast-dl-'));
  routes = new Map();
  log = [];
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    log.push(path);
    // 不允许任何自定义标识：只应有 Host 和 Connection 这类 Node 默认头
    expect(req.headers['user-agent']).toBeUndefined();
    const r = routes.get(path);
    if (!r) {
      res.writeHead(404).end();
      return;
    }
    if (Buffer.isBuffer(r)) {
      res.writeHead(200, { 'content-length': String(r.length) }).end(r);
      return;
    }
    if ('slow' in r) {
      res.writeHead(200);
      let i = 0;
      const tick = () => {
        if (res.destroyed) return;
        const chunk = r.slow[i++];
        if (!chunk) {
          res.end();
          return;
        }
        res.write(chunk);
        setTimeout(tick, r.delayMs);
      };
      tick();
      return;
    }
    res.writeHead(r.status, r.headers).end(r.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  origin = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

const testOrigins = () => Object.fromEntries(MOJANG_HOSTS.map((h) => [h, origin]));

interface Fake {
  jar: Buffer;
  index: Buffer;
  sound: Buffer;
  version: Record<string, unknown>;
}

/** 搭一套假的清单 → 版本 JSON → jar → 资源索引 → 资源对象 */
function serveFakeRelease(patch: (f: Fake) => void = () => undefined): Fake {
  const jar = Buffer.from(buildZip([{ name: tex('stone'), data: solidPng('#00ff00') }, { name: 'net/fake/Main.class', data: 'x' }]));
  const sound = Buffer.from('OggS-fake');
  const index = Buffer.from(JSON.stringify({ objects: { 'minecraft/sounds/dig/stone1.ogg': { hash: sha1(sound), size: sound.length } } }));
  const f: Fake = {
    jar,
    index,
    sound,
    version: {
      id: 'fx-9',
      type: 'release',
      releaseTime: '2030-01-01T00:00:00+00:00',
      downloads: { client: { url: 'https://piston-data.mojang.com/v1/objects/aaa/client.jar', sha1: sha1(jar), size: jar.length } },
      assetIndex: { id: 'fx', url: 'https://piston-meta.mojang.com/v1/packages/bbb/fx.json', sha1: sha1(index), size: index.length },
    },
  };
  patch(f);
  const versionBytes = Buffer.from(JSON.stringify(f.version));
  routes.set(
    '/mc/game/version_manifest_v2.json',
    Buffer.from(
      JSON.stringify({
        latest: { release: 'fx-9', snapshot: 'fx-10-snap' },
        versions: [
          { id: 'fx-10-snap', type: 'snapshot', url: 'https://piston-meta.mojang.com/v1/packages/ccc/snap.json' },
          { id: 'fx-9', type: 'release', url: 'https://piston-meta.mojang.com/v1/packages/ddd/fx-9.json', sha1: sha1(versionBytes) },
        ],
      }),
    ),
  );
  routes.set('/v1/packages/ddd/fx-9.json', versionBytes);
  routes.set('/v1/objects/aaa/client.jar', f.jar);
  routes.set('/v1/packages/bbb/fx.json', f.index);
  routes.set(`/${sha1(sound).slice(0, 2)}/${sha1(sound)}`, sound);
  return f;
}

function files(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(root, p).replace(/\\/g, '/'));
    }
  };
  walk(root);
  return out.sort();
}

const cacheDir = () => join(dir, 'userData', 'vanilla-cache');
const panoramaId = (face: number) => `minecraft:gui/title/background/panorama_${face}`;
const panoramaKey = (face: number) => `minecraft/textures/gui/title/background/panorama_${face}.png`;
const objectPath = (bytes: Buffer) => `/${sha1(bytes).slice(0, 2)}/${sha1(bytes)}`;

function servePanorama(failFace?: 'hash' | 'slow' | 'malformed') {
  const placeholder = solidPng('#101010', 1, 1);
  const faces = ['#ff0000', '#00ff00', '#0000ff', '#ffa000', '#a000ff', '#00ffff'].map((color) => Buffer.from(solidPng(color, 64, 64)));
  const unrelated = Buffer.from('not a panorama');
  const indexed = (bytes: Buffer) => ({ hash: sha1(bytes), size: bytes.length });
  const fixture = serveFakeRelease((release) => {
    release.jar = Buffer.from(buildZip(faces.map((_, face) => ({ name: `assets/${panoramaKey(face)}`, data: placeholder }))));
    release.index = Buffer.from(JSON.stringify({ objects: {
      ...Object.fromEntries(faces.map((bytes, face) => [panoramaKey(face), face === 1 && failFace === 'malformed' ? { hash: '../bad', size: bytes.length } : indexed(bytes)])),
      [panoramaKey(6)]: indexed(unrelated),
      'minecraft/textures/gui/title/background/panorama_overlay.png': indexed(unrelated),
    } }));
    Object.assign((release.version.downloads as { client: object }).client, { sha1: sha1(release.jar), size: release.jar.length });
    Object.assign(release.version.assetIndex as object, { sha1: sha1(release.index), size: release.index.length });
  });
  for (const [face, bytes] of faces.entries()) {
    const route = face === 1 && failFace === 'hash' ? Buffer.alloc(bytes.length)
      : face === 1 && failFace === 'slow' ? { slow: [bytes.subarray(0, 8), bytes.subarray(8)], delayMs: 1_000 } : bytes;
    routes.set(objectPath(bytes), route);
  }
  routes.set(objectPath(unrelated), unrelated);
  return { fixture, faces, placeholder };
}

async function openService(onProgress: (progress: DownloadProgressView) => void = () => undefined) {
  const userDataDir = join(dir, 'userData');
  const logger = createLogger(null, false);
  const settings = new SettingsStore(join(userDataDir, 'settings.json'), logger);
  await settings.load();
  const service = new ResourceService({
    userDataDir, settings, log: logger, builtinDir: join(dir, 'empty'),
    downloader: createVanillaDownloader({ cacheDir: cacheDir(), packaged: false, testOrigins: testOrigins() }),
    gameEnv: { platform: 'win32', appData: dir, home: dir }, onChanged: (state) => {
      if (state.download.status !== 'idle') onProgress(state.download.progress);
    },
  });
  await service.init();
  await service.detectMinecraft();
  return service;
}

describe('T-AST-DL 全景缓存', () => {
  it('旧缓存离线仍读 JAR；确认重下指定版补齐六面，最新入口复用全部已校验对象', async () => {
    const { fixture, faces, placeholder } = servePanorama();
    writeFiles(cacheDir(), { 'versions/fx-9/client.jar': fixture.jar, 'versions/fx-9/version.json': JSON.stringify(fixture.version), 'indexes/fx.json': fixture.index });
    makeFakeMinecraft(join(dir, '.minecraft'), [{ id: 'local', releaseTime: '2020-01-01', type: 'release', jar: true }]);
    const progress: DownloadProgressView[] = [];
    const service = await openService((entry) => progress.push(entry));
    try {
      const library = service.state().library!;
      await service.selectProfile(library.profiles.find((profile) => profile.source === 'local')!.id);
      const downloaded = library.profiles.find((profile) => profile.source === 'downloaded')!;
      await service.selectProfile(downloaded.id);
      expect((await service.readTexture(panoramaId(0)))?.png).toEqual(placeholder);
      expect((await service.readTexture(panoramaId(0), downloaded.id))?.png).toEqual(placeholder);
      const stamp = service.state().stamp;
      const profileStamp = service.state().library!.profiles.find(({ id }) => id === downloaded.id)?.stamp;
      expect(log).toEqual([]);
      expect(await service.downloadVanilla('fx-9')).toEqual({ ok: true });
      expect(log.filter((path) => /^\/[\da-f]{2}\//.test(path))).toEqual(faces.map(objectPath));
      expect(log).not.toContain('/v1/objects/aaa/client.jar');
      expect(log).not.toContain('/v1/packages/bbb/fx.json');
      expect(service.state().stamp).not.toBe(stamp);
      expect(service.state().library!.profiles.find(({ id }) => id === downloaded.id)?.stamp).not.toBe(profileStamp);
      expect(progress).toContainEqual(expect.objectContaining({ stage: 'extract', activity: 'panorama' }));
      const total = fixture.index.length + faces.reduce((sum, bytes) => sum + bytes.length, 0);
      expect(service.state().download).toMatchObject({ status: 'done', progress: { stages: expect.arrayContaining([{ id: 'extract', status: 'done', received: total, total }]) } });
      for (const [face, bytes] of faces.entries()) expect((await service.readTexture(panoramaId(face), downloaded.id))?.png).toEqual(new Uint8Array(bytes));
      log.length = 0;
      expect(await service.downloadVanilla()).toEqual({ ok: true });
      expect(log).toEqual(['/mc/game/version_manifest_v2.json', '/v1/packages/ddd/fx-9.json']);
    } finally { service.close(); }
  });

  it.each(['hash', 'malformed'] as const)('全景 %s 错误停在提取阶段，重试复用已经校验的对象', async (failure) => {
    const { faces } = servePanorama(failure);
    const service = await openService();
    try {
      expect(await service.downloadVanilla('fx-9')).toEqual({ ok: false, error: 'verify' });
      expect(service.state().download).toMatchObject({ status: 'failed', progress: { stage: 'extract', activity: 'panorama' }, requestedVersion: 'fx-9' });
      expect(files(cacheDir()).some((path) => path.endsWith('.part') || path.endsWith('version.json'))).toBe(false);
      if (failure === 'malformed') expect(log).not.toContain(objectPath(faces[0]!));
      if (failure === 'hash') {
        routes.set(objectPath(faces[1]!), faces[1]!);
        log.length = 0;
        expect(await service.downloadVanilla()).toEqual({ ok: true });
        expect(log.filter((path) => /^\/[\da-f]{2}\//.test(path))).toEqual(faces.slice(1).map(objectPath));
      }
    } finally { service.close(); }
  });

  it('取消进行中的全景请求，保留已校验对象并清除半成品', async () => {
    const { faces } = servePanorama('slow');
    const service = await openService();
    try {
      const download = service.downloadVanilla('fx-9');
      await expect.poll(() => log.includes(objectPath(faces[1]!))).toBe(true);
      service.cancelDownload();
      expect(await download).toEqual({ canceled: true });
      expect(service.state().download).toMatchObject({ status: 'canceled', progress: { stage: 'extract', activity: 'panorama' } });
      expect(files(cacheDir())).toContain(`objects${objectPath(faces[0]!)}`);
      expect(files(cacheDir()).some((path) => path.endsWith('.part') || path.endsWith('version.json'))).toBe(false);
      expect(log).not.toContain(objectPath(faces[2]!));
    } finally { service.close(); }
  });

  it('旧版本没有索引全景时不发对象请求，保留 JAR 自带贴图', async () => {
    const png = solidPng('#aabbcc', 64, 64);
    serveFakeRelease((release) => {
      release.jar = Buffer.from(buildZip([{ name: `assets/${panoramaKey(0)}`, data: png }]));
      Object.assign((release.version.downloads as { client: object }).client, { sha1: sha1(release.jar), size: release.jar.length });
    });
    const service = await openService();
    try {
      expect(await service.downloadVanilla()).toEqual({ ok: true });
      expect(log.filter((path) => /^\/[\da-f]{2}\//.test(path))).toEqual([]);
      expect((await service.readTexture(panoramaId(0)))?.png).toEqual(png);
    } finally { service.close(); }
  });
});

describe('T-AST-DL 同版索引里的 Unihex 字体', () => {
  const main = 'minecraft/font/include/unifont.json';
  const pua = 'minecraft/font/include/unifont_pua.json';
  const normal = 'minecraft/font/unifont.zip';
  const japanese = 'minecraft/font/unifont_jp.zip';
  const privateUse = 'minecraft/font/unifont_pua.zip';
  const defaultFont = 'minecraft:default';
  const glyph = (cp: string, row: string) => Buffer.from(buildZip([{ name: 'synthetic.hex', data: `${cp}:${row.repeat(16)}` }]));
  const font = (archive: string) => ({ type: 'unihex', hex_file: `minecraft:font/${archive}.zip` });
  const jarPlaceholder = JSON.stringify({ providers: [] });
  const describeObject = (bytes: Buffer) => ({ hash: sha1(bytes), size: bytes.length });
  const json = (providers: unknown[]) => Buffer.from(JSON.stringify({ providers }));

  function serveFonts(variant: 'modern' | 'oversize' | 'bad-hash' = 'modern') {
    const objects = {
      [main]: json([font('unifont'), font('unifont_jp'), { type: 'reference', id: 'minecraft:include/unifont_pua' }]),
      [pua]: json([font('unifont_pua')]),
      [normal]: glyph('4E2D', '44'),
      [japanese]: glyph('3042', '24'),
      [privateUse]: glyph('E001', '60'),
    };
    const unrelated = Buffer.from('不在允许列表内');
    const fixture = serveFakeRelease((release) => {
      release.jar = Buffer.from(buildZip([
        { name: 'assets/minecraft/font/default.json', data: json([{ type: 'reference', id: 'minecraft:include/unifont' }]) },
        { name: `assets/${main}`, data: jarPlaceholder },
      ]));
      release.index = Buffer.from(JSON.stringify({ objects: {
        ...Object.fromEntries(Object.entries(objects).map(([key, bytes]) => [key, describeObject(bytes)])),
        ...(variant === 'oversize' ? { [normal]: { hash: sha1(objects[normal]!), size: 8 * 1024 * 1024 + 1 } } : {}),
        'minecraft/font/unifont_extra.zip': describeObject(unrelated),
        'minecraft/font/include/other.json': describeObject(unrelated),
        'minecraft/font/../danger.zip': describeObject(unrelated),
      } }));
      Object.assign((release.version.downloads as { client: object }).client, { size: release.jar.length, sha1: sha1(release.jar) });
      Object.assign(release.version.assetIndex as object, { size: release.index.length, sha1: sha1(release.index) });
    });
    for (const bytes of Object.values(objects)) routes.set(objectPath(bytes), bytes);
    if (variant === 'bad-hash') routes.set(objectPath(objects[normal]!), Buffer.alloc(objects[normal]!.length));
    routes.set(objectPath(unrelated), unrelated);
    return { fixture, objects, unrelated };
  }

  it('同名空 JAR 定义优先补成同版索引定义；本机和资源包仍可覆盖，缺损时不联网', async () => {
    const { fixture, objects, unrelated } = serveFonts();
    writeFiles(cacheDir(), { 'versions/fx-9/client.jar': fixture.jar, 'versions/fx-9/version.json': JSON.stringify(fixture.version), 'indexes/fx.json': fixture.index });
    const localGlyph = glyph('4E2D', '28');
    const localDef = json([font('unifont')]);
    const localIndex = Buffer.from(JSON.stringify({ objects: { [main]: describeObject(localDef), [normal]: describeObject(localGlyph) } }));
    const game = join(dir, '.minecraft');
    writeFiles(game, {
      'versions/fx-9/fx-9.jar': fixture.jar,
      'versions/fx-9/fx-9.json': JSON.stringify({ ...fixture.version, assetIndex: { id: 'fx', sha1: sha1(localIndex), size: localIndex.length } }),
      'assets/indexes/fx.json': localIndex,
      [`assets/objects${objectPath(localDef)}`]: localDef,
      [`assets/objects${objectPath(localGlyph)}`]: localGlyph,
    });

    const progress: DownloadProgressView[] = [];
    const service = await openService((entry) => progress.push(entry));
    const glyphs = async (profile?: string) => (await service.fontProviders(defaultFont, profile))?.providers.flatMap((provider) =>
      provider.type === 'unihex' ? [...provider.tables.codepoints] : []);
    try {
      const profiles = service.state().library!.profiles;
      const local = profiles.find(({ source }) => source === 'local')!;
      const cached = profiles.find(({ source }) => source === 'downloaded')!;
      await service.selectProfile(local.id);
      expect(await glyphs()).toEqual([0x4e2d]);
      await service.selectProfile(cached.id);
      expect(await glyphs()).toEqual([]);
      expect(log).toEqual([]);

      const before = service.state().stamp;
      expect(await service.downloadVanilla('fx-9')).toEqual({ ok: true });
      expect(log.filter((path) => /^\/[\da-f]{2}\//.test(path)).sort()).toEqual(Object.values(objects).map(objectPath).sort());
      expect(log).not.toContain(objectPath(unrelated));
      expect(log).not.toContain('/v1/objects/aaa/client.jar');
      expect(log).not.toContain('/v1/packages/bbb/fx.json');
      expect(service.state().stamp).not.toBe(before);
      expect(await glyphs()).toEqual([0x4e2d, 0x3042, 0xe001]);
      expect(await glyphs(local.id)).toEqual([0x4e2d]);
      expect(progress).toContainEqual(expect.objectContaining({ stage: 'extract', activity: 'fonts' }));
      const total = fixture.index.length + Object.values(objects).reduce((sum, bytes) => sum + bytes.length, 0);
      expect(service.state().download).toMatchObject({ status: 'done', progress: { stages: expect.arrayContaining([{ id: 'extract', status: 'done', received: total, total }]) } });

      log.length = 0;
      const pack = join(dir, 'Font Overlay.zip');
      writeFiles(dir, { 'Font Overlay.zip': buildZip([
        { name: 'pack.mcmeta', data: packMcmeta('合成字体覆盖') },
        { name: `assets/${normal}`, data: glyph('4E8C', '80') },
        { name: `assets/${main}`, data: json([{ type: 'space', advances: { ' ': 7 } }]) },
      ]) });
      expect(await service.addPackFromPath(pack)).toMatchObject({ ok: true });
      expect((await service.fontProviders(defaultFont))?.providers[0]).toEqual({ type: 'space', advances: [[' '.codePointAt(0), 7]] });
      expect(await glyphs()).toEqual([0x4e8c, 0x3042, 0xe001]);
      await service.removeLayer(service.state().layers.find(({ kind }) => kind === 'pack')!.id);

      const archivePath = `objects${objectPath(objects[normal]!)}`;
      writeFiles(cacheDir(), { [archivePath]: Buffer.alloc(objects[normal]!.length) });
      expect(await glyphs()).toEqual([0x3042, 0xe001]);
      expect((await service.fontProviders(defaultFont))?.skipped).toContain(`undecodable(assets/${normal})`);
      rmSync(join(cacheDir(), `objects${objectPath(objects[main]!)}`));
      expect(await glyphs()).toEqual([]);
      expect(await glyphs(local.id)).toEqual([0x4e2d]);
      expect(log).toEqual([]);

      expect(await service.downloadVanilla('fx-9')).toEqual({ ok: true });
      expect(log.filter((path) => /^\/[\da-f]{2}\//.test(path))).toEqual([objectPath(objects[main]!), objectPath(objects[normal]!)]);
      expect(await glyphs()).toEqual([0x4e2d, 0x3042, 0xe001]);
    } finally { service.close(); }
  });

  it.each(['oversize', 'bad-hash'] as const)('索引字体 %s 不能进入下载缓存', async (variant) => {
    const { objects } = serveFonts(variant);
    const service = await openService();
    try {
      expect(await service.downloadVanilla('fx-9')).toEqual({ ok: false, error: 'verify' });
      expect(service.state().download).toMatchObject({ status: 'failed', progress: { stage: 'extract', activity: 'fonts' } });
      const saved = files(cacheDir());
      expect(saved).not.toContain(`objects${objectPath(objects[normal]!)}`);
      expect(saved.some((path) => path.endsWith('.part') || path.endsWith('version.json'))).toBe(false);
      if (variant === 'oversize') expect(log.filter((path) => /^\/[\da-f]{2}\//.test(path))).toEqual([]);
    } finally { service.close(); }
  });

  it('同名索引的哈希、大小或所在目录不符时，离线读取不会覆盖 JAR', async () => {
    const { fixture, objects } = serveFonts();
    const game = join(dir, 'version');
    writeFiles(game, { 'client.jar': fixture.jar, 'index.json': fixture.index, [`objects${objectPath(objects[main]!)}`]: objects[main]! });
    writeFiles(dir, { 'outside-index.json': fixture.index });
    const install: VanillaInstall = {
      gameDir: game, versionId: 'fx-9', releaseTime: '2030-01-01', jarPath: join(game, 'client.jar'),
      assetIndexPath: join(game, 'index.json'), assetIndexSha1: sha1(fixture.index), assetIndexSize: fixture.index.length,
      objectsDir: join(game, 'objects'),
    };
    for (const mismatch of [{ assetIndexSha1: '0'.repeat(40) }, { assetIndexSize: 1 }, { assetIndexPath: join(dir, 'outside-index.json') }]) {
      const layer = await openVanillaLayer({ ...install, ...mismatch });
      try {
        expect(new TextDecoder().decode((await layer.read(`assets/${main}`))!)).toBe(jarPlaceholder);
        expect(await layer.remoteObject?.(`assets/${normal}`)).toBeNull();
      } finally { layer.close(); }
    }
    expect(log).toEqual([]);
  });
});

describe('T-AST-DL 运行时下载客户端 jar', () => {
  it('T-AST-DL 指定正式版：与最新版本并存，同 ID 的不同资源索引不会覆盖', async () => {
    const latest = serveFakeRelease();
    const olderIndex = Buffer.from('{"objects":{}}');
    const older = Buffer.from(JSON.stringify({ ...latest.version, id: '1.21.11', releaseTime: '2025-12-09', assetIndex: {
      id: 'fx', url: 'https://piston-meta.mojang.com/older-index.json', sha1: sha1(olderIndex), size: olderIndex.byteLength,
    } }));
    const currentManifest = routes.get('/mc/game/version_manifest_v2.json');
    if (!Buffer.isBuffer(currentManifest)) throw new Error('missing fixture manifest');
    const original = JSON.parse(currentManifest.toString()) as { latest: { release: string }; versions: unknown[] };
    routes.set('/mc/game/version_manifest_v2.json', Buffer.from(JSON.stringify({ ...original, versions: [
      ...original.versions, { id: '1.21.11', type: 'release', url: 'https://piston-meta.mojang.com/older-version.json', sha1: sha1(older) },
    ] })));
    routes.set('/older-version.json', older);
    routes.set('/older-index.json', olderIndex);
    const dl = createVanillaDownloader({ cacheDir: cacheDir(), packaged: false, testOrigins: testOrigins() });
    expect((await dl.listOfficialReleases()).map((entry) => entry.versionId)).toEqual(['fx-9', '1.21.11']);
    expect(await dl.downloadRelease('1.21.11')).toMatchObject({ versionId: '1.21.11' });
    await expect(dl.downloadRelease('fx-10-snap')).rejects.toMatchObject({ code: 'bad-data' });
    await dl.downloadLatest();
    const requests = log.length;
    expect((await dl.listCached()).map((entry) => entry.versionId)).toEqual(['fx-9', '1.21.11']);
    expect(log).toHaveLength(requests);
  });
  it('T-AST-DL-1 正常下载：清单 → 最新正式版 → jar 与资源索引校验通过，资源对象按需取', async () => {
    const fixture = serveFakeRelease();
    const dl = createVanillaDownloader({ cacheDir: cacheDir(), packaged: false, testOrigins: testOrigins() });
    expect(await dl.findCached()).toBeNull();
    const phases = new Set<string>();
    const got = await dl.downloadLatest({ onProgress: (p) => phases.add(p.phase) });
    expect(got.versionId).toBe('fx-9');
    expect(phases).toEqual(new Set(['manifest', 'version', 'jar', 'index']));
    // 每次上报都能过 schema（DownloadTracker 只收合法的）

    expect(files(cacheDir())).toEqual([`indexes/fx-${sha1(fixture.index)}.json`, 'versions/fx-9/client.jar', 'versions/fx-9/version.json']);
    // 下载缓存当作原版层打开；音效对象不在本地，按需取
    const layer = await openVanillaLayer(got, { fetchObject: (h, s) => dl.fetchObject(h, s) });
    try {
      expect(layer.has(tex('stone'))).toBe(true);
      expect(Buffer.from((await layer.read(tex('stone'))) ?? []).equals(Buffer.from(solidPng('#00ff00')))).toBe(true);
      const ogg = await layer.read('assets/minecraft/sounds/dig/stone1.ogg');
      expect(Buffer.from(ogg ?? []).toString()).toBe('OggS-fake');
    } finally {
      layer.close();
    }
    expect(log.filter((p) => p.startsWith('/v1/') || p === '/mc/game/version_manifest_v2.json' || /^\/[0-9a-f]{2}\//.test(p))).toHaveLength(5);
  });

  it('T-AST-DL-2 jar 的 sha1 不符：被拒绝，不留文件', async () => {
    serveFakeRelease((f) => {
      (f.version.downloads as { client: { sha1: string } }).client.sha1 = '0'.repeat(40);
    });
    const dl = createVanillaDownloader({ cacheDir: cacheDir(), packaged: false, testOrigins: testOrigins() });
    await expect(dl.downloadLatest()).rejects.toMatchObject({ code: 'hash' });
    expect(files(cacheDir())).toEqual([]);
    expect(await dl.findCached()).toBeNull();
  });

  it('T-AST-DL-3 超大文件：声明超过上限直接拒绝；实际发来的比声明多也拒绝', async () => {
    serveFakeRelease();
    const small = createVanillaDownloader({ cacheDir: cacheDir(), packaged: false, testOrigins: testOrigins(), limits: { jarBytes: 10 } });
    await expect(small.downloadLatest()).rejects.toMatchObject({ code: 'size' });
    expect(log).not.toContain('/v1/objects/aaa/client.jar');

    serveFakeRelease((f) => {
      f.jar = Buffer.concat([f.jar, Buffer.alloc(1000)]); // 服务器发来的比版本 JSON 声明的大
      (f.version.downloads as { client: { size: number } }).client.size = 50;
    });
    const dl = createVanillaDownloader({ cacheDir: cacheDir(), packaged: false, testOrigins: testOrigins() });
    await expect(dl.downloadLatest()).rejects.toMatchObject({ code: 'size' });
    expect(files(cacheDir())).toEqual([]);
  });

  it('T-AST-DL-4 白名单外的主机：清单里的 URL 指向别处时拒绝，且不发请求', async () => {
    serveFakeRelease((f) => {
      (f.version.downloads as { client: { url: string } }).client.url = 'https://evil.example.com/client.jar';
    });
    const dl = createVanillaDownloader({ cacheDir: cacheDir(), packaged: false, testOrigins: { ...testOrigins(), 'evil.example.com': origin } });
    await expect(dl.downloadLatest()).rejects.toMatchObject({ code: 'host' });
    expect(log).not.toContain('/client.jar');
    for (const bad of ['http://piston-meta.mojang.com/x', 'https://piston-meta.mojang.com:8443/x', 'https://u:p@piston-meta.mojang.com/x', 'https://mojang.com/x', 'https://piston-meta.mojang.com.evil.io/x']) {
      expect(() => checkMojangUrl(bad), bad).toThrow(DownloadError);
    }
    expect(checkMojangUrl('https://resources.download.minecraft.net/ab/abc').hostname).toBe('resources.download.minecraft.net');
  });

  it('T-AST-DL-5 重定向：一律拒绝，不跟随', async () => {
    serveFakeRelease();
    routes.set('/v1/objects/aaa/client.jar', { status: 302, headers: { location: 'https://piston-data.mojang.com/elsewhere.jar' } });
    routes.set('/elsewhere.jar', Buffer.from('x'));
    const dl = createVanillaDownloader({ cacheDir: cacheDir(), packaged: false, testOrigins: testOrigins() });
    await expect(dl.downloadLatest()).rejects.toMatchObject({ code: 'redirect' });
    expect(log).not.toContain('/elsewhere.jar');
    expect(files(cacheDir())).toEqual([]);
  });

  it('T-AST-DL-6 中途取消：不留半成品', async () => {
    const f = serveFakeRelease();
    const chunks = Array.from({ length: 20 }, (_, i) => f.jar.subarray(Math.floor((i * f.jar.length) / 20), Math.floor(((i + 1) * f.jar.length) / 20)));
    routes.set('/v1/objects/aaa/client.jar', { slow: chunks, delayMs: 50 });
    const dl = createVanillaDownloader({ cacheDir: cacheDir(), packaged: false, testOrigins: testOrigins() });
    const ac = new AbortController();
    const p = dl.downloadLatest({
      signal: ac.signal,
      onProgress: (pr) => {
        if (pr.phase === 'jar' && pr.received > 0) ac.abort();
      },
    });
    await expect(p).rejects.toMatchObject({ code: 'aborted' });
    expect(files(cacheDir())).toEqual([]);
  });

  it('T-AST-DL-7 已缓存：findCached 完全离线；再次下载只取清单和版本 JSON，不再取 jar 和索引', async () => {
    serveFakeRelease();
    const dl = createVanillaDownloader({ cacheDir: cacheDir(), packaged: false, testOrigins: testOrigins() });
    await dl.downloadLatest();
    log.length = 0;
    const cached = await dl.findCached();
    expect(cached?.versionId).toBe('fx-9');
    expect(log).toEqual([]);
    await dl.downloadLatest();
    expect(log).toEqual(['/mc/game/version_manifest_v2.json', '/v1/packages/ddd/fx-9.json']);
    // 缓存的 jar 被改坏：findCached 不再认它
    rmSync(join(cacheDir(), 'versions/fx-9/client.jar'));
    expect(await dl.findCached()).toBeNull();
  });

  it('T-AST-DL-8 打包后不允许替换下载地址', () => {
    expect(() => createVanillaDownloader({ cacheDir: cacheDir(), packaged: true, testOrigins: testOrigins() })).toThrow();
    expect(() => createVanillaDownloader({ cacheDir: cacheDir(), packaged: true })).not.toThrow();
  });

  it('T-AST-DL-10 音效对象（M6b）：下载时按事件表取回 sounds.json 和全部变体的文件，其余对象不取；之后打开原版层不联网也能读到', async () => {
    const stone1 = Buffer.from('OggS-stone1');
    const stone2 = Buffer.from('OggS-stone2');
    const unrelated = Buffer.from('OggS-unrelated');
    const soundsJson = Buffer.from(
      JSON.stringify({
        'block.stone.place': { sounds: ['dig/stone1', { name: 'dig/stone2', volume: 0.8 }] },
        'block.other': { sounds: ['other/x'] },
        'ui.alias': { sounds: [{ name: 'block.stone.place', type: 'event' }] },
      }),
    );
    serveFakeRelease((f) => {
      f.index = Buffer.from(
        JSON.stringify({
          objects: {
            'minecraft/sounds.json': { hash: sha1(soundsJson), size: soundsJson.length },
            'minecraft/sounds/dig/stone1.ogg': { hash: sha1(stone1), size: stone1.length },
            'minecraft/sounds/dig/stone2.ogg': { hash: sha1(stone2), size: stone2.length },
            'minecraft/sounds/other/x.ogg': { hash: sha1(unrelated), size: unrelated.length },
          },
        }),
      );
      (f.version.assetIndex as { sha1: string; size: number }).sha1 = sha1(f.index);
      (f.version.assetIndex as { sha1: string; size: number }).size = f.index.length;
    });
    for (const b of [soundsJson, stone1, stone2, unrelated]) routes.set(`/${sha1(b).slice(0, 2)}/${sha1(b)}`, b);

    const dl = createVanillaDownloader({ cacheDir: cacheDir(), packaged: false, testOrigins: testOrigins() });
    const got = await dl.downloadLatest();
    log.length = 0;
    const phases: string[] = [];
    const r = await dl.fetchSoundObjects(got, ['minecraft:block.stone.place', 'minecraft:ui.alias', 'minecraft:not.there', 'allay:whoosh'], { onProgress: (p) => phases.push(p.phase) });
    expect(r.missing).toEqual(['minecraft:not.there', 'allay:whoosh']);
    // sounds.json + 两个变体；ui.alias 指向同一个事件，不重复取；other/x 不取
    expect(log.sort()).toEqual([soundsJson, stone1, stone2].map((b) => `/${sha1(b).slice(0, 2)}/${sha1(b)}`).sort());
    expect(new Set(phases)).toEqual(new Set(['object']));
    // 不传 fetchObject 打开（应用里下载缓存的原版层就是这样）：取回的能读到，没取回的读不到，全程不联网
    log.length = 0;
    const layer = await openVanillaLayer(got);
    try {
      expect(Buffer.from((await layer.read('assets/minecraft/sounds/dig/stone2.ogg')) ?? []).toString()).toBe('OggS-stone2');
      expect(Buffer.from((await layer.read('assets/minecraft/sounds.json')) ?? []).equals(soundsJson)).toBe(true);
      expect(await layer.read('assets/minecraft/sounds/other/x.ogg')).toBeNull();
    } finally {
      layer.close();
    }
    expect(log).toEqual([]);
    // 再取一次：都已在缓存里且校验通过，不联网
    await dl.fetchSoundObjects(got, ['minecraft:block.stone.place']);
    expect(log).toEqual([]);

    // 对象被篡改：sha1 不符，拒绝且不留半成品
    rmSync(join(cacheDir(), 'objects'), { recursive: true, force: true });
    routes.set(`/${sha1(stone1).slice(0, 2)}/${sha1(stone1)}`, Buffer.from('OggS-evil!!'));
    await expect(dl.fetchSoundObjects(got, ['minecraft:block.stone.place'])).rejects.toMatchObject({ code: 'hash' });
    expect(files(join(cacheDir(), 'objects')).filter((p) => p.endsWith('.part'))).toEqual([]);
  });

  it('T-AST-DL-9 原版层来源：默认取较新的，可以指定偏好', () => {
    const local: VanillaInstall = { gameDir: 'g', versionId: '1.21.1', releaseTime: '2024-08-08T00:00:00Z', jarPath: 'a', assetIndexPath: null, objectsDir: 'o' };
    const cached: CachedVanilla = { ...local, source: 'downloaded', versionId: '26.3', releaseTime: '2026-10-01T00:00:00Z' };
    expect(chooseVanillaSource(null, null)).toEqual({ status: 'needs-download', install: null });
    expect(chooseVanillaSource(local, null).status).toBe('local');
    expect(chooseVanillaSource(null, cached).status).toBe('cached');
    expect(chooseVanillaSource(local, cached).install?.versionId).toBe('26.3');
    expect(chooseVanillaSource(local, cached, 'local').install?.versionId).toBe('1.21.1');
    expect(chooseVanillaSource({ ...local, releaseTime: '2027-01-01T00:00:00Z' }, cached).status).toBe('local');
  });
});
