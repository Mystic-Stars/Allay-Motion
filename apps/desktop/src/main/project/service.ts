// 工程文件的读写（docs/01-product-architecture.md 1.9）与最近的工程。
// 路径只在主进程：渲染进程拿到的是句柄（打开、保存过的工程）和最近工程的 id。路径的来源只有主进程的对话框
// 和这里记下的最近工程列表（它本身也只来自对话框选过的路径）。
import { randomUUID } from 'node:crypto';
import { lstat, open, readFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';
import type { Composition } from '@allay/template-sdk';
import {
  MAX_PROJECT_BYTES,
  MAX_PROJECT_IMAGES,
  MAX_RECENTS,
  PROJECT_FORMAT_VERSION,
  PROJECT_IMAGE_REF,
  mapProjectImages,
  ProjectDataSchema,
  ProjectFileSchema,
  type ProjectData,
  type ProjectOpenResult,
  type ProjectSaveResult,
  type QuickProjectData,
  type RecentProject,
} from '../../shared/project';
import type { FileGrants } from '../file-grants';
import type { Logger } from '../logger';
import { writeJsonAtomic } from '../settings-store';
import { z } from 'zod';

type Json = QuickProjectData['params'][string];
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const ProjectImageTokenSchema = z.uuid();
const ImageGrantSchema = z.strictObject({ formatVersion: z.literal(1), path: z.string().min(1).max(4096) });

function mapCompositionImages(doc: Composition, map: (value: string, clipId: string) => string): Composition {
  return {
    ...doc,
    tracks: doc.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip) => ({
        ...clip,
        params: Object.fromEntries(Object.entries(clip.params).map(([key, value]) => [key, mapProjectImages(value, (ref) => map(ref, clip.id))])),
      })),
    })),
  };
}

const RecentsFileSchema = z.object({
  formatVersion: z.literal(1),
  items: z.array(z.strictObject({ path: z.string().min(1).max(4096), name: z.string().max(200), at: z.string().max(64) })).max(MAX_RECENTS).catch([]),
});

export interface ProjectServiceOptions {
  userDataDir: string;
  appVersion: string;
  grants: FileGrants;
  log: Logger;
}

