// 模板封面和悬停预览（docs/04-templates.md 4.8 第 5 步、06-ui-design.md 6.4 模板库）：
// 由杂务引擎 Worker 经统一的静帧接口（engine-host/still.ts，H4）以 320×180、30 fps 渲染，按 resourceStamp 缓存。
// 封面是剪辑点那一帧（没有剪辑点取中间一帧）；悬停预览是全部帧排成的网格图，播放时按帧画到一块小画布上。
// 页、悬停和展示组件分别持有请求；没有使用者的结果和过期任务都不保留。
import i18next from 'i18next';
import { create } from 'zustand';
import type { TemplateEntry } from '../../../shared/templates';
import { EngineHost } from '../../engine-host/EngineHost';
import { createResolver } from '../../engine-host/resource-client';
import { openStill, STILL_FAST } from '../../engine-host/still';
import { useResourceStore } from '../../stores/resourceStore';
import { useProjectStore } from '../../stores/projectStore';
import { readTemplate } from '../../templates/catalog';
import { boundResourceEdition, creationParams, hasProfileDefaults } from '../templates/profileDefaults';

export const COVER_W = 320;
export const COVER_H = 180;
export const COVER_FPS = 30;
const COVER_REFERENCE_SIZE = { width: 1920, height: 1080 };
/** 其他模板沿用 4 秒；版本化进度提示展示完整的 6.2 秒。 */
const MAX_FRAMES = COVER_FPS * 4;
const PROFILED_MAX_FRAMES = COVER_FPS * 7;
const SHEET_COLS = 8;
const STAMP_RE = /^[0-9a-f]{16}$/;
const MAX_DISK_BYTES = 8 * 1024 * 1024;

function coverResources(state = useResourceStore.getState().state, profileId = useProjectStore.getState().composition?.defaultProfile) {
  const profile = state?.library?.profiles.find((entry) => entry.id === profileId && !entry.missing);
  return {
    profileId,
    missing: profileId !== undefined && !profile,
    stamp: profileId === undefined ? state?.stamp ?? '' : profile?.stamp ?? '',
    resource: boundResourceEdition(state, profileId),
    locale: i18next.language,
  };
}

