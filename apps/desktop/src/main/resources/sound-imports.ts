import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { ImportedSoundIdSchema, MAX_SOUND_BYTES, type SoundKind } from '@allay/assets';
import { z } from 'zod';
import { ImportedSoundSchema, SoundExtensionSchema, type ImportedSound } from '../../shared/sound';

const MetadataSchema = ImportedSoundSchema.extend({ formatVersion: z.literal(1), extension: SoundExtensionSchema });

async function readBounded(path: string, max: number): Promise<Uint8Array | null> {
  const entry = await lstat(path).catch(() => null);
  if (!entry?.isFile() || entry.size === 0 || entry.size > max) return null;
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size === 0 || info.size > max) return null;
    const bytes = new Uint8Array(info.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return offset === info.size ? bytes.subarray(0, offset) : null;
  } finally {
    await handle.close();
  }
}

/** 仅导入对话框授权的文件；库读操作只接受随机 ID，不解析项目传来的路径。 */
export class SoundImports {
  private readonly root: string;

  constructor(userData: string) {
    this.root = join(userData, 'sound-library');
  }

  async add(path: string, kind: SoundKind): Promise<ImportedSound> {
    const extension = SoundExtensionSchema.parse(extname(path).slice(1).toLowerCase());
    const bytes = await readBounded(path, MAX_SOUND_BYTES);
    if (!bytes) throw new Error('invalid audio file size');
    const key = randomUUID().replaceAll('-', '');
    const item = ImportedSoundSchema.parse({ id: `user-audio:${key}`, name: basename(path), kind });
    await mkdir(this.root, { recursive: true });
    const media = join(this.root, `${key}.${extension}`);
    const temporary = join(this.root, `${key}.tmp`);
    try {
      await writeFile(media, bytes, { flag: 'wx' });
      await writeFile(temporary, JSON.stringify({ ...item, formatVersion: 1, extension }), { flag: 'wx' });
      await rename(temporary, join(this.root, `${key}.json`));
    } catch (error) {
      await Promise.allSettled([rm(media, { force: true }), rm(temporary, { force: true })]);
      throw error;
    }
    return item;
  }

  private async metadata(id: string): Promise<z.infer<typeof MetadataSchema> | null> {
    if (!ImportedSoundIdSchema.safeParse(id).success) return null;
    const key = id.slice('user-audio:'.length);
    try {
      const bytes = await readBounded(join(this.root, `${key}.json`), 4096);
      if (!bytes) return null;
      const value = MetadataSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
      return value.id === id ? value : null;
    } catch {
      return null;
    }
  }

  async list(): Promise<ImportedSound[]> {
    const files = await readdir(this.root).catch(() => []);
    const items: ImportedSound[] = [];
    for (const file of files.sort()) {
      if (!/^[0-9a-f]{32}\.json$/.test(file)) continue;
      const item = await this.metadata(`user-audio:${file.slice(0, -5)}`);
      if (item) items.push({ id: item.id, name: item.name, kind: item.kind });
    }
    return items;
  }

  async variants(id: string) {
    const item = await this.metadata(id);
    return item ? [{ file: id, volume: 1, pitch: 1, weight: 1, kind: item.kind }] : null;
  }

  async read(id: string): Promise<Uint8Array | null> {
    const item = await this.metadata(id);
    return item ? readBounded(join(this.root, `${id.slice('user-audio:'.length)}.${item.extension}`), MAX_SOUND_BYTES).catch(() => null) : null;
  }
}
