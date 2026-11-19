// 宿主一侧的 resolveResource（docs/02-engine.md 2.3、01-product-architecture.md 1.5）：
// 引擎 Worker 要资源 → 这里经 IPC 向主进程的资源栈要原始文件 → 在渲染进程里解码 → 交给 Worker。
// Worker 自己不能读任何东西。解码结果按 resourceStamp 缓存；资源栈一变就清空。
import { decodePng, type DecodedImage } from '@allay/assets';
import {
  FontRefSchema,
  normalizeRequestedFont,
  MAX_TEXTURE_SIZE,
  type FontPayload,
  type FontProviderPayload,
  type ResourceKind,
  type ResourcePayload,
  type SoundMetaPayload,
} from '@allay/template-sdk';
import { SkinPixelsSchema, SkinRefSchema } from '../../shared/skins';
import { FontBytesSchema, FontProvidersResultSchema } from '../../shared/fonts';
import { currentStamp, useResourceStore } from '../stores/resourceStore';
import { assetKey, type AssetSource } from '../templates/catalog';

/** 浏览器自带的 zlib 解压，给 PNG 解码用（不需要 WebAssembly，CSP 不用放宽） */
async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function decodeImage(png: Uint8Array): Promise<DecodedImage> {
  return decodePng(png, inflate);
}

const cache = new Map<string, Promise<ResourcePayload | null>>();

export function profileStamp(profileId?: string): string {
  if (profileId === undefined) return currentStamp();
  const profile = useResourceStore.getState().state?.library?.profiles.find((entry) => entry.id === profileId);
  return `${profileId}:${profile?.stamp || 'missing'}`;
}

// 资源栈一变就丢掉缓存（引擎那边由 load 时带的新 stamp 清空自己的缓存）
useResourceStore.subscribe((state, previous) => {
  const before = new Map(previous.state?.library?.profiles.map((profile) => [profile.id, profile.stamp]));
  for (const profile of state.state?.library?.profiles ?? []) if (profile.stamp === before.get(profile.id)) before.delete(profile.id);
  for (const key of cache.keys()) {
    const [scope] = JSON.parse(key) as [string | null];
    if (scope === null ? state.state?.stamp !== previous.state?.stamp : before.has(scope)) cache.delete(key);
  }
});

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

/** PNG 自己解码（保留直通 alpha 的精度）；JPG、WebP 交给浏览器解码 */
async function decodeAnyImage(bytes: Uint8Array): Promise<DecodedImage> {
  if (PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return decodeImage(bytes);
  const bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>]), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  try {
    if (bitmap.width > MAX_TEXTURE_SIZE || bitmap.height > MAX_TEXTURE_SIZE) throw new Error('image too large');
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const g = canvas.getContext('2d');
    if (!g) throw new Error('no 2d context');
    g.drawImage(bitmap, 0, 0);
    const data = g.getImageData(0, 0, bitmap.width, bitmap.height).data;
    return { width: bitmap.width, height: bitmap.height, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
  } finally {
    bitmap.close();
  }
}

/** 模板包 assets/ 里的图片（asset:路径）和用户选的图片（file:引用） */
async function loadImageTexture(id: string, assets: AssetSource | null): Promise<ResourcePayload | null> {
  let bytes: Uint8Array | null = null;
  if (id.startsWith('asset:')) {
    if (!assets) return null;
    bytes = await window.allay.templates.readAsset(assets, id.slice('asset:'.length));
  } else if (id.startsWith('file:')) {
    bytes = await window.allay.files.read(id.slice('file:'.length));
  }
  if (!bytes) return null;
  const img = await decodeAnyImage(bytes);
  return { kind: 'rgba', width: img.width, height: img.height, data: img.data };
}

async function loadTexture(id: string, profileId?: string): Promise<ResourcePayload | null> {
  const raw = await window.allay.resources.readTexture(id, profileId);
  if (!raw) return null;
  const img = await decodeImage(raw.png);
  return { kind: 'rgba', width: img.width, height: img.height, data: img.data, ...(raw.mcmeta !== null ? { mcmeta: raw.mcmeta } : {}) };
}