export async function profileCoverKey(key: string, locale: string, recipe: ReturnType<typeof creationParams>, code: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([locale, recipe, code]));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const suffix = Array.from(digest.subarray(0, 8), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${key.slice(0, 174)}~h4~${suffix}`;
}

export interface Cover {
  usesPlaceholder: boolean;
  url: string;
  /** 新建配方在 Worker 实际装载出的时长，不从时间段标称值或网格尺寸推算。 */
  duration: number;
  /** 悬停预览的帧网格（解码好的位图），没有时只显示封面 */
  sheet: ImageBitmap | null;
  frames: number;
  cols: number;
}

interface CoverState {
  covers: Record<string, Cover | null>;
}

export const useCoverStore = create<CoverState>(() => ({ covers: {} }));

export function coverKey(id: string, version: string): string {
  return `cover_${`${id}_${version}`.toLowerCase().replace(/[^a-z0-9_.~-]/g, '_')}`.slice(0, 190);
}

function toPng(canvas: OffscreenCanvas): Promise<Uint8Array> {
  return canvas.convertToBlob({ type: 'image/png' }).then(async (b) => new Uint8Array(await b.arrayBuffer()));
}

function blobUrl(png: Uint8Array): string {
  return URL.createObjectURL(new Blob([png as Uint8Array<ArrayBuffer>], { type: 'image/png' }));
}

class CoverService {
  private host: Promise<EngineHost> | null = null;
  private wanted = new Map<string, { entry: TemplateEntry; readers: number; players: number }>();
  private jobs = new Map<string, () => Promise<void>>();
  private running = false;

  constructor() {
    let context = JSON.stringify(coverResources());
    const refresh = () => {
      const nextContext = JSON.stringify(coverResources());
      if (context === nextContext) return;
      context = nextContext;
      this.reset();
    };
    useResourceStore.subscribe(refresh);
    useProjectStore.subscribe((next, previous) => {
      if (next.composition?.defaultProfile !== previous.composition?.defaultProfile) refresh();
    });
    i18next.on('languageChanged', refresh);
  }

  private reset(): void {
    const next = { ...useCoverStore.getState().covers };
    const rebuild = [...this.wanted];
    for (const [key] of rebuild) {
      releaseCover(next[key]);
      delete next[key];
      this.jobs.delete(key);
      this.jobs.delete(`${key}~sheet`);
    }
    useCoverStore.setState({ covers: next });
    for (const [, demand] of rebuild) this.request(demand.entry, false);
  }

  ensure(entries: readonly TemplateEntry[]): () => void {
    const releases = entries.filter(entry => !entry.baseMissing).map(entry => this.retain(entry, false));
    return () => releases.forEach(release => release());
  }

  animate(entry: TemplateEntry): () => void {
    return this.retain(entry, true);
  }

  private retain(entry: TemplateEntry, play: boolean): () => void {
    const key = coverKey(entry.id, entry.version);
    const demand = this.wanted.get(key) ?? { entry, readers: 0, players: 0 };
    this.wanted.set(key, demand);
    demand.readers++;
    if (play) demand.players++;
    if (!(key in useCoverStore.getState().covers)) this.request(entry, false);
    else if (play && useCoverStore.getState().covers[key] && !useCoverStore.getState().covers[key]?.sheet) this.request(entry, true);
    return () => {
      const next = { ...useCoverStore.getState().covers };
      const cover = next[key];
      if (play && --demand.players === 0) {
        this.jobs.delete(`${key}~sheet`);
        if (cover?.sheet) {
          cover.sheet.close();
          next[key] = { ...cover, sheet: null };
        }
      }
      if (--demand.readers === 0) {
        this.wanted.delete(key);
        this.jobs.delete(key);
        releaseCover(next[key]);
        delete next[key];
      }
      useCoverStore.setState({ covers: next });
    };
  }

  private request(entry: TemplateEntry, play: boolean): void {
    const { id, version } = entry;
    const key = coverKey(id, version);
    const jobKey = play ? `${key}~sheet` : key;
    if (this.jobs.has(jobKey)) return;
    const isCurrent = () => this.jobs.get(jobKey) === run;
    const run = async () => {
      try {
        const cover = await this.build(id, version, key, play, isCurrent);
        if (!isCurrent()) {
          releaseCover(cover);
          return;
        }
        if (play && cover) {
          useCoverStore.setState((state) => ({ covers: { ...state.covers, [key]: { ...cover, url: state.covers[key]!.url } } }));
        } else if (!play) {
          useCoverStore.setState((state) => ({ covers: { ...state.covers, [key]: cover } }));
        }
        if (cover && !play && this.wanted.get(key)?.players) this.request(entry, true);
      } catch (error) {
        console.warn(`[covers] ${key} failed: ${error instanceof Error ? error.message : String(error)}`);
        if (isCurrent() && !play) useCoverStore.setState((state) => ({ covers: { ...state.covers, [key]: null } }));
      } finally {
        if (isCurrent()) this.jobs.delete(jobKey);
      }
    };
    this.jobs.set(jobKey, run);
    if (!this.running) void this.drain();
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      while (this.jobs.size) {
        const jobs = [...this.jobs];
        const next = jobs.find(([key]) => key.endsWith('~sheet')) ?? jobs[0]!;
        await next[1]();
      }
    } finally {
      this.running = false;
      this.dispose();
    }
  }

  private async getHost(): Promise<EngineHost> {
    this.host ??= EngineHost.create({ mode: 'utility', resolveResource: (kind, id) => this.resolve(kind, id), strictDeterminism: import.meta.env.DEV });
    try {
      return await this.host;
    } catch (error) {
      this.host = null;
      throw error;
    }
  }

  private resolve = createResolver(null);

  private async build(id: string, version: string, key: string, play: boolean, isCurrent: () => boolean): Promise<Cover | null> {
    const { missing, profileId, resource, stamp, locale } = coverResources();
    if (missing) return null;
    const profiled = hasProfileDefaults(id);
    const source = await readTemplate(id, version);
    if (!source || !isCurrent()) return null;
    const recipe = creationParams(source, locale, resource);
    const diskKey = await profileCoverKey(key, locale, recipe, source.code);
    const diskOk = STAMP_RE.test(stamp);
    const cached = diskOk ? await window.allay.cache.getThumb(stamp, play ? `${diskKey}~sheet` : diskKey) : null;
    if (!isCurrent()) return null;
    if (play && cached) {
      const still = useCoverStore.getState().covers[key];
      if (!still) return null;
      return { ...still, url: '', sheet: await createImageBitmap(new Blob([cached as Uint8Array<ArrayBuffer>])) };
    }
    const host = await this.getHost();
    try {
      this.resolve = createResolver(source.assets, profileId);
      const still = await openStill(host, { source, params: recipe, width: COVER_W, height: COVER_H, fps: COVER_FPS, locale,
        referenceSize: COVER_REFERENCE_SIZE, ...(profileId === undefined ? {} : { profileId }) });
      const total = Math.min(profiled ? PROFILED_MAX_FRAMES : MAX_FRAMES, still.frames);
      const cols = profiled ? exactSheetColumns(total) : Math.min(SHEET_COLS, total);
      if (!isCurrent()) return null;
      const meta = { frames: total, cols, duration: still.duration, usesPlaceholder: still.usesPlaceholder };
      if (!play) {
        if (cached) return { ...meta, url: blobUrl(cached), sheet: null };
        const canvas = new OffscreenCanvas(COVER_W, COVER_H);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('2d context unavailable');
        context.putImageData(await still.at(still.cutTime ?? still.duration / 2, STILL_FAST), 0, 0);
        if (!isCurrent()) return null;
        const png = await toPng(canvas);
        if (diskOk && isCurrent()) await window.allay.cache.putThumb(stamp, diskKey, png).catch(() => undefined);
        return { ...meta, url: blobUrl(png), sheet: null };
      }
      const rows = Math.ceil(total / cols);
      const sheet = new OffscreenCanvas(cols * COVER_W, rows * COVER_H);
      const g = sheet.getContext('2d');
      if (!g) throw new Error('2d context unavailable');
      for (let i = 0; i < total; i++) {
        if (!isCurrent()) return null;
        // 封面只是缩略图：不加运动模糊，渲染快
        const img = await still.frame(i, STILL_FAST);
        g.putImageData(img, (i % cols) * COVER_W, Math.floor(i / cols) * COVER_H);
      }
      if (diskOk && isCurrent()) {
        const png = await toPng(sheet);
        if (isCurrent() && png.byteLength <= MAX_DISK_BYTES) await window.allay.cache.putThumb(stamp, `${diskKey}~sheet`, png).catch(() => undefined);
      }
      return { ...meta, url: '', sheet: sheet.transferToImageBitmap() };
    } catch (error) {
      if (host.dead) this.host = null;
      throw error;
    }
  }

  private dispose(): void {
    const h = this.host;
    this.host = null;
    void h?.then((x) => x.dispose(), () => undefined);
  }
}

function releaseCover(cover: Cover | null | undefined): void {
  if (!cover) return;
  if (cover.url) URL.revokeObjectURL(cover.url);
  cover.sheet?.close();
}

/** 版本封面的网格不补透明帧，从磁盘读取时能按尺寸还原准确的循环时长。 */
function exactSheetColumns(frames: number): number {
  for (let cols = Math.min(SHEET_COLS, frames); cols >= 3; cols--) {
    if (frames % cols === 0) return cols;
  }
  return Math.min(SHEET_COLS, frames);
}

export const covers = new CoverService();
