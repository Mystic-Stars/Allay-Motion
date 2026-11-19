import { createHash } from 'node:crypto';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createLogger } from '../../apps/desktop/src/main/logger';
import { createVanillaDownloader } from '../../apps/desktop/src/main/resources/download';
import { ResourceService } from '../../apps/desktop/src/main/resources/service';
import { SettingsStore } from '../../apps/desktop/src/main/settings-store';
import { buildZip, makeFakeMinecraft, solidPng, tex, writeFiles, writeZip } from './helpers/resource-fixtures';

const stone = 'minecraft:block/stone';
const log = createLogger(null, false);
const manifest = JSON.stringify({ format_version: 2, header: { name: 'pack.name', uuid: '0137cfde-ebdb-4c12-8ee9-2f4d5bba0261', version: [1, 2, 3] }, modules: [{ type: 'resources' }] });
let root: string;
let service: ResourceService | undefined;

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'allay-version-library-')); });
afterEach(async () => { service?.close(); service = undefined; await rm(root, { recursive: true, force: true }); });

async function open(downloadVersion?: string) {
  service?.close();
  const settings = new SettingsStore(join(root, 'data', 'settings.json'), log);
  await settings.load();
  const downloader = createVanillaDownloader({ cacheDir: join(root, 'data', 'vanilla-cache'), packaged: true });
  const failOnline = async (): Promise<never> => { throw new Error('unexpected network access'); };
  const current = new ResourceService({ userDataDir: join(root, 'data'), builtinDir: join(root, 'empty'), settings, log,
    downloader: { ...downloader, listOfficialReleases: failOnline, downloadLatest: failOnline, downloadRelease: downloadVersion ? async (version) => {
      expect(version).toBe(downloadVersion);
      cacheRelease(downloadVersion, '2026-12-15', '#ffffff');
      return (await downloader.listCached()).find((entry) => entry.versionId === version)!;
    } : failOnline, fetchObject: failOnline },
    gameEnv: { platform: 'win32', appData: root, home: root }, onChanged: () => undefined });
  service = current;
  await current.init();
  await current.detectMinecraft();
  return current;
}

function cacheRelease(versionId: string, date: string, color: string, complete = true) {
  const jar = Buffer.from(buildZip([{ name: tex('stone'), data: solidPng(color) }]));
  const sha1 = createHash('sha1').update(jar).digest('hex');
  writeFiles(join(root, 'data', 'vanilla-cache', 'versions', versionId), {
    'client.jar': jar,
    ...(complete ? { 'version.json': JSON.stringify({ id: versionId, type: 'release', releaseTime: date, downloads: { client: { url: 'https://piston-data.mojang.com/client.jar', sha1, size: jar.byteLength } } }) } : {}),
  });
}

