// 缩略图的磁盘缓存（docs/03-assets.md 3.10）。按渲染版本、resourceStamp 分目录，不复用旧字体的渲染结果。
// 键和 stamp 都已由 IPC 的 schema 校验过（只含安全字符），这里再确认一次路径落在缓存目录里。
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { readPngHeader } from '@allay/assets';
import type { CacheUsage } from '../shared/resources';

export class ThumbCache {
  private readonly root: string;

  constructor(userDataDir: string) {
    this.root = resolve(userDataDir, 'cache', 'thumbs-v2');
  }

  get dir(): string {
    return this.root;
  }

  private file(stamp: string, key: string): string {
    const f = resolve(this.root, stamp, `${key}.png`);
    const rel = relative(this.root, f);
    if (rel.startsWith('..') || rel.split(sep).length !== 2) throw new Error('thumbnail path escapes the cache');
    return f;
  }

  async get(stamp: string, key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.file(stamp, key)));
    } catch {
      return null;
    }
  }

  async put(stamp: string, key: string, png: Uint8Array): Promise<boolean> {
    if (!readPngHeader(png)) return false;
    const dir = join(this.root, stamp);
    await mkdir(dir, { recursive: true });
    await this.prune(stamp);
    const target = this.file(stamp, key);
    const tmp = join(dir, `.${randomBytes(6).toString('hex')}.tmp`);
    try {
      await writeFile(tmp, png);
      await rename(tmp, target);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
    return true;
  }

  /** 只留当前 stamp 的目录 */
  private async prune(keep: string): Promise<void> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    for (const e of entries) if (e.name !== keep) await rm(join(this.root, e.name), { recursive: true, force: true }).catch(() => undefined);
  }

  async clear(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }

  async usage(): Promise<CacheUsage> {
    let files = 0;
    let bytes = 0;
    const walk = async (dir: string): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.isFile()) {
          files++;
          bytes += (await stat(p).catch(() => ({ size: 0 }))).size;
        }
      }
    };
    await walk(this.root);
    return { files, bytes };
  }
}
