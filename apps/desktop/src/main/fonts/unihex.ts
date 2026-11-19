import { isSafeRelativePath, parseUnihex, type BitmapFontTables, type UnihexProvider } from '@allay/assets';
import yauzl from 'yauzl';

const MAX_ARCHIVE = 8 * 1024 * 1024;
const MAX_HEX = 12 * 1024 * 1024;

/** 嵌套 ZIP 仅在内存展开 ASCII hex；限制输入、条目数和累计解压尺寸。 */
export async function readUnihexArchive(bytes: Uint8Array, overrides: UnihexProvider['overrides']): Promise<BitmapFontTables | null> {
  if (bytes.byteLength > MAX_ARCHIVE) return null;
  const zip = await yauzl.fromBufferPromise(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
    autoClose: false, lazyEntries: true, strictFileNames: true, validateEntrySizes: true,
  });
  try {
    if (zip.entryCount > 32) return null;
    let size = 0;
    const files = new Map<string, string>();
    for await (const entry of zip.eachEntry()) {
      if (!entry.fileName.endsWith('.hex')) continue;
      if (!isSafeRelativePath(entry.fileName) || files.has(entry.fileName) || entry.isEncrypted() || !entry.canDecodeFileData()) return null;
      if (size + entry.uncompressedSize > MAX_HEX) return null;
      const stream = await zip.openReadStreamPromise(entry);
      const chunks: Buffer[] = [];
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        size += chunk.byteLength;
        if (size > MAX_HEX) {
          stream.destroy();
          return null;
        }
        chunks.push(chunk);
      }
      files.set(entry.fileName, Buffer.concat(chunks).toString('utf8'));
    }
    return parseUnihex([...files.keys()].sort().map((name) => files.get(name)).join('\n'), overrides);
  } finally {
    zip.close();
  }
}