it('T-AST-VERSION：本机 1.21.11 和缓存 26.3 并存，下载、重启、离线和局部解析不串版本', async () => {
  const game = join(root, '.minecraft');
  makeFakeMinecraft(game, [
    { id: '1.21.11', type: 'release', releaseTime: '2025-12-09T00:00:00Z', jar: true },
    { id: '1.21.10', type: 'release', releaseTime: '2025-10-09T00:00:00Z', jar: true },
    { id: '26-snapshot', type: 'snapshot', releaseTime: '2026-01-09T00:00:00Z', jar: true },
    { id: 'incomplete', type: 'release', releaseTime: '2026-08-09T00:00:00Z', jar: false },
  ], '#ff0000');
  writeFiles(join(game, 'resourcepacks', 'blue'), { [tex('stone')]: solidPng('#0000ff') });
  cacheRelease('26.3', '2026-09-15', '#00ff00');
  cacheRelease('26.2', '2026-06-15', '#ffff00');
  cacheRelease('26.4', '2026-12-15', '#ffffff', false);
  let current = await open('26.4');
  const profiles = current.state().library!.profiles;
  expect(profiles.map((profile) => profile.versionId).sort()).toEqual(['1.21.10', '1.21.11', '26-snapshot', '26.2', '26.3']);
  const local = profiles.find((profile) => profile.versionId === '1.21.11')!;
  const cached = profiles.find((profile) => profile.versionId === '26.3')!;
  expect(await current.readTexture(stone, local.id)).toBeNull();
  expect(await current.instancePacks(local.id)).toEqual([]);
  await current.selectProfile(local.id);
  const [pack] = await current.instancePacks(local.id);
  expect(pack).toMatchObject({ enabled: false, missing: false });
  expect((await current.readTexture(stone))?.png).toEqual(solidPng('#ff0000'));
  await current.setInstancePack(local.id, pack!.id, true);
  expect((await current.readTexture(stone, local.id))?.png).toEqual(solidPng('#0000ff'));
  expect(await current.list('assets/minecraft/textures/block/', cached.id)).toContain(tex('stone'));
  expect((await current.readTexture(stone, cached.id))?.png).toEqual(solidPng('#00ff00'));
  const localStamp = current.state().library?.profiles.find((profile) => profile.id === local.id)?.stamp;
  await current.selectProfile(cached.id);
  expect((await current.readTexture(stone))?.png).toEqual(solidPng('#00ff00'));
  expect(current.state().library?.profiles.find((profile) => profile.id === local.id)?.stamp).toBe(localStamp);
  await current.selectProfile(local.id);
  expect(await current.downloadVanilla('26.4')).toEqual({ ok: true });
  expect(current.state().library).toMatchObject({ pinnedId: local.id, activeProfileId: local.id });
  expect(current.state().library?.profiles).toContainEqual(expect.objectContaining({ source: 'downloaded', versionId: '26.4', missing: false }));
  current = await open();
  expect(current.state().library).toMatchObject({ pinnedId: local.id, activeProfileId: local.id });
  expect((await current.readTexture(stone))?.png).toEqual(solidPng('#0000ff'));
  const moved = join(root, 'moved');
  current.close();
  service = undefined;
  await rename(game, moved);
  current = await open();
  expect(current.state().library).toMatchObject({ pinnedId: local.id, activeProfileId: null });
  expect(current.state().library?.profiles).toContainEqual(expect.objectContaining({ id: local.id, missing: true }));
  expect(await current.readTexture(stone)).toBeNull();
  expect(await current.useGameDir(moved, local.id)).toEqual({ ok: true });
  expect(current.state().library?.activeProfileId).toBe(local.id);
  expect((await current.readTexture(stone, local.id))?.png).toEqual(solidPng('#0000ff'));
});

it('T-AST-VERSION：普通基岩包映射贴图、音效、音乐、语言和字体；加密包拒绝', async () => {
  const path = join(root, 'fixture.mcpack');
  writeZip(path, [
    { name: 'manifest.json', data: manifest },
    { name: 'textures/terrain_texture.json', data: JSON.stringify({ texture_data: { stone: { textures: 'textures/blocks/test' } } }) },
    { name: 'textures/blocks/test.png', data: solidPng('#ff00ff') },
    { name: 'sounds/sound_definitions.json', data: JSON.stringify({ sound_definitions: { 'music.game': { sounds: ['sounds/music/test'] } } }) },
    { name: 'sounds/music_definitions.json', data: JSON.stringify({ overworld: { event_name: 'music.game' } }) },
    { name: 'sounds/music/test.ogg', data: 'test-ogg' },
    { name: 'texts/en_US.lang', data: 'pack.name=Fixture pack' },
    { name: 'font/default8.png', data: solidPng('#ffffff', 128, 128) },
  ]);
  const current = await open();
  const result = await current.addPackFromPath(path);
  expect(result).toMatchObject({ ok: true });
  if (!('ok' in result) || !result.ok) throw new Error('pack failed to load');
  expect(current.state().library?.profiles).toContainEqual(expect.objectContaining({ id: result.id, name: 'Fixture pack', versionId: '1.2.3', source: 'bedrock' }));
  expect(await current.readTexture(stone)).toBeNull();
  expect((await current.readTexture(stone, result.id))?.png).toEqual(solidPng('#ff00ff'));
  expect((await current.soundVariants('minecraft:overworld', result.id))?.[0]?.file).toBe('minecraft:music/test');
  expect(new TextDecoder().decode((await current.read('assets/minecraft/lang/en_us.json', result.id))!)).toContain('Fixture pack');
  expect(await current.read('assets/minecraft/textures/font/default8.png', result.id)).toEqual(solidPng('#ffffff', 128, 128));
  expect((await current.fontProviders('minecraft:default', result.id))?.providers).toContainEqual(expect.objectContaining({ type: 'bitmap', file: 'assets/minecraft/textures/font/default8.png' }));
  const encrypted = join(root, 'encrypted');
  writeFiles(encrypted, { 'manifest.json': manifest, 'contents.json': JSON.stringify({ content: [{ key: 'test-fixture' }] }) });
  expect(await current.addPackFromPath(encrypted)).toEqual({ ok: false, error: 'encrypted' });
});
