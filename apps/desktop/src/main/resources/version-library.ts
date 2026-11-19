import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { ResourceProfileIdSchema, type InstancePackInfo, type ResourceProfileInfo } from '../../shared/resources';
import { writeJsonAtomic } from '../settings-store';
import type { VanillaInstall } from './vanilla';

const LocalPath = z.string().min(1).max(32_767).refine(isAbsolute);
const SavedProfile = z.strictObject({
  id: ResourceProfileIdSchema,
  source: z.enum(['local', 'downloaded', 'bedrock']),
  name: z.string(),
  versionId: z.string(),
  gameDir: LocalPath.nullable(),
  resourcePacksDir: LocalPath.nullable(),
  sourcePath: LocalPath,
});
const LibraryFile = z.strictObject({
  formatVersion: z.literal(1),
  pinnedId: ResourceProfileIdSchema.nullable(),
  authorized: z.array(LocalPath),
  profiles: z.array(SavedProfile),
  instancePacks: z.record(ResourceProfileIdSchema, z.array(z.strictObject({ id: ResourceProfileIdSchema, name: z.string(), path: LocalPath }))),
});
export type SavedProfile = z.infer<typeof SavedProfile>;

export function sourceId(source: ResourceProfileInfo['source'] | 'instance', ...parts: string[]): string {
  return `${source}:${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)}`;
}

export function javaProfile(install: VanillaInstall, source: 'local' | 'downloaded'): SavedProfile {
  return {
    id: sourceId(source, install.gameDir, install.versionId), source, name: install.versionId, versionId: install.versionId,
    gameDir: install.gameDir, resourcePacksDir: source === 'local' ? join(install.gameDir, 'resourcepacks') : null,
    sourcePath: install.jarPath,
  };
}

export class VersionLibraryFile {
  data: z.infer<typeof LibraryFile> = { formatVersion: 1, pinnedId: null, authorized: [], profiles: [], instancePacks: {} };

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    const info = await stat(this.file).catch(() => null);
    if (!info?.isFile() || info.size > 16 * 1024 * 1024) return;
    const parsed = await readFile(this.file, 'utf8').then((raw) => LibraryFile.safeParse(JSON.parse(raw))).catch(() => null);
    if (parsed?.success) this.data = parsed.data;
  }

  save(): Promise<void> {
    return writeJsonAtomic(this.file, this.data);
  }

  remember(profile: SavedProfile): void {
    this.data.profiles = [...this.data.profiles.filter((entry) => entry.id !== profile.id), profile];
  }
}

export async function listInstancePacks(profile: SavedProfile, selected: readonly Pick<InstancePackInfo, 'id' | 'name' | 'path'>[]): Promise<InstancePackInfo[]> {
  const root = profile.resourcePacksDir;
  if (!root || (await realpath(root).catch(() => null)) !== resolve(root)) return selected.map((entry) => ({ ...entry, enabled: true, missing: true }));
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const selectedIds = new Set(selected.map((entry) => entry.id));
  const found = new Map<string, InstancePackInfo>();
  for (const entry of entries) {
    if (!entry.isDirectory() && !(entry.isFile() && /^(\.zip|\.mcpack)$/i.test(extname(entry.name)))) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const info = await Promise.all(['pack.mcmeta', 'manifest.json', 'assets'].map((name) => stat(join(path, name)).catch(() => null)));
      if (!info[0]?.isFile() && !info[1]?.isFile() && !info[2]?.isDirectory()) continue;
    }
    const id = sourceId('instance', profile.id, entry.name);
    found.set(id, { id, name: basename(path), path, enabled: selectedIds.has(id), missing: false });
  }
  for (const entry of selected) if (!found.has(entry.id)) found.set(entry.id, { ...entry, enabled: true, missing: true });
  return [...found.values()].sort((left, right) => left.name.localeCompare(right.name));
}
