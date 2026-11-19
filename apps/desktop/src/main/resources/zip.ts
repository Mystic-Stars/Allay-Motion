// zip 与 jar 的只读访问（docs/03-assets.md 3.2、3.5；01-product-architecture.md 1.6 第 9 条）。
// 用 yauzl 按中央目录随机读取，不整包解压，也不往磁盘写任何东西。
//
// 安全：
// - 任何条目名含 `..`、是绝对路径、带盘符或反斜杠，整个压缩包拒绝（ZipRejectedError）。
// - 单个文件解压后超过上限（默认 64 MB）的跳过：中央目录声明的大小超限直接不收录；
//   读取时再按实际解压出的字节数截断（声明的大小可以造假）。
// - 条目数有上限；加密条目和不认识的压缩方法跳过。
import { isSafeRelativePath } from '@allay/assets';
import yauzl, { type Entry, type ZipFile } from 'yauzl';

export const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
export const MAX_ENTRIES = 200_000;

export class ZipRejectedError extends Error {
  override name = 'ZipRejectedError';
  constructor(
    message: string,
    readonly entryName?: string,
  ) {
    super(message);
  }
}

export interface ZipIndexOptions {
  rejectLinks?: boolean;
  maxEntryBytes?: number;
  maxEntries?: number;
  /** 只收录以这些前缀开头的条目（jar 里只关心 assets/ 等）；不给时全收 */
  includePrefixes?: readonly string[];
}

export interface ZipArchive {
  readonly file: string;
  /** 收录的文件条目（不含目录） */
  readonly paths: ReadonlySet<string>;
  /** 被跳过的条目及原因 */
  readonly warnings: readonly string[];
  has(path: string): boolean;
  /** 不存在时返回 null；读取失败抛错 */
  read(path: string): Promise<Uint8Array | null>;
  list(prefix: string): string[];
  close(): void;
}

/** 打开并校验压缩包。名字不安全时整个拒绝；文件本身不是 zip 时抛 ZipRejectedError */
export async function openZip(file: string, options: ZipIndexOptions = {}): Promise<ZipArchive> {
  const maxBytes = options.maxEntryBytes ?? MAX_ENTRY_BYTES;
  const maxEntries = options.maxEntries ?? MAX_ENTRIES;
  let zip: ZipFile;
  try {
    // decodeStrings 让 yauzl 自己也校验文件名（拒绝 .. 和绝对路径）；strictFileNames 不把反斜杠改成正斜杠
    zip = await yauzl.openPromise(file, { autoClose: false, lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: true });
  } catch (err) {
    throw new ZipRejectedError(`不是有效的 zip：${(err as Error).message}`);
  }
  const entries = new Map<string, Entry>();
  const warnings: string[] = [];
  try {
    if (zip.entryCount > maxEntries) throw new ZipRejectedError(`条目太多（${zip.entryCount} > ${maxEntries}）`);
    for await (const entry of zip.eachEntry()) {
      const raw = entry.fileName;
      if (options.rejectLinks && ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000) {
        throw new ZipRejectedError('不接受链接条目', raw);
      }
      const isDir = raw.endsWith('/');
      const name = isDir ? raw.slice(0, -1) : raw;
      if (name === '' && isDir) continue;
      if (!isSafeRelativePath(name)) throw new ZipRejectedError(`条目名不安全：${raw}`, raw);
      if (isDir) continue;
      if (options.includePrefixes && !options.includePrefixes.some((p) => name.startsWith(p))) continue;
      if (entry.isEncrypted() || !entry.canDecodeFileData()) {
        warnings.push(`跳过无法解码的条目：${name}`);
        continue;
      }
      if (entry.uncompressedSize > maxBytes) {
        warnings.push(`跳过过大的条目（${entry.uncompressedSize} 字节）：${name}`);
        continue;
      }
      if (entries.has(name)) {
        warnings.push(`重复的条目，只用第一个：${name}`);
        continue;
      }
      entries.set(name, entry);
    }
  } catch (err) {
    zip.close();
    if (err instanceof ZipRejectedError) throw err;
    // yauzl 对不安全文件名、损坏的中央目录都在这里报错
    throw new ZipRejectedError(`压缩包被拒绝：${(err as Error).message}`);
  }

  const paths = new Set(entries.keys());
  const sorted = [...paths].sort();
  return {
    file,
    paths,
    warnings,
    has: (path) => entries.has(path),
    list: (prefix) => sorted.filter((p) => p.startsWith(prefix)),
    close: () => zip.close(),
    read: async (path) => {
      const entry = entries.get(path);
      if (!entry) return null;
      const stream = await zip.openReadStreamPromise(entry);
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        total += chunk.length;
        if (total > maxBytes) {
          stream.destroy();
          throw new ZipRejectedError(`解压后超过 ${maxBytes} 字节：${path}`, path);
        }
        chunks.push(chunk);
      }
      return new Uint8Array(Buffer.concat(chunks, total));
    },
  };
}
