import { createHash } from 'node:crypto';
import { mkdtempSync, rmdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createLogger } from '../../apps/desktop/src/main/logger';
import { createVanillaDownloader } from '../../apps/desktop/src/main/resources/download';
import { ResourceService } from '../../apps/desktop/src/main/resources/service';
import { findJavaVersions, openVanillaLayer } from '../../apps/desktop/src/main/resources/vanilla';
import { SettingsStore } from '../../apps/desktop/src/main/settings-store';
import { buildZip, solidPng, writeFiles } from './helpers/resource-fixtures';

const indexId = 'fixture-index';
const key = (face: number) => `minecraft/textures/gui/title/background/panorama_${face}.png`;
const resourceId = (face: number) => `minecraft:gui/title/background/panorama_${face}`;
const sha1 = (data: Uint8Array | string) => createHash('sha1').update(data).digest('hex');
const stub = solidPng('#101010', 1, 1);
const faces = ['#fc0000', '#00fc00', '#0000fc', '#a06fff', '#00ffee', '#eeff00'].map((color) => solidPng(color, 1024, 1024));
const other = solidPng('#ffeedd', 32, 32);
const packFace = solidPng('#010203', 16, 16);
const jar = buildZip(faces.flatMap((_, face) => [
  { name: `assets/${key(face)}`, data: stub },
  { name: `assets/${key(face)}.mcmeta`, data: '{"from":"jar"}' },
]));
const log = createLogger(null, false);
let root: string;
let resources: ResourceService | undefined;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'allay-indexed-textures-')); });
afterEach(async () => {
  resources?.close();
  resources = undefined;
  const target = join(root, 'generated');
  await rm(target, { recursive: true, force: true });
  rmdirSync(root);
});

function fixture(version: string, cached: boolean, variant: 'complete' | 'broken' | 'foreign' = 'complete') {
  const game = join(root, 'generated', ...(cached ? ['data', 'vanilla-cache'] : ['.minecraft']));
  const assets = cached ? game : join(game, 'assets');
  const object = (bytes: Uint8Array | string, stored: Uint8Array | string | null = bytes) => {
    const hash = sha1(bytes);
    if (stored !== null) writeFiles(join(assets, 'objects', hash.slice(0, 2)), { [hash]: stored });
    return { hash, size: typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.byteLength };
  };
  const entries: Record<string, unknown> = Object.fromEntries(faces.map((png, face) => [key(face), object(variant === 'foreign' ? other : png)]));
  entries[`${key(0)}.mcmeta`] = object('{"from":"index"}');
  if (variant === 'broken') {
    entries[key(1)] = object(solidPng('#ffffff', 16, 16), null);
    entries[key(2)] = { size: 1 };
    entries[key(3)] = { hash: '../not-a-hash', size: 1 };
    const valid = solidPng('#000000', 16, 16);
    const wrongBytes = new Uint8Array(valid);
    wrongBytes[wrongBytes.length - 1] = wrongBytes[wrongBytes.length - 1]! ^ 1;
    entries[key(4)] = object(valid, wrongBytes);
    entries[key(5)] = object('not a PNG');
  }
  const actualIndex = JSON.stringify({ objects: entries });
  const declaredIndex = variant === 'foreign' ? JSON.stringify({ objects: {} }) : actualIndex;
  const hash = sha1(declaredIndex);
  const meta = JSON.stringify({ id: version, type: 'release', releaseTime: '2026-09-01T00:00:00Z',
    downloads: { client: { url: 'https://piston-data.mojang.com/client.jar', sha1: sha1(jar), size: jar.byteLength } },
    assetIndex: { id: indexId, url: 'https://piston-meta.mojang.com/index.json', sha1: hash, size: Buffer.byteLength(declaredIndex) },
  });
  writeFiles(join(game, 'versions', version), cached ? { 'client.jar': jar, 'version.json': meta } : { [`${version}.jar`]: jar, [`${version}.json`]: meta });
  writeFiles(join(assets, 'indexes'), { [cached ? `${indexId}-${hash}.json` : `${indexId}.json`]: actualIndex });
  return game;
}