async function loadFont(id: string, profileId?: string): Promise<FontPayload | null> {
  if (!FontRefSchema.safeParse(id).success) return null;
  const result = FontProvidersResultSchema.safeParse(await window.allay.resources.fontProviders(id, profileId));
  if (!result.success) return null;
  const def = result.data;
  const providers: FontProviderPayload[] = [];
  const skipped = [...def.skipped];
  let budget = 40 * 1024 * 1024;
  for (const p of def.providers) {
    if (p.type === 'space') {
      providers.push(p);
      continue;
    }
    if (p.type === 'unihex') {
      providers.push(p);
      continue;
    }
    if (p.type !== 'bitmap') {
      const bytes = FontBytesSchema.safeParse(await window.allay.resources.read(p.file, profileId).catch(() => null));
      if (bytes.success && bytes.data.byteLength <= budget) {
        budget -= bytes.data.byteLength;
        providers.push({ type: p.type, bytes: bytes.data, size: p.size, oversample: p.oversample, shift: p.shift, skip: p.skip });
      } else skipped.push(`unavailable(${p.file})`);
      continue;
    }
    const png = await window.allay.resources.read(p.file, profileId);
    if (!png) {
      skipped.push(`missing(${p.file})`);
      continue;
    }
    try {
      const image = await decodeImage(png);
      if (image.data.byteLength > budget) throw new Error('font exceeds memory budget');
      budget -= image.data.byteLength;
      providers.push({ type: 'bitmap', ascent: p.ascent, height: p.height, rows: p.rows, image });
    } catch {
      skipped.push(`undecodable(${p.file})`);
    }
  }
  return { kind: 'font', providers, skipped: skipped.slice(0, 256) };
}

/** 音效事件的全部变体（引擎据此给 cue 选定变体，02-engine.md 2.10）；资源栈里没有这个事件时为 null */
async function loadSoundMeta(id: string, profileId?: string): Promise<SoundMetaPayload | null> {
  const variants = await window.allay.resources.soundVariants(id, profileId);
  return variants ? { kind: 'sound', variants } : null;
}

/**
 * 引擎的 resolveResource（只有资源栈，没有模板自带的图片：缩略图用）。
 * 每次返回一份新的副本：载荷会被零拷贝转移给 Worker，转移后原对象就不能用了。
 */
export function resolveResource(kind: ResourceKind, id: string): Promise<ResourcePayload | null> {
  return resolveWith(kind, id, null);
}

/** 带模板自带图片的 resolveResource：asset: 从 getAssets() 指的模板读（预览换模板时它跟着变） */
export function createResolver(source: AssetSource | null | (() => AssetSource | null), profileId?: string): (kind: ResourceKind, id: string) => Promise<ResourcePayload | null> {
  return (kind, id) => resolveWith(kind, id, typeof source === 'function' ? source() : source, profileId);
}

/** 模板文件夹里的图片被改过（模板开发模式的热重载，H9）：丢掉这个模板的 asset: 解码缓存 */
export function forgetTemplateAssets(assets: AssetSource | null): void {
  const key = assetKey(assets);
  if (!key) return;
  for (const cacheKey of cache.keys()) {
    const [, , , sourceKey] = JSON.parse(cacheKey) as [string | null, string, ResourceKind, string];
    if (sourceKey === key) cache.delete(cacheKey);
  }
}

/** 交给引擎 load 的分代键：资源栈的 stamp 加上模板（asset: 引用随模板变，引擎据此清空贴图缓存） */
export function loadStamp(assets: AssetSource | null, profileId?: string): string {
  const key = assetKey(assets);
  const stamp = profileStamp(profileId);
  return key ? `${stamp}|${key}` : stamp;
}

async function resolveWith(kind: ResourceKind, id: string, assets: AssetSource | null, profileId?: string): Promise<ResourcePayload | null> {
  if (kind === 'texture' && id.startsWith('skins:')) {
    if (!SkinRefSchema.safeParse(id).success) return null;
    const skin = SkinPixelsSchema.safeParse(await window.allay.skins?.read(id));
    return skin.success ? { kind: 'rgba', ...skin.data } : null;
  }
  if (kind === 'font') id = normalizeRequestedFont(id);
  const image = kind === 'texture' && /^(asset|file):/.test(id);
  const key = JSON.stringify([profileId ?? null, profileStamp(profileId), kind, image && id.startsWith('asset:') ? assetKey(assets) : '', id]);
  let entry = cache.get(key);
  if (!entry) {
    entry = image
      ? loadImageTexture(id, assets)
      : kind === 'texture'
        ? loadTexture(id, profileId)
        : kind === 'font'
          ? loadFont(id, profileId)
          : kind === 'sound-meta'
            ? loadSoundMeta(id, profileId)
            : Promise.resolve(null);
    entry = entry.catch((error: unknown) => {
      console.warn(`[resources] ${key} failed: ${error instanceof Error ? error.message : String(error)}`);
      if (cache.get(key) === entry) cache.delete(key);
      return null;
    });
    cache.set(key, entry);
    if (kind === 'font') {
      const keys = [...cache.keys()].filter((cacheKey) => (JSON.parse(cacheKey) as unknown[])[2] === 'font');
      for (const old of keys.slice(0, Math.max(0, keys.length - 8))) cache.delete(old);
    }
  }
  const payload = await entry;
  return payload ? structuredClone(payload) : null;
}