export class ProjectService {
  /** 句柄 → 路径 */
  private readonly handles = new Map<string, string>();
  private readonly imageTokens = new Map<string, string>();
  private recentsList: { path: string; name: string; at: string }[] = [];
  /** 最近工程的路径 → 这次运行里的 id */
  private readonly recentIds = new Map<string, string>();
  private loaded: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: ProjectServiceOptions) {}

  private get recentsFile(): string {
    return join(this.opts.userDataDir, 'recents.json');
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        const raw: unknown = JSON.parse(await readFile(this.recentsFile, 'utf8'));
        const parsed = RecentsFileSchema.safeParse(raw);
        this.recentsList = parsed.success ? parsed.data.items : [];
      } catch {
        this.recentsList = [];
      }
    })();
    return this.loaded;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private idFor(path: string): string {
    let id = this.recentIds.get(path);
    if (!id) {
      id = randomUUID();
      this.recentIds.set(path, id);
    }
    return id;
  }

  private async remember(path: string): Promise<void> {
    await this.load();
    const name = basename(path, extname(path));
    this.recentsList = [{ path, name, at: new Date().toISOString() }, ...this.recentsList.filter((r) => r.path !== path)].slice(0, MAX_RECENTS);
    await writeJsonAtomic(this.recentsFile, { formatVersion: 1, items: this.recentsList }).catch((error: unknown) => this.opts.log.warn('project', 'failed to write recents', { error }));
  }

  private register(path: string): string {
    for (const [h, p] of this.handles) if (p === path) return h;
    const handle = randomUUID();
    this.handles.set(handle, path);
    return handle;
  }

  async recents(): Promise<RecentProject[]> {
    await this.load();
    return this.recentsList.map((r) => ({ id: this.idFor(r.path), name: r.name, folder: dirname(r.path) }));
  }

  /** 打开一个路径（来自主进程的对话框或最近工程列表） */
  async openPath(path: string): Promise<ProjectOpenResult> {
    let bytes: Buffer;
    try {
      const handle = await open(path, 'r');
      try {
        const info = await handle.stat();
        if (!info.isFile()) return { ok: false, error: 'missing' };
        if (info.size > MAX_PROJECT_BYTES) return { ok: false, error: 'too-large' };
        const buffer = Buffer.alloc(MAX_PROJECT_BYTES + 1);
        let size = 0;
        while (size < buffer.length) {
          const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
          if (bytesRead === 0) break;
          size += bytesRead;
        }
        if (size > MAX_PROJECT_BYTES) return { ok: false, error: 'too-large' };
        bytes = buffer.subarray(0, size);
      } finally {
        await handle.close();
      }
    } catch {
      return { ok: false, error: 'missing' };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(bytes.toString('utf8'));
    } catch {
      return { ok: false, error: 'unreadable' };
    }
    if (raw && typeof raw === 'object' && typeof (raw as { formatVersion?: unknown }).formatVersion === 'number' && (raw as { formatVersion: number }).formatVersion > PROJECT_FORMAT_VERSION) {
      return { ok: false, error: 'too-new' };
    }
    const parsed = ProjectFileSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid' };
    const file = parsed.data;
    const name = basename(path, extname(path));
    const missingFiles = new Set<string>();
    const common = { name: file.name || name.slice(0, 120), output: file.output, export: file.export, preview: file.preview, resourceHint: file.resourceHint };
    let data: ProjectData;
    if (file.formatVersion === 2) {
      const declared = new Set(file.files ?? []);
      const used = new Set<string>();
      mapCompositionImages(file.composition, (value) => {
        const ref = PROJECT_IMAGE_REF.exec(value)?.[1];
        if (ref && declared.has(ref)) used.add(ref);
        return value;
      });
      const available = new Map<string, string>();
      for (const token of used) {
        const imagePath = await this.readImageGrant(token);
        if (!imagePath) continue;
        const ref = this.opts.grants.grant(imagePath);
        this.imageTokens.set(ref, token);
        available.set(token, ref);
      }
      const composition = mapCompositionImages(file.composition, (value, clipId) => {
        const token = PROJECT_IMAGE_REF.exec(value)?.[1];
        const ref = token && available.get(token);
        if (ref) return `file:${ref}`;
        missingFiles.add(clipId);
        return token ? `unlinked-file:${token}` : value;
      });
      data = { ...common, composition };
    } else {
      const params: Record<string, Json> = Object.fromEntries(Object.entries(file.params).filter(([, value]) =>
        typeof value !== 'string' || !PROJECT_IMAGE_REF.test(value)));
      for (const [key, filePath] of Object.entries(file.files)) {
        delete params[key];
        if (await this.isImageFile(filePath)) params[key] = `file:${this.opts.grants.grant(filePath)}`;
        else missingFiles.add(key);
      }
      data = { ...common, template: file.template, params };
    }
    const handle = this.register(path);
    await this.remember(path);
    return { ok: true, handle, name, data, missingFiles: [...missingFiles] };
  }

  private async isImageFile(path: string): Promise<boolean> {
    if (!isAbsolute(path) || /^(?:[\\/]{2}|[\\/][?.][\\/])/.test(path) || !IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) return false;
    const info = await lstat(path).catch(() => null);
    return !!info?.isFile() && info.size <= MAX_IMAGE_BYTES;
  }

  private imageGrantFile(token: string): string {
    return join(this.opts.userDataDir, 'project-image-grants', `${ProjectImageTokenSchema.parse(token)}.json`);
  }

  private async readImageGrant(token: string): Promise<string | null> {
    try {
      const file = this.imageGrantFile(token);
      const info = await lstat(file);
      if (!info.isFile() || info.size > 32 * 1024) return null;
      const { path } = ImageGrantSchema.parse(JSON.parse(await readFile(file, 'utf8')));
      return (await this.isImageFile(path)) ? path : null;
    } catch {
      return null;
    }
  }

  openRecent(id: string): Promise<ProjectOpenResult> {
    return this.serial(async () => {
      await this.load();
      const entry = this.recentsList.find((r) => this.recentIds.get(r.path) === id);
      if (!entry) return { ok: false, error: 'missing' } as const;
      const result = await this.openPath(entry.path);
      // 打不开的从列表里去掉
      if (!result.canceled && !result.ok && result.error === 'missing') {
        this.recentsList = this.recentsList.filter((r) => r.path !== entry.path);
        await writeJsonAtomic(this.recentsFile, { formatVersion: 1, items: this.recentsList }).catch(() => undefined);
      }
      return result;
    });
  }

  /** 已有句柄的工程保存到原处；句柄未知时由调用方转为“另存为” */
  pathOf(handle: string): string | null {
    return this.handles.get(handle) ?? null;
  }

  /** 写到一个路径（来自主进程的保存对话框或已有句柄） */
  saveTo(path: string, data: ProjectData): Promise<ProjectSaveResult> {
    return this.serial(async () => {
      try {
        const parsed = ProjectDataSchema.parse(data);
        const imageGrants = new Map<string, { ref: string; path: string }>();
        let versioned: object;
        if ('composition' in parsed) {
          const tokensByRef = new Map<string, string>();
          const composition = mapCompositionImages(parsed.composition, (value) => {
            const ref = PROJECT_IMAGE_REF.exec(value)?.[1];
            if (!ref) return value;
            const path = this.opts.grants.resolve(ref);
            if (!path) return `unlinked-file:${ref}`;
            const token = this.imageTokens.get(ref) ?? tokensByRef.get(ref) ?? randomUUID();
            tokensByRef.set(ref, token);
            imageGrants.set(token, { ref, path });
            return `file:${token}`;
          });
          if (imageGrants.size > MAX_PROJECT_IMAGES) return { ok: false, error: 'not-writable' } as const;
          versioned = { ...parsed, formatVersion: PROJECT_FORMAT_VERSION, composition, files: [...imageGrants.keys()] };
        } else {
          const files: Record<string, string> = {};
          const params = Object.fromEntries(Object.entries(parsed.params).filter(([key, value]) => {
            const ref = typeof value === 'string' ? PROJECT_IMAGE_REF.exec(value)?.[1] : undefined;
            if (!ref) return true;
            const path = this.opts.grants.resolve(ref);
            if (path) files[key] = path;
            return false;
          }));
          versioned = { ...parsed, formatVersion: 1, params, files };
        }
        const file = ProjectFileSchema.parse({ ...versioned, appVersion: this.opts.appVersion });
        if (Buffer.byteLength(`${JSON.stringify(file, null, 2)}\n`) > MAX_PROJECT_BYTES) return { ok: false, error: 'not-writable' } as const;
        for (const [token, grant] of imageGrants) {
          if (this.imageTokens.has(grant.ref)) continue;
          await writeJsonAtomic(this.imageGrantFile(token), ImageGrantSchema.parse({ formatVersion: 1, path: grant.path }));
          this.imageTokens.set(grant.ref, token);
        }
        await writeJsonAtomic(path, file);
      } catch (error) {
        this.opts.log.warn('project', 'save failed', { error });
        return { ok: false, error: 'not-writable' } as const;
      }
      const handle = this.register(path);
      await this.remember(path);
      return { ok: true, handle, name: basename(path, extname(path)) } as const;
    });
  }
}