it.each([['1.21.1', false], ['26.3', true]] as const)('T-AST-VERSION %s：同名六面读已校验的索引对象而不是 1×1 JAR', async (version, cached) => {
  const game = fixture(version, cached);
  const [install] = cached ? await createVanillaDownloader({ cacheDir: game, packaged: true }).listCached() : await findJavaVersions(game);
  expect(install?.versionId).toBe(version);
  const layer = await openVanillaLayer(install!);
  try {
    for (const [face, png] of faces.entries()) expect(Buffer.compare(Buffer.from((await layer.read(`assets/${key(face)}`))!), png)).toBe(0);
    expect(new TextDecoder().decode((await layer.read(`assets/${key(0)}.mcmeta`))!)).toBe('{"from":"index"}');
  } finally { layer.close(); }
});

it('T-AST-VERSION 仅跳过缺失或损坏条目：未缓存、缺哈希、非法哈希、内容不符和非 PNG 均回退 JAR', async () => {
  const [install] = await findJavaVersions(fixture('1.21.1', false, 'broken'));
  const fetchObject = vi.fn(async () => { throw new Error('texture read must stay offline'); });
  const layer = await openVanillaLayer(install!, { fetchObject });
  try {
    expect(Buffer.compare(Buffer.from((await layer.read(`assets/${key(0)}`))!), faces[0]!)).toBe(0);
    for (let face = 1; face < 6; face++) expect(await layer.read(`assets/${key(face)}`)).toEqual(stub);
    expect(fetchObject).not.toHaveBeenCalled();
  } finally { layer.close(); }
});

it('T-AST-VERSION 同名索引与版本哈希不符时不混用对象', async () => {
  const [install] = await findJavaVersions(fixture('1.21.1', false, 'foreign'));
  const layer = await openVanillaLayer(install!);
  try { expect(await layer.read(`assets/${key(0)}`)).toEqual(stub); } finally { layer.close(); }
});

it('T-AST-VERSION 宿主保持授权和资源包优先，胜出图不继承原版元数据', async () => {
  const game = fixture('1.21.1', false);
  const data = join(root, 'generated', 'data');
  const settings = new SettingsStore(join(data, 'settings.json'), log);
  await settings.load();
  const service = new ResourceService({
    settings, log, userDataDir: data, builtinDir: join(data, 'empty'),
    downloader: createVanillaDownloader({ cacheDir: join(data, 'vanilla-cache'), packaged: true }),
    gameEnv: { platform: 'win32', appData: join(root, 'generated'), home: join(root, 'generated') }, onChanged: () => undefined,
  });
  resources = service;
  await service.init();
  await service.detectMinecraft();
  const local = service.state().library?.profiles.find((profile) => profile.source === 'local');
  expect(local).toBeDefined();
  expect(await service.readTexture(resourceId(0), local!.id)).toBeNull();
  expect(await service.useGameDir(game)).toEqual({ ok: true });
  expect((await service.readTexture(resourceId(0)))?.mcmeta).toBe('{"from":"index"}');
  const stamp = () => service.state().library?.profiles.find(entry => entry.id === local!.id)?.stamp;
  const before = stamp();
  const pack = join(root, 'generated', 'pack');
  writeFiles(pack, { 'pack.mcmeta': '{"pack":{"pack_format":34,"description":"fixture"}}', [`assets/${key(0)}`]: packFace });
  const result = await service.addPackFromPath(pack);
  if (!('ok' in result) || !result.ok) throw new Error('pack was not installed');
  expect(await service.readTexture(resourceId(0))).toEqual({ png: packFace, mcmeta: null });
  expect(await service.readTexture(resourceId(0), local!.id)).toEqual({ png: packFace, mcmeta: null });
  expect(stamp()).not.toBe(before);
  const withPack = stamp();
  await service.setEnabled(result.id, false);
  expect(stamp()).not.toBe(withPack);
  expect(await service.readTexture(resourceId(0), local!.id)).toEqual({ png: faces[0], mcmeta: '{"from":"index"}' });
});
