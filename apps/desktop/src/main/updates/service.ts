// 自动更新（docs/decisions.md“自动更新”，用户 2026-11-14 授权的对“应用不联网”的第二个例外）。
//
// 边界（全部写死在这个文件里）：
// - 只在主进程发起，用 Node 的 fetch；渲染进程的会话级网络拦截、CSP 和 1.6 的其余各条都不动。
// - 只用 https、默认端口；主机只认 GitHub 和 GitCode 的 API、下载地址和它们的文件 CDN，重定向逐跳过白名单。
// - 请求只带固定的 User-Agent 和 Accept，不带任何用户信息、设备标识或令牌。
// - 只读本仓库已发布的 Release：正式版优先用 releases/latest，其他情况最多查 5 页 releases。不跨渠道回退。
// - 安装包先写临时文件，按同一个 Release 里的 SHA256SUMS.txt 校验 SHA-256 和大小后才改名；校验和缺失就不装。
// - 安装：Windows 静默运行 NSIS 安装包（--updated /S --force-run）后退出；macOS 打开 dmg 后退出，由用户拖进“应用程序”。
// - 只有打包后的应用会自动检查；未打包的构建（开发、e2e）只在手动检查时联网，也不安装。
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import {
  CHECKSUMS_ASSET,
  INSTALL_TEMP_SPACE_MB,
  ReleaseJsonSchema,
  UPDATE_REPO,
  assetPattern,
  channelVersion,
  compareVersions,
  otherSource,
  parseChecksums,
  resolveUpdateSource,
  staleDownload,
  type ReleaseJson,
  type UpdateChannel,
  type UpdateErrorCode,
  type UpdatePrefs,
  type UpdateRelease,
  type UpdateSource,
  type UpdateState,
} from '../../shared/updates';
import type { Logger } from '../logger';

const RELEASE_API: Record<UpdateSource, string> = {
  github: `https://api.github.com/repos/${UPDATE_REPO}/releases`,
  gitcode: `https://api.gitcode.com/api/v5/repos/${UPDATE_REPO}/releases`,
};

const RELEASES_PER_PAGE = 20;
const MAX_RELEASE_PAGES = 5;
const ReleasePageSchema = z.array(z.unknown()).max(RELEASES_PER_PAGE);
const EXACT_HOSTS = new Set(['api.github.com', 'github.com', 'api.gitcode.com', 'gitcode.com']);
const HOST_SUFFIXES = ['.githubusercontent.com', '.gitcode.com'];

const USER_AGENT = 'AllayMotion-Updater';
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_INSTALLER_BYTES = 1024 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;

/** 启动后多久第一次自动检查；之后每隔多久再查 */
const FIRST_CHECK_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const TICK_MS = 30 * 60 * 1000;

class UpdateError extends Error {
  override name = 'UpdateError';
  constructor(readonly code: UpdateErrorCode, message: string) {
    super(message);
  }
}

export function checkUpdateUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UpdateError('network', 'invalid url');
  }
  const host = url.hostname.toLowerCase();
  const allowed = EXACT_HOSTS.has(host) || HOST_SUFFIXES.some((s) => host.endsWith(s));
  if (url.protocol !== 'https:' || !allowed || url.port !== '' || url.username !== '' || url.password !== '') {
    throw new UpdateError('network', `host not allowed: ${host}`);
  }
  return url;
}

/** 日志里只记主机和路径，不记查询参数（GitCode 的 CDN 地址带一次性签名） */
function short(url: URL): string {
  return `${url.host}${url.pathname.length > 80 ? `${url.pathname.slice(0, 80)}…` : url.pathname}`;
}

async function request(raw: string, accept: string, signal: AbortSignal): Promise<Response> {
  let url = checkUpdateUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    signal.throwIfAborted();
    let res: Response;
    try {
      res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: accept }, redirect: 'manual', signal });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new UpdateError('network', `request failed: ${short(url)}`);
    }
    if (signal.aborted) {
      await res.body?.cancel();
      signal.throwIfAborted();
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      await res.body?.cancel();
      if (!location) throw new UpdateError('network', 'redirect without location');
      url = checkUpdateUrl(new URL(location, url).toString());
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new UpdateError(res.status === 404 ? 'no-release' : 'network', `HTTP ${res.status}: ${short(url)}`);
    }
    return res;
  }
  throw new UpdateError('network', 'too many redirects');
}

