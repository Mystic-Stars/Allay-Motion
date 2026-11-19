// 原版层（docs/03-assets.md 3.4）：本机 Minecraft Java 版的客户端 jar 加资源索引。只读，不复制任何文件。
//
// 探测：在候选目录里读 versions/<id>/<id>.json，只考虑同目录下有 <id>.jar 的版本，
// 保留每个有效版本；再按 assetIndex.id 找 assets/indexes/<id>.json，
// 音效等文件在 assets/objects/<哈希前两位>/<哈希>。
import { createHash } from 'node:crypto';
import { open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { isSafeRelativePath, readPngHeader } from '@allay/assets';
import { z } from 'zod';
import type { ClosableLayer } from './layers';
import { MAX_ENTRY_BYTES, openZip } from './zip';

export const VANILLA_LAYER_ID = 'vanilla';

/** 版本 JSON 的宽松 schema：只取需要的字段，其余忽略 */
const VersionJsonSchema = z.looseObject({
  type: z.string(),
  releaseTime: z.string(),
  assetIndex: z.looseObject({ id: z.string().regex(/^[\w.-]+$/), sha1: z.string().optional(), size: z.int().positive().optional() }).optional(),
});

const AssetIndexSchema = z.object({ objects: z.record(z.string(), z.unknown()) });
const IndexObjectSchema = z.object({ hash: z.string().regex(/^[0-9a-f]{40}$/), size: z.number().int().nonnegative().max(MAX_ENTRY_BYTES) });
type IndexObject = z.infer<typeof IndexObjectSchema> & { file: string };
const indexedTexture = /^assets\/[a-z0-9_.-]+\/textures\/.+\.png(?:\.mcmeta)?$/;
export const INDEXED_FONT_LIMITS: ReadonlyMap<string, number> = new Map([
  ['minecraft/font/include/unifont.json', 4 * 1024 * 1024],
  ['minecraft/font/include/unifont_pua.json', 4 * 1024 * 1024],
  ['minecraft/font/unifont.zip', 8 * 1024 * 1024],
  ['minecraft/font/unifont_jp.zip', 8 * 1024 * 1024],
  ['minecraft/font/unifont_pua.zip', 8 * 1024 * 1024],
]);

/** 版本 JSON 很小；超过这个大小的不读 */
const MAX_JSON_BYTES = 16 * 1024 * 1024;

export interface VanillaInstall {
  gameDir: string;
  versionId: string;
  versionType?: string;
  releaseTime: string;
  jarPath: string;
  /** 资源索引不存在时为 null（仍可读取 jar） */
  assetIndexPath: string | null;
  assetIndexSha1?: string;
  assetIndexSize?: number;
  /** 应用下载缓存的版本元数据；补齐索引对象后写入，参与资源代计算 */
  cacheVersionFile?: string;
  objectsDir: string;
}

export interface CandidateEnv {
  platform: NodeJS.Platform;
  /** Windows 的 %APPDATA% */
  appData?: string;
  home: string;
}

/**
 * 候选目录，按优先级：用户上次手动选过的目录、官方启动器的默认目录。
 * 其他启动器（Prism、MultiMC 等）的目录结构不同，v1 不自动探测；用户可以手动选目录（见 decisions.md）。
 */
export function candidateGameDirs(env: CandidateEnv, lastChosen: string | null): string[] {
  const out: string[] = [];
  if (lastChosen) out.push(lastChosen);
  if (env.platform === 'win32') {
    if (env.appData) out.push(join(env.appData, '.minecraft'));
  } else if (env.platform === 'darwin') {
    out.push(join(env.home, 'Library', 'Application Support', 'minecraft'));
  } else {
    out.push(join(env.home, '.minecraft'));
  }
  return [...new Set(out)];
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isFile(),
    () => false,
  );
}

async function readJsonBytes(path: string): Promise<Buffer> {
  const st = await stat(path);
  if (!st.isFile() || st.size > MAX_JSON_BYTES) throw new Error(`not a readable json file: ${path}`);
  const bytes = await readFile(path);
  if (bytes.length > MAX_JSON_BYTES) throw new Error(`not a readable json file: ${path}`);
  return bytes;
}

function parseJson(bytes: Buffer): unknown {
  return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')) as unknown;
}

async function insideRoot(root: string, file: string): Promise<string | null> {
  const path = await realpath(file).catch(() => null);
  if (!path) return null;
  const within = relative(root, path);
  return !within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within) ? null : path;
}

