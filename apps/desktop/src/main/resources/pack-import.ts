// 添加资源包（docs/03-assets.md 3.5）：zip 先校验，通过后复制到 userData/packs/<内容哈希>.zip。
// 校验不过（条目名含 `..`、绝对路径等）时什么也不写（T-AST-5）。
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { openZip, ZipRejectedError } from './zip';

export const PACKS_DIR = 'packs';

export interface ImportedZipPack {
  /** 设置里记的文件名：<sha256>.zip */
  file: string;
  /** 复制后的绝对路径 */
  path: string;
  sha256: string;
  /** 被跳过的条目（过大、无法解码） */
  warnings: readonly string[];
  /** 已经导入过同样内容的包 */
  existed: boolean;
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * 导入 zip 资源包。先复制到 packs/ 下的临时文件，对这份副本做校验和哈希（避免校验后源文件被换掉），
 * 通过后改名为 <sha256>.zip。被拒绝时抛 ZipRejectedError，临时文件删除，userData 里不会多出任何文件。
 */
export async function importZipPack(source: string, userDataDir: string): Promise<ImportedZipPack> {
  const st = await stat(source);
  if (!st.isFile()) throw new ZipRejectedError('不是文件');
  const dir = join(userDataDir, PACKS_DIR);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.import-${randomUUID()}.tmp`);
  try {
    await copyFile(source, tmp);
    const zip = await openZip(tmp);
    const warnings = zip.warnings;
    zip.close();
    const sha256 = await sha256File(tmp);
    const file = `${sha256}.zip`;
    const target = join(dir, file);
    const exists = await stat(target).then(
      (s) => s.isFile(),
      () => false,
    );
    if (exists) {
      await rm(tmp, { force: true });
      return { file, path: target, sha256, warnings, existed: true };
    }
    await rename(tmp, target);
    return { file, path: target, sha256, warnings, existed: false };
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

export function packArchiveType(path: string): 'zip' | 'mcpack' | null {
  const ext = extname(path).toLowerCase();
  return ext === '.zip' ? 'zip' : ext === '.mcpack' ? 'mcpack' : null;
}

/** 设置里记的 zip 文件名 → 绝对路径。文件名必须是 <sha256>.zip，防止设置文件被改成任意路径 */
export function packZipPath(userDataDir: string, file: string): string | null {
  return /^[0-9a-f]{64}\.zip$/.test(file) ? join(userDataDir, PACKS_DIR, file) : null;
}