async function readText(res: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? Number.NaN);
  if (declared > maxBytes) {
    await res.body?.cancel();
    throw new UpdateError('network', 'response too large');
  }
  if (!res.body) return '';
  const chunks: Buffer[] = [];
  let size = 0;
  const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0], { signal });
  for await (const chunk of body) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new UpdateError('network', 'response too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

async function readReleaseJson(url: string, signal: AbortSignal): Promise<unknown> {
  const text = await readText(await request(url, 'application/json', signal), MAX_JSON_BYTES, signal);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new UpdateError('no-release', 'release is not JSON');
  }
}

function releaseForChannel(raw: unknown, source: UpdateSource, channel: UpdateChannel): { version: string; data: ReleaseJson } | null {
  const parsed = ReleaseJsonSchema.safeParse(raw);
  if (!parsed.success || parsed.data.draft) return null;
  const data = parsed.data;
  const version = channelVersion(data.tag_name, channel);
  if (!version || (channel === 'main' ? data.prerelease : source === 'github' && data.prerelease !== true)) return null;
  return { version, data };
}

async function latestRelease(source: UpdateSource, channel: UpdateChannel, session: AbortSignal) {
  const base = RELEASE_API[source];
  const signal = AbortSignal.any([session, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
  if (channel === 'main') {
    try {
      const latest = releaseForChannel(await readReleaseJson(`${base}/latest`, signal), source, channel);
      if (latest) return latest;
    } catch (error) {
      if (!(error instanceof UpdateError) || error.code !== 'no-release') throw error;
    }
  }
  let best: ReturnType<typeof releaseForChannel> = null;
  for (let page = 1; page <= MAX_RELEASE_PAGES; page++) {
    const list = ReleasePageSchema.safeParse(await readReleaseJson(`${base}?per_page=${RELEASES_PER_PAGE}&page=${page}`, signal));
    if (!list.success) throw new UpdateError('no-release', 'unexpected release list format');
    for (const row of list.data) {
      const candidate = releaseForChannel(row, source, channel);
      if (candidate && (!best || compareVersions(candidate.version, best.version) > 0)) best = candidate;
    }
    if (list.data.length < RELEASES_PER_PAGE) break;
  }
  if (!best) throw new UpdateError('no-release', `no published release for channel: ${channel}`);
  return best;
}

/** 所在磁盘的可用字节数；查不到时为 null */
async function freeBytes(dir: string): Promise<number | null> {
  try {
    const s = await statfs(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

async function sha256File(file: string, signal: AbortSignal): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file, { signal })) h.update(chunk as Buffer);
  return h.digest('hex');
}

interface FoundRelease {
  release: UpdateRelease;
  assetUrl: string;
  sha256: string;
}

export interface UpdateServiceOptions {
  currentVersion: string;
  packaged: boolean;
  /** userData/updates */
  downloadDir: string;
  platform: string;
  arch: string;
  timeZone: string | undefined;
  prefs(): UpdatePrefs;
  log: Logger;
  onChanged(state: UpdateState): void;
  /** 安装包已经启动（或 dmg 已经打开）：退出应用 */
  quit(): void;
  /** macOS：用系统默认程序打开 dmg；返回错误信息，成功时为空串 */
  openPath(path: string): Promise<string>;
  /** 系统临时文件夹（os.tmpdir()） */
  tempDir: string;
  /**
   * Windows：系统临时文件夹所在磁盘不够安装用时，改让安装程序用这个文件夹当临时文件夹（安装目录旁边，在安装盘上）。
   * 未打包或不是 Windows 时为 null
   */
  fallbackTempDir: string | null;
}

export class UpdateService {
  private state: UpdateState;
  private found: FoundRelease | null = null;
  private downloadedFile: string | null = null;
  private session = new AbortController();
  private checking: Promise<UpdateState> | null = null;
  private downloadAbort: AbortController | null = null;
  private downloadTask: Promise<UpdateState> | null = null;
  private cleanup: Promise<void> | null = null;
  private installing: AbortSignal | null = null;
  private timers: NodeJS.Timeout[] = [];
  private prefsTimer: NodeJS.Timeout | null = null;
  private ignoredSkip: string | null = null;

  constructor(private readonly o: UpdateServiceOptions) {
    const supported = assetPattern(o.platform, o.arch) !== null;
    this.state = {
      status: supported ? 'idle' : 'unsupported',
      currentVersion: o.currentVersion,
      channel: o.prefs().channel,
      preferredSource: resolveUpdateSource(o.prefs().source, o.timeZone),
      latest: null,
      progress: null,
      error: null,
      checkedAt: null,
      announce: false,
    };
  }

  get current(): UpdateState {
    return { ...this.state, preferredSource: resolveUpdateSource(this.o.prefs().source, this.o.timeZone) };
  }

  private set(patch: Partial<UpdateState>): UpdateState {
    this.state = { ...this.state, announce: false, ...patch };
    const s = this.current;
    this.o.onChanged(s);
    return s;
  }

  /** 打包后的应用：启动一会儿后检查一次，之后定时检查（设置为 off 时跳过） */
  start(): void {
    this.cleanup ??= this.cleanUp();
    if (!this.o.packaged || this.state.status === 'unsupported') return;
    this.timers.push(setTimeout(() => void this.autoCheck(), FIRST_CHECK_DELAY_MS));
    this.timers.push(setInterval(() => void this.autoCheck(), TICK_MS));
  }

  /** 渠道切换丢弃旧结果；启用自动检查或切换渠道时尽快查一次 */
  prefsChanged(prev: UpdatePrefs, next: UpdatePrefs): void {
    const switched = this.state.channel !== next.channel;
    if (switched) {
      this.session.abort();
      this.session = new AbortController();
      this.checking = null;
      this.found = null;
      this.downloadedFile = null;
      this.ignoredSkip = prev.skipVersion === next.skipVersion ? next.skipVersion : null;
      this.set({ channel: next.channel, status: this.state.status === 'unsupported' ? 'unsupported' : 'idle', latest: null, progress: null, error: null, checkedAt: null });
    } else {
      if (prev.skipVersion !== next.skipVersion) this.ignoredSkip = null;
      if (prev.source !== next.source) this.o.onChanged(this.current);
    }
    if (switched || prev.mode !== next.mode) {
      if (this.prefsTimer) clearTimeout(this.prefsTimer);
      this.prefsTimer = null;
    }
    if ((switched || prev.mode === 'off') && next.mode !== 'off' && this.o.packaged && this.state.status !== 'unsupported' && !this.session.signal.aborted) {
      const signal = this.session.signal;
      this.prefsTimer = setTimeout(() => {
        this.prefsTimer = null;
        if (!signal.aborted) void this.autoCheck(true);
      }, 1000);
    }
  }

  /** 启动时清掉用不着的下载（半成品、不比当前新的安装包）和上次安装用过的备用临时文件夹 */
  private async cleanUp(): Promise<void> {
    try {
      for (const name of await readdir(this.o.downloadDir).catch(() => [] as string[])) {
        if (staleDownload(name, this.o.currentVersion)) await rm(join(this.o.downloadDir, name), { force: true });
      }
      // 装完被安装程序重新启动的这一次，临时文件夹可能正是它（环境变量继承下来），不删
      const fallback = this.o.fallbackTempDir;
      if (fallback && fallback.toLowerCase() !== this.o.tempDir.toLowerCase()) await rm(fallback, { recursive: true, force: true });
    } catch (error) {
      this.o.log.warn('updates', 'clean up failed', { error: String(error) });
    }
  }

  /**
   * Windows 安装程序用哪个临时文件夹：系统临时文件夹够用就不改；不够时用安装盘上的备用文件夹；都不够时为 null。
   * 返回要传给安装程序的环境变量
   */
  private async installerEnv(signal: AbortSignal): Promise<NodeJS.ProcessEnv | null> {
    const need = INSTALL_TEMP_SPACE_MB * 1024 * 1024;
    const free = await freeBytes(this.o.tempDir);
    signal.throwIfAborted();
    if (free === null || free >= need) return process.env;
    const fallback = this.o.fallbackTempDir;
    if (fallback) {
      try {
        await mkdir(fallback, { recursive: true });
        signal.throwIfAborted();
        const fallbackFree = await freeBytes(fallback);
        signal.throwIfAborted();
        if (fallbackFree !== null && fallbackFree >= need) {
          this.o.log.info('updates', 'temp drive is low, installer uses fallback temp folder', { free, fallbackFree });
          return { ...process.env, TEMP: fallback, TMP: fallback };
        }
      } catch (error) {
        signal.throwIfAborted();
        this.o.log.warn('updates', 'fallback temp folder unusable', { error: String(error) });
      }
    }
    this.o.log.warn('updates', 'not enough temp space to install', { free, need });
    return null;
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    if (this.prefsTimer) clearTimeout(this.prefsTimer);
    this.prefsTimer = null;
    this.session.abort();
  }

  private async autoCheck(force = false): Promise<void> {
    const signal = this.session.signal;
    if (signal.aborted || this.o.prefs().mode === 'off') return;
    if (!force && this.state.checkedAt !== null && Date.now() - this.state.checkedAt < CHECK_INTERVAL_MS) return;
    if (this.state.status === 'downloading' || this.state.status === 'downloaded') return;
    const s = await this.check(false);
    if (signal.aborted || s.status !== 'available' || !s.latest || this.state.status !== 'available' || this.state.latest !== s.latest) return;
    const prefs = this.o.prefs();
    if (prefs.mode === 'off' || this.isSkipped(s.latest.version)) return;
    if (prefs.mode === 'auto') await this.download(true);
    else this.set({ announce: true });
  }

  private isSkipped(version: string): boolean {
    return version !== this.ignoredSkip && version === this.o.prefs().skipVersion;
  }

  /** 检查最新版本。manual 为假时是后台的自动检查 */
  check(manual: boolean): Promise<UpdateState> {
    const session = this.session.signal;
    if (session.aborted) return Promise.resolve(this.current);
    if (this.state.status === 'unsupported') return Promise.resolve(this.current);
    if (this.state.status === 'downloading' || this.state.status === 'downloaded') return Promise.resolve(this.current);
    if (this.checking) return this.checking;
    const channel = this.state.channel;
    const pending = Promise.resolve().then(() => this.runCheck(manual, channel, session)).finally(() => {
      if (this.checking === pending) this.checking = null;
    });
    this.checking = pending;
    this.found = null;
    this.set({ status: 'checking', latest: null, error: null, progress: null });
    return pending;
  }

  private async runCheck(manual: boolean, channel: UpdateChannel, signal: AbortSignal): Promise<UpdateState> {
    if (signal.aborted) return this.current;
    const preferred = resolveUpdateSource(this.o.prefs().source, this.o.timeZone);
    let firstError: UpdateError | null = null;
    for (const source of [preferred, otherSource(preferred)]) {
      try {
        const found = await this.fetchRelease(source, channel, signal);
        if (signal.aborted) return this.current;
        this.found = found;
        const newer = compareVersions(found.release.version, this.o.currentVersion) > 0;
        this.o.log.info('updates', 'checked', { source, latest: found.release.version, current: this.o.currentVersion, manual });
        return this.set({ status: newer ? 'available' : 'up-to-date', latest: found.release, checkedAt: Date.now() });
      } catch (error) {
        if (signal.aborted) return this.current;
        const e = error instanceof UpdateError ? error : new UpdateError('network', String(error));
        this.o.log.warn('updates', 'check failed', { source, code: e.code, message: e.message });
        firstError ??= e;
      }
    }
    return this.set({ status: 'error', error: firstError?.code ?? 'network', checkedAt: Date.now() });
  }

  private async fetchRelease(source: UpdateSource, channel: UpdateChannel, session: AbortSignal): Promise<FoundRelease> {
    const pattern = assetPattern(this.o.platform, this.o.arch);
    if (!pattern) throw new UpdateError('no-asset', 'unsupported platform');
    const { data: r, version } = await latestRelease(source, channel, session);
    const signal = AbortSignal.any([session, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
    const assets = r.assets.filter((a) => a.type !== 'source');
    const asset = assets.find(({ name }) => {
      const suffix = pattern.exec(name);
      return suffix && /^[\w.-]+$/.test(name) && name.slice(0, suffix.index).endsWith(`-${version}`);
    });
    const sums = assets.find((a) => a.name === CHECKSUMS_ASSET);
    if (!asset || !sums) throw new UpdateError('no-asset', `${source} ${r.tag_name} has no installer or checksums yet`);
    checkUpdateUrl(asset.browser_download_url);
    const sumsText = await readText(await request(sums.browser_download_url, 'application/octet-stream', signal), 64 * 1024, signal);
    const sha256 = parseChecksums(sumsText).get(asset.name);
    if (!sha256) throw new UpdateError('checksum', `no checksum for ${asset.name}`);
    return {
      release: {
        version,
        tag: r.tag_name,
        source,
        publishedAt: r.published_at ?? r.created_at ?? null,
        asset: { name: asset.name, size: asset.size ?? 0 },
      },
      assetUrl: asset.browser_download_url,
      sha256,
    };
  }

  /** 下载这台机器的安装包并校验。background 为真时是 auto 模式的后台下载（完成后通知界面） */
  download(background = false): Promise<UpdateState> {
    const session = this.session.signal;
    const found = this.found;
    if (session.aborted || !found || (this.state.status !== 'available' && this.state.status !== 'error')) return Promise.resolve(this.current);
    if (compareVersions(found.release.version, this.o.currentVersion) <= 0) return Promise.resolve(this.current);
    const abort = new AbortController();
    const signal = AbortSignal.any([session, abort.signal]);
    const previous = this.downloadTask;
    const cleanup = this.cleanup ??= this.cleanUp();
    const pending = Promise.resolve().then(async () => {
      await previous;
      await cleanup;
      return this.runDownload(found, background, session, abort, signal);
    }).finally(() => {
      if (this.downloadAbort === abort) this.downloadAbort = null;
      if (this.downloadTask === pending) this.downloadTask = null;
    });
    this.downloadAbort = abort;
    this.downloadTask = pending;
    this.set({ status: 'downloading', error: null, progress: { received: 0, total: found.release.asset.size } });
    return pending;
  }

  private async runDownload(found: FoundRelease, background: boolean, session: AbortSignal, abort: AbortController, signal: AbortSignal): Promise<UpdateState> {
    const dest = join(this.o.downloadDir, found.release.asset.name);
    try {
      signal.throwIfAborted();
      await mkdir(this.o.downloadDir, { recursive: true });
      signal.throwIfAborted();
      // 已经下好、大小和校验都对：不重下
      const cached = await stat(dest).catch(() => null);
      signal.throwIfAborted();
      if (cached?.isFile() && cached.size <= MAX_INSTALLER_BYTES && (!found.release.asset.size || cached.size === found.release.asset.size) && (await sha256File(dest, signal)) === found.sha256) {
        signal.throwIfAborted();
      } else {
        signal.throwIfAborted();
        const free = await freeBytes(this.o.downloadDir);
        signal.throwIfAborted();
        if (free !== null && free < found.release.asset.size + 64 * 1024 * 1024) throw new UpdateError('disk', 'not enough space to download');
        await this.fetchToFile(found, dest, abort, signal);
        signal.throwIfAborted();
      }
      this.downloadedFile = dest;
      this.o.log.info('updates', 'downloaded', { version: found.release.version, source: found.release.source });
      return this.set({ status: 'downloaded', progress: null, announce: background && this.o.prefs().mode === 'auto' && !this.isSkipped(found.release.version) });
    } catch (error) {
      if (session.aborted) return this.current;
      // 空闲超时也走 abort，原因是 UpdateError；用户取消的原因不是
      const reason: unknown = signal.reason;
      if (signal.aborted && !(reason instanceof UpdateError)) {
        this.o.log.info('updates', 'download canceled');
        return this.set({ status: 'available', progress: null });
      }
      const e = reason instanceof UpdateError ? reason : error instanceof UpdateError ? error : new UpdateError('network', String(error));
      this.o.log.warn('updates', 'download failed', { code: e.code, message: e.message });
      return this.set({ status: 'error', error: e.code, progress: null });
    }
  }

  private async fetchToFile(found: FoundRelease, dest: string, abort: AbortController, signal: AbortSignal): Promise<void> {
    const tmp = `${dest}.${randomUUID()}.part`;
    let idle: NodeJS.Timeout | null = null;
    const kick = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => abort.abort(new UpdateError('network', 'idle timeout')), IDLE_TIMEOUT_MS);
    };
    try {
      kick();
      const res = await request(found.assetUrl, 'application/octet-stream', signal);
      const declared = Number(res.headers.get('content-length') ?? Number.NaN);
      const total = found.release.asset.size || (Number.isFinite(declared) ? declared : 0);
      if (total > MAX_INSTALLER_BYTES || declared > MAX_INSTALLER_BYTES) {
        await res.body?.cancel();
        throw new UpdateError('network', 'installer too large');
      }
      if (!res.body) throw new UpdateError('network', 'empty body');
      const hash = createHash('sha256');
      let received = 0;
      let lastProgressAt = 0;
      const meter = new Transform({
        transform: (chunk: Buffer, _enc, done) => {
          received += chunk.length;
          if (received > MAX_INSTALLER_BYTES) {
            done(new UpdateError('network', 'installer too large'));
            return;
          }
          hash.update(chunk);
          kick();
          const now = Date.now();
          if (!signal.aborted && now - lastProgressAt > 250) {
            lastProgressAt = now;
            this.set({ progress: { received, total } });
          }
          done(null, chunk);
        },
      });
      try {
        await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), meter, createWriteStream(tmp, { flags: 'wx' }), { signal });
      } catch (error) {
        if (signal.aborted) throw error;
        if (error instanceof UpdateError) throw error;
        const code = (error as NodeJS.ErrnoException).code;
        throw new UpdateError(code === 'ENOSPC' || code === 'EACCES' || code === 'EPERM' ? 'disk' : 'network', String(error));
      }
      if ((total && received !== total) || hash.digest('hex') !== found.sha256) {
        throw new UpdateError('checksum', 'downloaded installer does not match SHA256SUMS.txt');
      }
      signal.throwIfAborted();
      if (idle) clearTimeout(idle);
      await rename(tmp, dest);
    } finally {
      if (idle) clearTimeout(idle);
      await rm(tmp, { force: true });
    }
  }

  cancel(): void {
    this.downloadAbort?.abort();
  }

  /** 运行下好的安装包并退出应用 */
  async install(): Promise<UpdateState> {
    const signal = this.session.signal;
    const file = this.downloadedFile;
    if (signal.aborted || this.installing || this.state.status !== 'downloaded' || !file) return this.current;
    // 失败时状态留在“已下载”，界面上仍能再点安装
    if (!this.o.packaged) {
      this.o.log.warn('updates', 'install skipped: not packaged');
      return this.set({ error: 'install' });
    }
    this.installing = signal;
    try {
      if (this.o.platform === 'win32') {
        // 临时空间不够时安装程序会装出半截的应用（它自己也会检查并退出，但那时应用已经退出了）：先查，不够就不装
        const env = await this.installerEnv(signal);
        if (signal.aborted) return this.current;
        if (!env) return this.set({ error: 'space' });
        // NSIS（electron-builder）：--updated 按更新处理，/S 静默安装到原来的位置，--force-run 装完重新启动应用
        const child = spawn(file, ['--updated', '/S', '--force-run'], { detached: true, stdio: 'ignore', env });
        child.unref();
      } else {
        const error = await this.o.openPath(file);
        if (signal.aborted) return this.current;
        if (error) throw new Error(error);
      }
    } catch (error) {
      if (signal.aborted) return this.current;
      this.o.log.error('updates', 'install failed', { error: String(error) });
      return this.set({ error: 'install' });
    } finally {
      this.installing = null;
    }
    this.o.log.info('updates', 'installing, quitting', { version: this.state.latest?.version });
    this.o.quit();
    return this.current;
  }
}