async function readVerifiedObject(root: string, object: IndexObject): Promise<Uint8Array | null> {
  const path = await insideRoot(root, object.file);
  if (!path) return null;
  const handle = await open(path, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== object.size) return null;
    const bytes = Buffer.alloc(object.size);
    const { bytesRead } = await handle.read({ buffer: bytes });
    if (bytesRead !== object.size || createHash('sha1').update(bytes).digest('hex') !== object.hash) return null;
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/** 在一个游戏目录里枚举有客户端 jar 的版本 */
export async function findJavaVersions(gameDir: string): Promise<VanillaInstall[]> {
  const versionsDir = join(gameDir, 'versions');
  const names = await readdir(versionsDir, { withFileTypes: true }).catch(() => []);
  const found: VanillaInstall[] = [];
  for (const d of names) {
    if (!d.isDirectory() || !isSafeRelativePath(d.name) || d.name.includes('/')) continue;
    const id = d.name;
    const jarPath = join(versionsDir, id, `${id}.jar`);
    if (!(await isFile(jarPath))) continue;
    const parsed = VersionJsonSchema.safeParse(await readJsonBytes(join(versionsDir, id, `${id}.json`)).then(parseJson).catch(() => null));
    if (!parsed.success) continue;
    if (Number.isNaN(Date.parse(parsed.data.releaseTime))) continue;
    const indexId = parsed.data.assetIndex?.id;
    const indexPath = indexId ? join(gameDir, 'assets', 'indexes', `${indexId}.json`) : null;
    found.push({
      gameDir,
      versionId: id,
      versionType: parsed.data.type,
      releaseTime: parsed.data.releaseTime,
      jarPath,
      assetIndexPath: indexPath && (await isFile(indexPath)) ? indexPath : null,
      ...(parsed.data.assetIndex?.sha1 !== undefined ? { assetIndexSha1: parsed.data.assetIndex.sha1 } : {}),
      ...(parsed.data.assetIndex?.size !== undefined ? { assetIndexSize: parsed.data.assetIndex.size } : {}),
      objectsDir: join(gameDir, 'assets', 'objects'),
    });
  }
  found.sort((a, b) => Date.parse(b.releaseTime) - Date.parse(a.releaseTime) || (a.versionId < b.versionId ? 1 : -1));
  return found;
}

export async function findLatestRelease(gameDir: string): Promise<VanillaInstall | null> {
  return (await findJavaVersions(gameDir)).find((v) => v.versionType === 'release') ?? null;
}

export async function detectJavaVersions(env: CandidateEnv, authorized: readonly string[]): Promise<VanillaInstall[]> {
  const dirs = await Promise.all([...authorized, ...candidateGameDirs(env, null)].map((dir) => realpath(dir).catch(() => null)));
  const roots = [...new Set(dirs.filter((dir) => dir !== null))];
  const versions = (await Promise.all(roots.map(findJavaVersions))).flat();
  return versions.sort((a, b) => Date.parse(b.releaseTime) - Date.parse(a.releaseTime));
}

/** 依次试候选目录，返回第一个找到的安装 */
export async function detectMinecraft(env: CandidateEnv, lastChosen: string | null): Promise<VanillaInstall | null> {
  for (const dir of candidateGameDirs(env, lastChosen)) {
    const install = await findLatestRelease(dir);
    if (install) return install;
  }
  return null;
}

/**
 * 打开原版层。jar 里只收录 assets/ 下的文件；资源索引里的对象映射成 `assets/<键>` 的虚拟路径，
 * 这样 sounds.json 和 .ogg 与资源包里的路径写法一致。jar 打不开时抛错，调用方静默退回内置层。
 */
export interface VanillaLayerOptions {
  /**
   * 资源对象不在本地时按需取（下载缓存的原版层用 downloader.fetchObject）。不给时缺的对象当作不存在。
   * 只有用户同意下载后，调用方才应传入。
   */
  fetchObject?: (hash: string, size: number) => Promise<string>;
}

export async function vanillaRevision(install: VanillaInstall): Promise<string> {
  const [jar, index, cachedVersion] = await Promise.all([
    stat(install.jarPath),
    install.assetIndexPath ? stat(install.assetIndexPath).catch(() => null) : null,
    install.cacheVersionFile ? stat(install.cacheVersionFile).catch(() => null) : null,
  ]);
  return createHash('sha256').update(JSON.stringify([install.jarPath, install.objectsDir, install.assetIndexPath, install.assetIndexSha1, install.assetIndexSize, jar.size, jar.mtimeMs, jar.ctimeMs, index?.size, index?.mtimeMs, index?.ctimeMs, cachedVersion?.mtimeMs, cachedVersion?.ctimeMs])).digest('hex');
}

export async function openVanillaLayer(install: VanillaInstall, options: VanillaLayerOptions = {}): Promise<ClosableLayer> {
  const jar = await openZip(install.jarPath, { includePrefixes: ['assets/'] });
  try {
    const objects = new Map<string, IndexObject>();
    const warnings = [...jar.warnings];
    const root = await realpath(install.gameDir).catch(() => null);
    if (install.assetIndexPath) {
      const indexFile = root && await insideRoot(root, install.assetIndexPath);
      const bytes = await readJsonBytes(indexFile ?? install.assetIndexPath).catch(() => null);
      const parsed = bytes ? await Promise.resolve(bytes).then(parseJson).then((data) => AssetIndexSchema.safeParse(data)).catch(() => null) : null;
      if (bytes && parsed?.success) {
        const shaMatches = install.assetIndexSha1 !== undefined && createHash('sha1').update(bytes).digest('hex') === install.assetIndexSha1;
        const sizeMatches = install.assetIndexSize === undefined || bytes.length === install.assetIndexSize;
        const textureIndexMatches = install.assetIndexSha1 === undefined || shaMatches;
        if (!textureIndexMatches || !sizeMatches) warnings.push('资源索引与游戏版本的校验值不符，不使用索引贴图和字体');
        for (const [key, raw] of Object.entries(parsed.data.objects)) {
          const path = `assets/${key}`;
          const fontLimit = INDEXED_FONT_LIMITS.get(key);
          if (!isSafeRelativePath(path) || ((!indexFile || !textureIndexMatches || !sizeMatches) && indexedTexture.test(path)) ||
              (fontLimit !== undefined && (!indexFile || !shaMatches || !sizeMatches))) continue;
          const entry = IndexObjectSchema.safeParse(raw);
          if (!entry.success || (fontLimit !== undefined && (entry.data.size === 0 || entry.data.size > fontLimit))) continue;
          const obj = entry.data;
          objects.set(path, { file: join(install.objectsDir, obj.hash.slice(0, 2), obj.hash), size: obj.size, hash: obj.hash });
        }
      } else {
        warnings.push('资源索引无法解析，仅使用客户端内的资源');
      }
    }
    const all = [...new Set([...jar.paths, ...objects.keys()])].sort();
    return {
      id: VANILLA_LAYER_ID,
      kind: 'vanilla',
      name: install.versionId,
      enabled: true,
      revision: await vanillaRevision(install),
      warnings,
      has: (path) => jar.has(path) || objects.has(path),
      list: (prefix) => all.filter((p) => p.startsWith(prefix)),
      read: async (path) => {
        const obj = objects.get(path);
        const texture = indexedTexture.test(path);
        if (texture || (path.startsWith('assets/') && INDEXED_FONT_LIMITS.has(path.slice(7)))) {
          const objectRoot = obj && root ? await insideRoot(root, install.objectsDir) : null;
          const bytes = obj && objectRoot ? await readVerifiedObject(objectRoot, obj) : null;
          if (bytes && (!texture || !path.endsWith('.png') || readPngHeader(bytes))) return bytes;
          return jar.read(path);
        }
        if (jar.has(path)) return jar.read(path);
        if (!obj) return null;
        let st = await stat(obj.file).catch(() => null);
        if (!st && options.fetchObject) {
          await options.fetchObject(obj.hash, obj.size);
          st = await stat(obj.file).catch(() => null);
        }
        if (!st || !st.isFile() || st.size > MAX_ENTRY_BYTES) return null;
        return new Uint8Array(await readFile(obj.file));
      },
      remoteObject: async (path) => {
        if (indexedTexture.test(path) || (path.startsWith('assets/') && INDEXED_FONT_LIMITS.has(path.slice(7))) || jar.has(path)) return null;
        const obj = objects.get(path);
        if (!obj) return null;
        const st = await stat(obj.file).catch(() => null);
        return st && st.isFile() && st.size === obj.size ? null : { hash: obj.hash, size: obj.size };
      },
      close: jar.close,
    };
  } catch (err) {
    jar.close();
    throw err;
  }
}
