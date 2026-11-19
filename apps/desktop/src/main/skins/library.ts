import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join, parse } from 'node:path';
import { z } from 'zod';
import { SkinEntrySchema, SkinModelSchema, SkinPixelsSchema, SkinRefSchema, type SkinEntry, type SkinModel, type SkinPixels } from '../../shared/skins';
import { SkinError } from './errors';
import { decodeSkinPng, MAX_SKIN_BYTES } from './png';

const RecordSchema = z.strictObject({
  formatVersion: z.literal(1),
  entry: SkinEntrySchema,
  rgba: z.string().max(21_848).regex(/^[A-Za-z0-9+/]+={0,2}$/),
});
const MAX_RECORD_BYTES = 24 * 1024;

async function readBounded(path: string, limit: number): Promise<Buffer> {
  const info = await lstat(path);
  if (!info.isFile()) throw new SkinError('storage');
  if (info.size > limit) throw new SkinError('too-large');
  const file = await open(path, 'r');
  try {
    const target = Buffer.alloc(limit + 1);
    let total = 0;
    while (total < target.length) {
      const { bytesRead } = await file.read(target, total, target.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > limit) throw new SkinError('too-large');
    return target.subarray(0, total);
  } finally {
    await file.close();
  }
}

export class SkinLibrary {
  private readonly root: string;

  constructor(userData: string) {
    this.root = join(userData, 'skins');
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    if (!(await lstat(this.root)).isDirectory()) throw new SkinError('storage');
  }

  private recordPath(ref: string): string {
    return join(this.root, `${SkinRefSchema.parse(ref).slice('skins:'.length)}.json`);
  }

  private async readRecord(ref: string): Promise<{ entry: SkinEntry; pixels: SkinPixels } | null> {
    try {
      const raw = await readBounded(this.recordPath(ref), MAX_RECORD_BYTES);
      const { entry, rgba } = RecordSchema.parse(JSON.parse(raw.toString('utf8')));
      if (entry.ref !== ref) return null;
      const pixels = SkinPixelsSchema.parse({ width: 64, height: entry.height, data: new Uint8Array(Buffer.from(rgba, 'base64')) });
      return { entry, pixels };
    } catch {
      return null;
    }
  }

  async list(): Promise<SkinEntry[]> {
    await this.ensureRoot();
    const entries: SkinEntry[] = [];
    for (const file of await readdir(this.root, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue;
      const ref = `skins:${basename(file.name, '.json')}`;
      if (!SkinRefSchema.safeParse(ref).success) continue;
      const stored = await this.readRecord(ref);
      if (stored) entries.push(stored.entry);
    }
    return entries.sort((left, right) => left.name.localeCompare(right.name) || left.ref.localeCompare(right.ref));
  }

  async read(ref: string): Promise<SkinPixels | null> {
    if (!SkinRefSchema.safeParse(ref).success) return null;
    await this.ensureRoot();
    return (await this.readRecord(ref))?.pixels ?? null;
  }

  async remove(ref: string): Promise<boolean> {
    if (!SkinRefSchema.safeParse(ref).success) return false;
    await this.ensureRoot();
    const path = this.recordPath(ref);
    const info = await lstat(path).catch(() => null);
    if (!info?.isFile()) return false;
    await rm(path);
    return true;
  }

  async importFile(path: string, model: SkinModel): Promise<SkinEntry> {
    return this.add(await readBounded(path, MAX_SKIN_BYTES), parse(path).name, model, 'local');
  }

  async add(bytes: Buffer, name: string, model: SkinModel, source: SkinEntry['source']): Promise<SkinEntry> {
    SkinModelSchema.parse(model);
    if (bytes.length > MAX_SKIN_BYTES) throw new SkinError('too-large');
    const pixels = await decodeSkinPng(bytes).catch(() => { throw new SkinError('invalid-png'); });
    const entry = SkinEntrySchema.parse({
      ref: `skins:${randomUUID()}`,
      name: name.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 128) || 'PNG',
      model: pixels.height === 32 ? 'classic' : model,
      height: pixels.height,
      source,
    });
    await this.ensureRoot();
    const path = this.recordPath(entry.ref);
    const temporary = `${path}.part`;
    const record = RecordSchema.parse({ formatVersion: 1, entry, rgba: Buffer.from(pixels.data).toString('base64') });
    try {
      await writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
    return entry;
  }
}
