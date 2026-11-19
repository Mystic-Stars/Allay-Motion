// 从 Mojang 官方服务器下载最新正式版的客户端 jar（用户批准的、对“应用不联网”的唯一例外，见 decisions.md M2a）。
//
// 边界（全部写死在这个文件里）：
// - 只在主进程发起；只用 https；只访问 MOJANG_HOSTS 里的三个主机；拒绝任何重定向；不带自定义请求头、不带用户信息。
// - 只有用户明确要求查询版本、下载或取音效才联网；缓存枚举完全离线。
// - 下载先写临时文件，校验 sha1 和大小通过后才改名；有大小上限和空闲超时；可用 AbortSignal 取消，取消或失败不留半成品。
// - 存放在应用数据目录下的固定位置（cacheDir，由调用方传入 userData/vanilla-cache），jar 整体保留、按需读取条目。
// - 测试注入：testOrigins 把白名单主机映射到本机的假服务器，只在未打包的构建里允许；packaged 为 true 时传入就报错。
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { join } from 'node:path';
import { z } from 'zod';
import { expandSoundEvent, mergeSoundDefinitions, parseSoundsJson, soundNameToPaths } from '@allay/assets';
import { OfficialVersionIdSchema, type OfficialVersion } from '../../shared/resources';
import { INDEXED_FONT_LIMITS, type VanillaInstall } from './vanilla';

export const MOJANG_HOSTS = ['piston-meta.mojang.com', 'piston-data.mojang.com', 'resources.download.minecraft.net'] as const;
export const VERSION_MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
export const RESOURCES_BASE = 'https://resources.download.minecraft.net';

export interface DownloadLimits {
  /** 清单、版本 JSON、资源索引 */
  jsonBytes: number;
  jarBytes: number;
  objectBytes: number;
  /** 多久收不到数据就放弃 */
  idleTimeoutMs: number;
}

export const DEFAULT_LIMITS: DownloadLimits = {
  jsonBytes: 16 * 1024 * 1024,
  jarBytes: 256 * 1024 * 1024,
  objectBytes: 64 * 1024 * 1024,
  idleTimeoutMs: 30_000,
};

export type DownloadErrorCode = 'host' | 'redirect' | 'status' | 'size' | 'hash' | 'timeout' | 'aborted' | 'network' | 'bad-data';

export class DownloadError extends Error {
  override name = 'DownloadError';
  constructor(
    message: string,
    readonly code: DownloadErrorCode,
  ) {
    super(message);
  }
}

/**
 * 下载器上报的进度（经 DownloadProgressSchema 校验后交给 DownloadTracker，docs/decisions.md 界面增强）。
 * received / total 是这一个文件的字节数；另外几个可选字段：
 * - versionId、plan：读到版本 JSON 之后，jar 和资源索引的大小（整体进度按字节算要用）；
 * - cached：这个文件已在缓存里且校验通过，没有下载；
 * - items：音效对象的文件计数；全景、字体以各自去重后的累计字节上报。
 */
const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const DownloadProgressSchema = z.strictObject({
  phase: z.enum(['manifest', 'version', 'jar', 'index', 'panorama', 'fonts', 'object']),
  received: Count,
  total: Count.nullable(),
  versionId: z.string().max(64).optional(),
  plan: z.strictObject({ jarBytes: Count, indexBytes: Count }).optional(),
  cached: z.literal(true).optional(),
  items: z.strictObject({ done: Count, total: Count }).optional(),
});
export type DownloadProgress = z.infer<typeof DownloadProgressSchema>;

export interface DownloaderOptions {
  /** userData/vanilla-cache */
  cacheDir: string;
  /** app.isPackaged。打包后不允许 testOrigins */
  packaged: boolean;
  /** 只给测试用：白名单主机 → 本机假服务器的 origin（http://127.0.0.1:端口） */
  testOrigins?: Readonly<Record<string, string>>;
  limits?: Partial<DownloadLimits>;
}

