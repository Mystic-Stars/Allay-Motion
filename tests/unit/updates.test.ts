import * as childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, rmdir, stat, statfs, writeFile } from 'node:fs/promises';
import type { Stats, StatsFs } from 'node:fs';
import type * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../apps/desktop/src/main/logger';
import { UpdateService, checkUpdateUrl } from '../../apps/desktop/src/main/updates/service';
import { UiSettingsPatchSchema, migrateSettingsFile } from '../../apps/desktop/src/shared/settings';
import { UPDATE_REPO, assetPattern, compareVersions, defaultUpdatePrefs, parseChecksums, resolveUpdateSource, staleDownload, versionFromTag, type UpdatePrefs, type UpdateSource, type UpdateState } from '../../apps/desktop/src/shared/updates';
import { spaceCheckMacro } from '../../scripts/dist-extras';

// 自动更新的纯逻辑（docs/decisions.md“自动更新”）

describe('自动更新', () => {
  it('“自动”按时区选源：中国大陆用 GitCode，其他地区（含港澳台）用 GitHub', () => {
    expect(resolveUpdateSource('auto', 'Asia/Shanghai')).toBe('gitcode');
    expect(resolveUpdateSource('auto', 'Asia/Urumqi')).toBe('gitcode');
    expect(resolveUpdateSource('auto', 'Asia/Hong_Kong')).toBe('github');
    expect(resolveUpdateSource('auto', 'America/New_York')).toBe('github');
    expect(resolveUpdateSource('auto', undefined)).toBe('github');
    expect(resolveUpdateSource('github', 'Asia/Shanghai')).toBe('github');
    expect(resolveUpdateSource('gitcode', 'Europe/Berlin')).toBe('gitcode');
  });

  it('版本比较与标签解析', () => {
    expect(versionFromTag('v0.1.2')).toBe('0.1.2');
    expect(versionFromTag('nightly')).toBeNull();
    expect(compareVersions('0.1.2', '0.1.1')).toBeGreaterThan(0);
    expect(compareVersions('0.1.10', '0.1.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0', '1.0.0-beta.2')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-beta.10', '1.0.0-beta.2')).toBeGreaterThan(0);
  });

  it('按平台和架构挑安装包', () => {
    const names = ['Allay-Motion-0.1.2-x64-setup.exe', 'Allay-Motion-0.1.2-arm64.dmg', 'Allay-Motion-0.1.2-x64.dmg', 'Allay-Motion-0.1.2-arm64-mac.zip'];
    const pick = (p: string, a: string) => names.find((n) => assetPattern(p, a)?.test(n)) ?? null;
    expect(pick('win32', 'x64')).toBe('Allay-Motion-0.1.2-x64-setup.exe');
    expect(pick('darwin', 'arm64')).toBe('Allay-Motion-0.1.2-arm64.dmg');
    expect(pick('darwin', 'x64')).toBe('Allay-Motion-0.1.2-x64.dmg');
    expect(assetPattern('linux', 'x64')).toBeNull();
  });

  it('解析 SHA256SUMS.txt', () => {
    const h = 'a'.repeat(64);
    const sums = parseChecksums(`${h}  Allay-Motion-0.1.2-x64-setup.exe\r\n${'B'.repeat(64)}  other.dmg\n\nbad line`);
    expect(sums.get('Allay-Motion-0.1.2-x64-setup.exe')).toBe(h);
    expect(sums.get('other.dmg')).toBe('b'.repeat(64));
    expect(sums.size).toBe(2);
  });

  it('只访问 GitHub、GitCode 的 https 地址', () => {
    expect(() => checkUpdateUrl('https://api.github.com/repos/x/y/releases/latest')).not.toThrow();
    expect(() => checkUpdateUrl('https://release-assets.githubusercontent.com/a')).not.toThrow();
    expect(() => checkUpdateUrl('https://file-cdn.gitcode.com/a?auth_key=1')).not.toThrow();
    expect(() => checkUpdateUrl('http://github.com/a')).toThrow();
    expect(() => checkUpdateUrl('https://github.com:8443/a')).toThrow();
    expect(() => checkUpdateUrl('https://evil.example.com/a')).toThrow();
    expect(() => checkUpdateUrl('https://github.com.evil.example/a')).toThrow();
  });

  it('启动时清理：半成品和不比当前新的安装包可以删，更新的留着', () => {
    expect(staleDownload('Allay-Motion-0.1.2-x64-setup.exe.1b2c.part', '0.1.2')).toBe(true);
    expect(staleDownload('Allay-Motion-0.1.2-x64-setup.exe', '0.1.2')).toBe(true);
    expect(staleDownload('Allay-Motion-0.1.1-arm64.dmg', '0.1.2')).toBe(true);
    expect(staleDownload('Allay-Motion-0.1.3-x64-setup.exe', '0.1.2')).toBe(false);
    expect(staleDownload('notes.txt', '0.1.2')).toBe(false);
  });

  it('安装程序的临时空间检查：变量不被转义，空间不够时退出码 2', () => {
    const macro = spaceCheckMacro();
    expect(macro).toContain('${GetRoot} "$TEMP" $R9');
    expect(macro).toContain('${If} $R8 < 1024');
    expect(macro).toContain('（$R9）只剩 $R8 MB');
    expect(macro).not.toContain('$$R');
    expect(macro).toContain('SetErrorLevel 2');
  });

  it('旧设置文件没有 updates 时用默认值，坏掉的字段各自兜底', () => {
    expect(migrateSettingsFile({ formatVersion: 1 })?.ui.updates).toEqual({ mode: 'auto', source: 'auto', channel: 'main', skipVersion: null });
    expect(migrateSettingsFile({ formatVersion: 1, ui: { updates: { mode: 'off', source: 'nope', channel: 'nightly', skipVersion: 3 } } })?.ui.updates).toEqual({ mode: 'off', source: 'auto', channel: 'main', skipVersion: null });
    const legacy = { mode: 'notify', source: 'gitcode', skipVersion: '1.2.3' };
    expect(migrateSettingsFile({ formatVersion: 1, ui: { updates: legacy } })?.ui.updates).toEqual({ ...legacy, channel: 'main' });
    expect(UiSettingsPatchSchema.parse({ updates: legacy }).updates).toEqual({ ...legacy, channel: 'main' });
    expect(UiSettingsPatchSchema.parse({ updates: { ...legacy, channel: 'dev' } }).updates).toEqual({ ...legacy, channel: 'dev', skipVersion: null });
    expect(UiSettingsPatchSchema.safeParse({ updates: { ...legacy, channel: 'nightly' } }).success).toBe(false);
    expect(UiSettingsPatchSchema.safeParse({ updates: { ...legacy, prerelease: true } }).success).toBe(false);
  });
});

vi.mock('node:child_process', async (importOriginal) => ({ ...await importOriginal<typeof childProcess>(), spawn: vi.fn() }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof fsPromises>();
  return { ...original, stat: vi.fn(original.stat), statfs: vi.fn(original.statfs) };
});

const payload = '测试安装包';
const checksum = createHash('sha256').update(payload).digest('hex');

function release(tag: string, source: UpdateSource, flags: { draft?: boolean; prerelease?: boolean } = {}) {
  const stem = `https://${source}.com/${UPDATE_REPO}/releases/download/${tag}`;
  const name = `Allay-Motion-${tag.slice(1)}-x64-setup.exe`;
  return {
    tag_name: tag,
    ...flags,
    assets: [
      { name, browser_download_url: `${stem}/${name}`, size: Buffer.byteLength(payload) },
      { name: 'SHA256SUMS.txt', browser_download_url: `${stem}/SHA256SUMS.txt` },
    ],
  };
}

type TestRelease = ReturnType<typeof release>;

function sums(item: TestRelease): Response {
  return new Response(`${checksum}  ${item.assets[0]!.name}\n`);
}

function mockFetch(handler: (url: URL, signal: AbortSignal) => Response | Promise<Response>) {
  const fetch = vi.fn((url: URL, request: RequestInit) => handler(url, request.signal!));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const services: UpdateService[] = [];
const testDirs: string[] = [];

function updater(initial: Partial<UpdatePrefs>, currentVersion = '1.0.0', downloadDir = '', packaged = false) {
  let prefs = { ...defaultUpdatePrefs(), mode: 'off', ...initial } satisfies UpdatePrefs;
  const onChanged = vi.fn<(state: UpdateState) => void>();
  const quit = vi.fn();
  const service = new UpdateService({
    currentVersion, packaged, downloadDir, platform: 'win32', arch: 'x64', timeZone: undefined,
    prefs: () => prefs, log: createLogger(null, false), onChanged, quit, openPath: async () => '', tempDir: downloadDir, fallbackTempDir: null,
  });
  services.push(service);
  return {
    service, onChanged, quit,
    change(patch: Partial<UpdatePrefs>) {
      const previous = prefs;
      prefs = { ...prefs, ...patch };
      service.prefsChanged(previous, prefs);
    },
  };
}

async function testDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'allay-update-test-'));
  testDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const service of services.splice(0)) service.stop();
  for (const dir of testDirs.splice(0)) {
    for (const name of await readdir(dir)) await rm(join(dir, name), { force: true });
    await rmdir(dir);
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('更新渠道', () => {
  it.each(['github', 'gitcode'] as const)('%s：同仓按渠道筛选，跨页按版本号排序', async (source) => {
    const flags = source === 'github' ? { prerelease: true } : {};
    const stable = release('v2.0.0', source);
    const dev = release('v3.0.0-dev.2', source, flags);
    const codex = release('v3.0.0-codex.10', source, flags);
    const rows = [
      release('v3.0.0-codex.2', source, flags),
      release('v9.0.0-codex.1', source, { ...flags, draft: true }),
      release('v9.0.0', source, { prerelease: true }),
      dev,
      ...Array.from({ length: 16 }, (_, index) => release(`v3.0.0-nightly.${index}`, source, flags)),
    ];
    const fetch = mockFetch((url, signal) => {
      if (url.pathname.endsWith('/SHA256SUMS.txt')) {
        const item = [stable, dev, codex].find((item) => url.pathname.includes(`/${item.tag_name}/`));
        expect(item).toBeDefined();
        expect(url.hostname).toBe(`${source}.com`);
        return sums(item!);
      }
      expect(url.hostname).toBe(`api.${source}.com`);
      expect(url.pathname).toContain(`/repos/${UPDATE_REPO}/`);
      expect(signal.aborted).toBe(false);
      return Response.json(url.pathname.endsWith('/latest')
        ? release('v8.0.0-dev.1', source, flags)
        : url.searchParams.get('page') === '1' ? rows : [codex, stable]);
    });
    const { service, change } = updater({ source, channel: 'codex' });
    expect(await service.check(true)).toMatchObject({ channel: 'codex', status: 'available', latest: { version: '3.0.0-codex.10', source } });
    change({ channel: 'dev' });
    expect(await service.check(true)).toMatchObject({ channel: 'dev', latest: { version: '3.0.0-dev.2', source } });
    change({ channel: 'main' });
    expect(await service.check(true)).toMatchObject({ channel: 'main', latest: { version: '2.0.0', source } });
    expect(fetch.mock.calls.filter(([url]) => url.searchParams.get('page') === '2')).toHaveLength(3);
  });

  it('首选源没有同渠道发行版时才回退；无匹配报 no-release，镜像旧版本不降级', async () => {
    const dev = release('v2.0.0-dev.2', 'github', { prerelease: true });
    const fetch = mockFetch((url) => {
      if (url.pathname.endsWith('/SHA256SUMS.txt')) return sums(dev);
      if (url.hostname === 'api.gitcode.com') return Response.json([release('v8.0.0', 'gitcode'), release('v8.0.0-codex.2', 'gitcode')]);
      return Response.json([dev, release('v9.0.0-dev.1', 'github', { draft: true, prerelease: true })]);
    });
    const { service, change } = updater({ source: 'gitcode', channel: 'dev' }, '2.0.0-dev.10');
    expect(await service.check(true)).toMatchObject({ status: 'up-to-date', latest: { version: '2.0.0-dev.2', source: 'github' } });
    expect(await service.download()).toMatchObject({ status: 'up-to-date' });
    expect(fetch.mock.calls.some(([url]) => url.pathname.endsWith('.exe'))).toBe(false);
    fetch.mockImplementation((url) => Response.json([release('v8.0.0', url.hostname === 'api.gitcode.com' ? 'gitcode' : 'github')]));
    change({ channel: 'codex' });
    expect(await service.check(true)).toMatchObject({ channel: 'codex', status: 'error', error: 'no-release', latest: null });
  });

  it('切换时取消待定的自动检查，迟到结果不会回退、提示或覆盖新检查', async () => {
    vi.useFakeTimers();
    const started = deferred<AbortSignal>();
    const oldReply = deferred<Response>();
    const stable = release('v2.0.0', 'github');
    const dev = release('v3.0.0-dev.1', 'github', { prerelease: true });
    const fetch = mockFetch((url, signal) => {
      if (url.pathname.endsWith('/latest')) {
        started.resolve(signal);
        return oldReply.promise;
      }
      if (url.pathname.endsWith('/SHA256SUMS.txt')) return sums(dev);
      return Response.json([dev]);
    });
    const dir = await testDir();
    const { service, onChanged, change } = updater({ mode: 'auto' }, '1.0.0', dir, true);
    service.start();
    await vi.advanceTimersByTimeAsync(15_000);
    const old = service.check(true);
    const oldSignal = await started.promise;
    change({ channel: 'dev', mode: 'off' });
    expect(oldSignal.aborted).toBe(true);
    expect(service.current).toMatchObject({ channel: 'dev', status: 'idle', checkedAt: null, latest: null });
    expect(await service.check(true)).toMatchObject({ status: 'available', latest: { version: '3.0.0-dev.1' } });
    oldReply.resolve(Response.json(stable));
    await old;
    expect(service.current).toMatchObject({ channel: 'dev', status: 'available', announce: false });
    expect(onChanged.mock.calls.every(([state]) => !state.announce)).toBe(true);
    expect(fetch.mock.calls.map(([url]) => url.pathname.endsWith('/latest') ? 'latest' : url.pathname.split('/').pop())).toEqual(['latest', 'releases', 'SHA256SUMS.txt']);
  });

  it('切回原渠道时只执行新的延迟检查，旧的跳过标记不再抑制通知', async () => {
    vi.useFakeTimers();
    const stable = release('v2.0.0', 'github');
    const fetch = mockFetch((url) => url.pathname.endsWith('/latest') ? Response.json(stable) : sums(stable));
    const { service, change } = updater({ mode: 'notify', skipVersion: '2.0.0' }, '1.0.0', '', true);
    change({ channel: 'codex' });
    change({ channel: 'main' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(service.current).toMatchObject({ channel: 'main', status: 'available', announce: true });
    expect(fetch.mock.calls.map(([url]) => url.pathname.split('/').pop())).toEqual(['latest', 'SHA256SUMS.txt']);
  });

  it('切换取消流式下载，仅清理本次半成品，不影响新渠道下载', async () => {
    const old = release('v2.0.0', 'github');
    const dev = release('v3.0.0-dev.1', 'github', { prerelease: true });
    const streamCanceled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(payload)); },
      cancel: streamCanceled,
    });
    mockFetch((url) => {
      if (url.pathname.endsWith('/latest')) return Response.json(old);
      if (url.pathname.endsWith('/releases')) return Response.json([dev]);
      const isOld = url.pathname.includes('/v2.0.0/');
      if (url.pathname.endsWith('/SHA256SUMS.txt')) return sums(isOld ? old : dev);
      return new Response(isOld ? stream : payload);
    });
    const dir = await testDir();
    await writeFile(join(dir, 'keep.txt'), '保留');
    const { service, change, onChanged } = updater({}, '1.0.0', dir);
    await service.check(true);
    const pending = service.download();
    await vi.waitFor(() => expect(service.current.progress?.received).toBe(Buffer.byteLength(payload)));
    change({ channel: 'dev' });
    const reset = onChanged.mock.calls.length - 1;
    expect(service.current).toMatchObject({ status: 'idle', latest: null, progress: null, checkedAt: null });
    await service.check(true);
    const next = service.download();
    await pending;
    expect(await next).toMatchObject({ channel: 'dev', status: 'downloaded', latest: { version: '3.0.0-dev.1' } });
    expect(streamCanceled).toHaveBeenCalledOnce();
    expect(onChanged.mock.calls.slice(reset).every(([state]) => state.channel === 'dev')).toBe(true);
    expect((await readdir(dir)).sort()).toEqual([dev.assets[0]!.name, 'keep.txt'].sort());
  });

  it('命中安装包缓存后切换渠道，Windows 临时空间查询完成也不会启动旧安装包', async () => {
    const stable = release('v2.0.0', 'github');
    const fetch = mockFetch((url) => url.pathname.endsWith('/latest') ? Response.json(stable) : sums(stable));
    const dir = await testDir();
    await writeFile(join(dir, stable.assets[0]!.name), payload);
    const { service, change, quit } = updater({}, '1.0.0', dir, true);
    await service.check(true);
    expect(await service.download()).toMatchObject({ status: 'downloaded' });
    expect(fetch).toHaveBeenCalledTimes(2);
    const disk = deferred<StatsFs>();
    vi.mocked(statfs).mockImplementationOnce(() => disk.promise);
    const installing = service.install();
    expect(statfs).toHaveBeenCalledWith(dir);
    change({ channel: 'dev' });
    disk.resolve({ type: 0, bsize: 4096, frsize: 4096, blocks: 1_000_000, bfree: 1_000_000, bavail: 1_000_000, files: 0, ffree: 0 });
    expect(await installing).toMatchObject({ channel: 'dev', status: 'idle', latest: null });
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
  });

  it('切换时尚未读完的缓存不会恢复已下载状态', async () => {
    const stable = release('v2.0.0', 'github');
    const fetch = mockFetch((url) => url.pathname.endsWith('/latest') ? Response.json(stable) : sums(stable));
    const dir = await testDir();
    const file = join(dir, stable.assets[0]!.name);
    await writeFile(file, payload);
    const info = await stat(file);
    const cached = deferred<Stats>();
    vi.mocked(stat).mockImplementationOnce(() => cached.promise as ReturnType<typeof stat>);
    const { service, change } = updater({}, '1.0.0', dir, true);
    await service.check(true);
    const pending = service.download();
    await vi.waitFor(() => expect(vi.mocked(stat)).toHaveBeenCalledTimes(2));
    change({ channel: 'dev' });
    cached.resolve(info);
    expect(await pending).toMatchObject({ channel: 'dev', status: 'idle', latest: null, checkedAt: null });
    expect(await service.install()).toMatchObject({ status: 'idle' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