export interface CachedVanilla extends VanillaInstall {
  source: 'downloaded';
}

const Sha1 = z.string().regex(/^[0-9a-f]{40}$/);

/** 资源索引（只用到 objects） */
const AssetObjectSchema = z.looseObject({ hash: Sha1, size: z.number().int().nonnegative() });
const AssetIndexSchema = z.looseObject({ objects: z.record(z.string(), AssetObjectSchema) });
const IndexedObjectsSchema = z.object({ objects: z.record(z.string(), z.unknown()) });
const PANORAMA_KEYS = Array.from({ length: 6 }, (_, face) => `minecraft/textures/gui/title/background/panorama_${face}.png`);
const SafeId = OfficialVersionIdSchema;

const ManifestSchema = z.looseObject({
  latest: z.looseObject({ release: SafeId }),
  // 清单里有 "3D Shareware v1.34" 这类带空格的老版本 id；这里只要求是字符串，选中的那一个再按 SafeId 校验
  versions: z.array(z.looseObject({ id: z.string(), type: z.string(), url: z.string(), sha1: Sha1.optional(), releaseTime: z.string().optional() })),
});

const VersionSchema = z.looseObject({
  id: SafeId,
  type: z.string(),
  releaseTime: z.string(),
  downloads: z.looseObject({ client: z.looseObject({ url: z.string(), sha1: Sha1, size: z.number().int().positive() }) }),
  assetIndex: z.looseObject({ id: SafeId, url: z.string(), sha1: Sha1, size: z.number().int().positive() }).optional(),
});
type VersionJson = z.infer<typeof VersionSchema>;
type DownloadOptions = { signal?: AbortSignal; onProgress?: (p: DownloadProgress) => void; includePanorama?: boolean; includeFonts?: boolean };

/** 校验逻辑 URL：https、白名单主机、默认端口、不带用户信息 */
export function checkMojangUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DownloadError(`不是合法的 URL：${raw}`, 'host');
  }
  if (url.protocol !== 'https:') throw new DownloadError(`只允许 https：${raw}`, 'host');
  if (!(MOJANG_HOSTS as readonly string[]).includes(url.hostname)) throw new DownloadError(`主机不在白名单里：${url.hostname}`, 'host');
  if (url.port !== '' || url.username !== '' || url.password !== '') throw new DownloadError(`URL 不能带端口或用户信息：${raw}`, 'host');
  return url;
}

async function sha1File(file: string): Promise<string> {
  const h = createHash('sha1');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

async function fileMatches(file: string, size: number, sha1: string): Promise<boolean> {
  const st = await stat(file).catch(() => null);
  if (!st || !st.isFile() || st.size !== size) return false;
  return (await sha1File(file)) === sha1;
}

export function createVanillaDownloader(options: DownloaderOptions) {
  if (options.testOrigins && options.packaged) throw new Error('打包后的应用不允许替换下载地址');
  const limits: DownloadLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const { cacheDir } = options;
  const versionsDir = join(cacheDir, 'versions');
  const indexesDir = join(cacheDir, 'indexes');
  const objectsDir = join(cacheDir, 'objects');

  /** 逻辑 URL（已过白名单）→ 实际请求的 URL（测试时换成本机假服务器） */
  function physical(url: URL): URL {
    const origin = options.testOrigins?.[url.hostname];
    if (!origin) return url;
    return new URL(`${url.pathname}${url.search}`, origin);
  }

  function open(raw: string, signal: AbortSignal | undefined): Promise<IncomingMessage> {
    const target = physical(checkMojangUrl(raw));
    const client = target.protocol === 'http:' && options.testOrigins ? http : https;
    if (target.protocol !== 'https:' && !options.testOrigins) throw new DownloadError('只允许 https', 'host');
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DownloadError('已取消', 'aborted'));
        return;
      }
      // 不加任何自定义请求头（没有 User-Agent、没有标识）
      const req = client.get(target, { signal }, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          reject(new DownloadError(`拒绝重定向（${status}）：${raw}`, 'redirect'));
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new DownloadError(`HTTP ${status}：${raw}`, 'status'));
          return;
        }
        resolve(res);
      });
      req.setTimeout(limits.idleTimeoutMs, () => req.destroy(new DownloadError(`超时：${raw}`, 'timeout')));
      req.on('error', (err) => reject(signal?.aborted ? new DownloadError('已取消', 'aborted') : err instanceof DownloadError ? err : new DownloadError(err.message, 'network')));
    });
  }

  /** 下载到 dest：先写临时文件，校验大小和 sha1 后改名。任何失败都删掉临时文件 */
  async function fetchToFile(
    raw: string,
    dest: string,
    expect: { size?: number; sha1?: string; maxBytes: number; phase: DownloadProgress['phase'] },
    signal: AbortSignal | undefined,
    onProgress: ((p: DownloadProgress) => void) | undefined,
  ): Promise<void> {
    if (expect.size !== undefined && expect.size > expect.maxBytes) throw new DownloadError(`文件太大（${expect.size} 字节）：${raw}`, 'size');
    await mkdir(join(dest, '..'), { recursive: true });
    const tmp = `${dest}.${randomUUID()}.part`;
    try {
      const res = await open(raw, signal);
      const declared = Number(res.headers['content-length'] ?? Number.NaN);
      if (Number.isFinite(declared) && declared > expect.maxBytes) {
        res.destroy();
        throw new DownloadError(`文件太大（${declared} 字节）：${raw}`, 'size');
      }
      const hash = createHash('sha1');
      let received = 0;
      const out = createWriteStream(tmp, { flags: 'wx' });
      try {
        res.setTimeout(limits.idleTimeoutMs, () => res.destroy(new DownloadError(`超时：${raw}`, 'timeout')));
        for await (const chunk of res as AsyncIterable<Buffer>) {
          received += chunk.length;
          if (received > expect.maxBytes || (expect.size !== undefined && received > expect.size)) {
            res.destroy();
            throw new DownloadError(`收到的数据超过上限：${raw}`, 'size');
          }
          hash.update(chunk);
          if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
          onProgress?.({ phase: expect.phase, received, total: expect.size ?? (Number.isFinite(declared) ? declared : null) });
        }
      } finally {
        await new Promise<void>((r) => out.end(() => r()));
      }
      if (signal?.aborted) throw new DownloadError('已取消', 'aborted');
      if (expect.size !== undefined && received !== expect.size) throw new DownloadError(`大小不符（${received} ≠ ${expect.size}）：${raw}`, 'size');
      if (expect.sha1 !== undefined && hash.digest('hex') !== expect.sha1) throw new DownloadError(`sha1 不符：${raw}`, 'hash');
      await rename(tmp, dest);
    } catch (err) {
      await rm(tmp, { force: true });
      if (signal?.aborted && !(err instanceof DownloadError && err.code === 'aborted')) throw new DownloadError('已取消', 'aborted');
      if (err instanceof DownloadError) throw err;
      throw new DownloadError((err as Error).message, 'network');
    }
  }

  async function fetchJson(raw: string, signal: AbortSignal | undefined, sha1?: string, size?: number): Promise<{ data: unknown; bytes: Buffer }> {
    const res = await open(raw, signal);
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for await (const chunk of res as AsyncIterable<Buffer>) {
        total += chunk.length;
        if (total > limits.jsonBytes) {
          res.destroy();
          throw new DownloadError(`JSON 太大：${raw}`, 'size');
        }
        chunks.push(chunk);
      }
    } catch (err) {
      if (signal?.aborted) throw new DownloadError('已取消', 'aborted');
      throw err instanceof DownloadError ? err : new DownloadError((err as Error).message, 'network');
    }
    const bytes = Buffer.concat(chunks, total);
    if (size !== undefined && bytes.length !== size) throw new DownloadError(`大小不符：${raw}`, 'size');
    if (sha1 !== undefined && createHash('sha1').update(bytes).digest('hex') !== sha1) throw new DownloadError(`sha1 不符：${raw}`, 'hash');
    try {
      return { data: JSON.parse(bytes.toString('utf8')) as unknown, bytes };
    } catch {
      throw new DownloadError(`不是合法的 JSON：${raw}`, 'bad-data');
    }
  }

  function toInstall(v: VersionJson): CachedVanilla {
    const dir = join(versionsDir, v.id);
    return {
      source: 'downloaded',
      gameDir: cacheDir,
      versionId: v.id,
      versionType: v.type,
      releaseTime: v.releaseTime,
      jarPath: join(dir, 'client.jar'),
      assetIndexPath: v.assetIndex ? join(indexesDir, `${v.assetIndex.id}-${v.assetIndex.sha1}.json`) : null,
      ...(v.assetIndex ? { assetIndexSha1: v.assetIndex.sha1, assetIndexSize: v.assetIndex.size } : {}),
      cacheVersionFile: join(dir, 'version.json'),
      objectsDir,
    };
  }

  async function readCachedVersion(id: string): Promise<VersionJson | null> {
    const file = join(versionsDir, id, 'version.json');
    const meta = await stat(file).catch(() => null);
    if (!meta?.isFile() || meta.size > limits.jsonBytes) return null;
    const raw = await readFile(file, 'utf8').catch(() => null);
    if (raw === null) return null;
    try {
      const parsed = VersionSchema.safeParse(JSON.parse(raw));
      return parsed.success && parsed.data.id === id ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async function completeInstall(v: VersionJson): Promise<CachedVanilla | null> {
    const inst = toInstall(v);
    if (v.downloads.client.size > limits.jarBytes || !(await fileMatches(inst.jarPath, v.downloads.client.size, v.downloads.client.sha1))) return null;
    if (!v.assetIndex || !inst.assetIndexPath) return inst;
    if (v.assetIndex.size > limits.jsonBytes) return null;
    const indexPath = await cachedIndexPath(v.assetIndex, inst.assetIndexPath);
    return indexPath ? { ...inst, assetIndexPath: indexPath } : null;
  }

  async function cachedIndexPath(index: NonNullable<VersionJson['assetIndex']>, path: string): Promise<string | null> {
    if (await fileMatches(path, index.size, index.sha1)) return path;
    const legacy = join(indexesDir, `${index.id}.json`);
    return await fileMatches(legacy, index.size, index.sha1) ? legacy : null;
  }

  async function listCached(): Promise<CachedVanilla[]> {
    const ids = await readdir(versionsDir).catch(() => [] as string[]);
    const found: CachedVanilla[] = [];
    for (const id of ids) {
      if (!SafeId.safeParse(id).success) continue;
      const v = await readCachedVersion(id);
      if (v?.type !== 'release' || !Number.isFinite(Date.parse(v.releaseTime))) continue;
      const install = await completeInstall(v).catch(() => null);
      if (install) found.push(install);
    }
    return found.sort((left, right) => Date.parse(right.releaseTime) - Date.parse(left.releaseTime) || left.versionId.localeCompare(right.versionId));
  }

  async function readManifest(signal?: AbortSignal) {
    const manifest = ManifestSchema.safeParse((await fetchJson(VERSION_MANIFEST_URL, signal)).data);
    if (!manifest.success) throw new DownloadError('版本清单格式不对', 'bad-data');
    return manifest.data;
  }

  /**
   * 联网（按需）：从 resources.download.minecraft.net 取一个资源对象到 objects/<前两位>/<哈希>，校验 sha1 和大小。
   * 已存在且校验通过时不联网。返回文件路径。
   */
  async function fetchObject(hash: string, size: number, signal?: AbortSignal, onProgress?: DownloadOptions['onProgress']): Promise<string> {
    if (!Sha1.safeParse(hash).success) throw new DownloadError(`哈希格式不对：${hash}`, 'bad-data');
    if (signal?.aborted) throw new DownloadError('已取消', 'aborted');
    if (size > limits.objectBytes) throw new DownloadError(`资源对象太大（${size} 字节）`, 'size');
    const dest = join(objectsDir, hash.slice(0, 2), hash);
    if (await fileMatches(dest, size, hash)) {
      onProgress?.({ phase: 'object', received: size, total: size, cached: true });
      return dest;
    }
    await fetchToFile(`${RESOURCES_BASE}/${hash.slice(0, 2)}/${hash}`, dest, { size, sha1: hash, maxBytes: limits.objectBytes, phase: 'object' }, signal, onProgress);
    return dest;
  }

  async function verifiedIndexObjects(indexPath: string, index: NonNullable<VersionJson['assetIndex']>): Promise<Record<string, unknown>> {
    if ((await stat(indexPath)).size !== index.size) throw new DownloadError('资源索引大小不符', 'size');
    const bytes = await readFile(indexPath);
    if (bytes.length !== index.size || createHash('sha1').update(bytes).digest('hex') !== index.sha1) {
      throw new DownloadError('资源索引校验失败', 'hash');
    }
    let raw: unknown;
    try { raw = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')) as unknown; }
    catch { throw new DownloadError('资源索引不是合法的 JSON', 'bad-data'); }
    const parsed = IndexedObjectsSchema.safeParse(raw);
    if (!parsed.success) throw new DownloadError('资源索引格式不对', 'bad-data');
    return parsed.data.objects;
  }

  async function fetchIndexedObjects(
    objects: Record<string, unknown>, keys: Iterable<string>, phase: 'panorama' | 'fonts',
    { signal, onProgress }: DownloadOptions, maxBytes: (key: string) => number = () => limits.objectBytes,
  ): Promise<void> {
    const present = [...keys].filter((key) => Object.hasOwn(objects, key));
    if (!present.length) return;
    onProgress?.({ phase, received: 0, total: null });
    const wanted = new Map<string, number>();
    for (const key of present) {
      const object = AssetObjectSchema.safeParse(objects[key]);
      if (!object.success || object.data.size === 0) throw new DownloadError(`资源索引条目无效：${key}`, 'bad-data');
      const { hash, size } = object.data;
      if (size > Math.min(limits.objectBytes, maxBytes(key))) throw new DownloadError(`资源对象超过大小上限：${key}`, 'size');
      if (wanted.has(hash) && wanted.get(hash) !== size) throw new DownloadError(`资源对象大小冲突：${key}`, 'bad-data');
      wanted.set(hash, size);
    }
    const total = [...wanted.values()].reduce((sum, size) => sum + size, 0);
    let received = 0;
    onProgress?.({ phase, received, total });
    for (const [hash, size] of wanted) {
      await fetchObject(hash, size, signal, (progress) => onProgress?.({
        phase, received: received + progress.received, total, ...(progress.cached ? { cached: true } : {}),
      }));
      received += size;
    }
  }

  return {
    cacheDir,
    listCached,

    async listOfficialReleases(): Promise<OfficialVersion[]> {
      const manifest = await readManifest();
      return manifest.versions.filter((entry) => entry.type === 'release' && entry.sha1 && SafeId.safeParse(entry.id).success)
        .map((entry) => ({ versionId: entry.id, releaseTime: entry.releaseTime ?? null }));
    },

    /** 离线：已下载且校验通过的版本里取 releaseTime 最新的；没有返回 null。不联网 */
    async findCached(): Promise<CachedVanilla | null> {
      return (await listCached())[0] ?? null;
    },

    /**
     * 联网：取版本清单 → 最新 release → 版本 JSON → 客户端 jar 和资源索引。应用主动下载时一并取索引中的全景和字体。
     * 只应在用户明确同意后调用。
     */
    downloadLatest(opts: DownloadOptions = {}): Promise<CachedVanilla> {
      return downloadRelease(undefined, opts);
    },

    downloadRelease,

    /** 只在用户明确触发的下载中取回常用音效。 */
    fetchSoundObjects,
    fetchObject,
  };

  async function downloadRelease(versionId: string | undefined, opts: DownloadOptions = {}): Promise<CachedVanilla> {
      const { signal, onProgress } = opts;
      onProgress?.({ phase: 'manifest', received: 0, total: null, ...(versionId ? { versionId } : {}) });
      const manifest = await readManifest(signal);
      const entry = manifest.versions.find((v) => v.id === (versionId ?? manifest.latest.release) && v.type === 'release');
      if (!entry || !SafeId.safeParse(entry.id).success || !entry.sha1) throw new DownloadError('版本清单里找不到指定的正式版', 'bad-data');
      onProgress?.({ phase: 'version', received: 0, total: null });
      const { data, bytes } = await fetchJson(entry.url, signal, entry.sha1);
      const version = VersionSchema.safeParse(data);
      if (!version.success || version.data.id !== entry.id || version.data.type !== 'release' || !Number.isFinite(Date.parse(version.data.releaseTime))) throw new DownloadError('版本 JSON 格式不对', 'bad-data');
      const v = version.data;
      let inst = toInstall(v);
      const dir = join(versionsDir, v.id);
      onProgress?.({ phase: 'version', received: bytes.length, total: bytes.length, versionId: v.id, plan: { jarBytes: v.downloads.client.size, indexBytes: v.assetIndex?.size ?? 0 } });
      await mkdir(dir, { recursive: true });
      onProgress?.({ phase: 'jar', received: 0, total: v.downloads.client.size });
      if (!(await fileMatches(inst.jarPath, v.downloads.client.size, v.downloads.client.sha1))) {
        await fetchToFile(v.downloads.client.url, inst.jarPath, { size: v.downloads.client.size, sha1: v.downloads.client.sha1, maxBytes: limits.jarBytes, phase: 'jar' }, signal, onProgress);
      } else onProgress?.({ phase: 'jar', received: v.downloads.client.size, total: v.downloads.client.size, cached: true });
      if (v.assetIndex && inst.assetIndexPath) {
        if (v.assetIndex.size > limits.jsonBytes) throw new DownloadError('资源索引超过大小上限', 'size');
        onProgress?.({ phase: 'index', received: 0, total: v.assetIndex.size });
        const dest = inst.assetIndexPath;
        const cached = await cachedIndexPath(v.assetIndex, dest);
        if (!cached) {
          await fetchToFile(v.assetIndex.url, dest, { size: v.assetIndex.size, sha1: v.assetIndex.sha1, maxBytes: limits.jsonBytes, phase: 'index' }, signal, onProgress);
        } else {
          inst = { ...inst, assetIndexPath: cached };
          onProgress?.({ phase: 'index', received: v.assetIndex.size, total: v.assetIndex.size, cached: true });
        }
        if (opts.includePanorama || opts.includeFonts) {
          const objects = await verifiedIndexObjects(cached ?? dest, v.assetIndex);
          if (opts.includePanorama) await fetchIndexedObjects(objects, PANORAMA_KEYS, 'panorama', opts);
          if (opts.includeFonts) await fetchIndexedObjects(objects, INDEXED_FONT_LIMITS.keys(), 'fonts', opts, (key) => INDEXED_FONT_LIMITS.get(key)!);
        }
      }
      if (signal?.aborted) throw new DownloadError('已取消', 'aborted');
      // 版本 JSON 最后写：它在，表示这一版完整（findCached 仍会再校验）
      const tmp = join(dir, `version.json.${randomUUID()}.part`);
      try {
        await writeFile(tmp, bytes, { flag: 'wx' });
        await rename(tmp, join(dir, 'version.json'));
      } catch (err) {
        await rm(tmp, { force: true });
        throw err;
      }
      return inst;
  }

    /**
     * 联网：取回给定音效事件用到的资源对象（minecraft/sounds.json，以及这些事件全部变体的 .ogg），
     * 每个对象都经 fetchObject（同一白名单、同样校验 sha1 和大小）。已在缓存里且校验通过的不重复下载。
     * 只在用户点了“下载原版资源”时、紧接着 downloadLatest() 调用（decisions.md M6b：不做后台按需联网）。
     * 返回资源索引里找不到的事件或文件（例如 allay: 命名空间的事件），调用方只记日志。
     */
    async function fetchSoundObjects(
      install: CachedVanilla,
      eventIds: readonly string[],
      opts: { signal?: AbortSignal; onProgress?: (p: DownloadProgress) => void } = {},
    ): Promise<{ fetched: number; missing: string[] }> {
      const missing: string[] = [];
      if (!install.assetIndexPath) return { fetched: 0, missing: [...eventIds] };
      const index = AssetIndexSchema.safeParse(JSON.parse(await readFile(install.assetIndexPath, 'utf8')));
      if (!index.success) throw new DownloadError('资源索引格式不对', 'bad-data');
      const objects = index.data.objects;
      const soundsJson = objects['minecraft/sounds.json'];
      if (!soundsJson) return { fetched: 0, missing: [...eventIds] };
      opts.onProgress?.({ phase: 'object', received: 0, total: null });
      const soundsFile = await fetchObject(soundsJson.hash, soundsJson.size, opts.signal);
      const wanted = new Map<string, { hash: string; size: number }>();
      const defs = mergeSoundDefinitions([{ kind: 'vanilla', parsed: parseSoundsJson(await readFile(soundsFile, 'utf8'), 'minecraft') }]);
      for (const eventId of eventIds) {
        const variants = expandSoundEvent(defs, eventId);
        if (variants.length === 0) missing.push(eventId);
        for (const v of variants) {
          // 资源索引的键是 assets/ 之后的部分（minecraft/sounds/dig/stone1.ogg）
          const key = soundNameToPaths(v.file)
            .map((p) => p.slice('assets/'.length))
            .find((k) => objects[k] !== undefined);
          if (!key) missing.push(v.file);
          else wanted.set(key, objects[key]!);
        }
      }
      const total = [...wanted.values()].reduce((s, o) => s + o.size, 0);
      let received = 0;
      let done = 0;
      opts.onProgress?.({ phase: 'object', received, total, items: { done, total: wanted.size } });
      for (const obj of wanted.values()) {
        await fetchObject(obj.hash, obj.size, opts.signal);
        received += obj.size;
        done += 1;
        opts.onProgress?.({ phase: 'object', received, total, items: { done, total: wanted.size } });
      }
      return { fetched: wanted.size + 1, missing };
    }
}

export type VanillaDownloader = ReturnType<typeof createVanillaDownloader>;

export type VanillaPreference = 'newest' | 'local' | 'downloaded';

export interface VanillaChoice {
  /** local：用本机已装的游戏；cached：用已下载的；needs-download：两者都没有，调用方可以征求同意后下载 */
  status: 'local' | 'cached' | 'needs-download';
  install: VanillaInstall | null;
}

/**
 * 原版层的来源二选一：本机已装游戏的 jar，或下载缓存的 jar。默认取版本较新的那个，调用方可以指定偏好
 * （指定的那个不存在时退回另一个）。
 */
export function chooseVanillaSource(local: VanillaInstall | null, cached: CachedVanilla | null, prefer: VanillaPreference = 'newest'): VanillaChoice {
  if (!local && !cached) return { status: 'needs-download', install: null };
  if (!cached) return { status: 'local', install: local };
  if (!local) return { status: 'cached', install: cached };
  if (prefer === 'local') return { status: 'local', install: local };
  if (prefer === 'downloaded') return { status: 'cached', install: cached };
  return Date.parse(cached.releaseTime) > Date.parse(local.releaseTime) ? { status: 'cached', install: cached } : { status: 'local', install: local };
}
