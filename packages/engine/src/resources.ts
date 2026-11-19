// 引擎里的资源缓存（docs/02-engine.md 2.3、2.8）：经宿主的 resolveResource 取资源，做成 Three 的贴图。
// 缓存按 resourceStamp 分代：stamp 变了就整个清空。动画贴图（.mcmeta）在每个子帧按 t 更新 UV（2.8）。
import { animationFrameAt, frameRect, layoutAnimation, parseAnimationMeta, parseGuiNineSlice, type AnimationLayout, type NineSlice } from '@allay/assets';
import {
  DEFAULT_FONT_ID,
  FontPayloadSchema,
  normalizeRequestedFont,
  SoundMetaPayloadSchema,
  TexturePayloadSchema,
  type SoundMetaVariant,
  type FontPayload,
  type ResourceKind,
  type ResourcePayload,
} from '@allay/template-sdk';
import * as THREE from 'three';
import { catalogPlaceholder } from './catalog-placeholder';

export type ResolveResource = (kind: ResourceKind, id: string) => Promise<ResourcePayload | null>;
export type Warn = (message: string, code?: 'catalog-placeholder') => void;

/** 贴图上挂的 CPU 侧信息（物品挤出、文字、九宫格要用） */
export interface TextureInfo {
  id: string;
  /** 整张图，RGBA8 直通 alpha，第一行是顶部 */
  pixels: Uint8Array;
  width: number;
  height: number;
  /** 一帧的尺寸（没有动画时就是整张图） */
  frameWidth: number;
  frameHeight: number;
  animation: AnimationLayout | null;
  /** 界面贴图的九宫格（.mcmeta 的 gui.scaling） */
  nineSlice: NineSlice | null;
  missing: boolean;
}

export function textureInfo(texture: THREE.Texture): TextureInfo | null {
  const info = (texture.userData as { allay?: TextureInfo }).allay;
  return info ?? null;
}

/** 贴图：放大用 Nearest，缩小用 LinearMipmapLinear 并生成 mipmap（2.8）；sRGB 编码 */
export function makeDataTexture(width: number, height: number, topFirst: Uint8Array): THREE.DataTexture {
  // 载荷第一行是顶部；DataTexture 不翻转，第一行对应 v = 0（底部），所以在 CPU 上翻一次
  const data = new Uint8Array(topFirst.length);
  const row = width * 4;
  for (let y = 0; y < height; y++) data.set(topFirst.subarray((height - 1 - y) * row, (height - y) * row), y * row);
  const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}

/** 品红与黑的棋盘（8 像素一格），16×16。贴图缺失时的占位（3.2） */
export function placeholderPixels(): Uint8Array {
  const data = new Uint8Array(16 * 16 * 4);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const on = ((x >> 3) + (y >> 3)) % 2 === 0;
      data.set(on ? [248, 0, 248, 255] : [0, 0, 0, 255], (y * 16 + x) * 4);
    }
  return data;
}

function attachInfo(tex: THREE.Texture, info: TextureInfo): void {
  (tex.userData as { allay?: TextureInfo }).allay = info;
}

/** 把动画贴图的 UV 变换设到第 index 帧 */
function showFrame(tex: THREE.Texture, info: TextureInfo, index: number): void {
  const layout = info.animation;
  if (!layout) return;
  const r = frameRect(layout, info.width, index);
  // CPU 上翻过行：图里从顶部数第 y 行，在贴图里是 v = 1 - y / H
  tex.offset.set(r.x / info.width, 1 - (r.y + r.height) / info.height);
}

interface TextureEntry {
  result: Promise<THREE.Texture | null>;
  retryRequired: boolean;
}

export class EngineResources {
  private stamp: string | null = null;
  private readonly textures = new Map<string, TextureEntry>();
  private readonly animated = new Set<THREE.Texture>();
  private placeholder: THREE.Texture | null = null;
  private readonly catalogPlaceholders = new Map<string, THREE.Texture>();
  private readonly fontCache = new Map<string, Promise<FontPayload | null>>();

  constructor(
    private readonly resolve: ResolveResource,
    private readonly log: (level: 'debug' | 'warn' | 'error', message: string) => void,
  ) {}

  /** 资源栈变了：清空贴图和资源栈字体。 */
  setStamp(stamp: string): void {
    if (stamp === this.stamp) return;
    this.stamp = stamp;
    this.clear();
  }

  clear(): void {
    for (const tex of this.catalogPlaceholders.values()) tex.dispose();
    this.catalogPlaceholders.clear();
    for (const entry of this.textures.values()) void entry.result.then((tex) => tex?.dispose());
    this.textures.clear();
    this.animated.clear();
    this.fontCache.clear();
    this.sounds.clear();
  }

  private readonly sounds = new Map<string, Promise<readonly SoundMetaVariant[]>>();

  /**
   * 音效事件的全部变体（资源栈里合并后的 sounds.json，展开 event 引用之后），按 stamp 缓存。
   * 宿主没有这个事件时是空数组；取不到（宿主出错）也当作空数组，不让模板装载失败。
   */
  soundVariants(eventId: string): Promise<readonly SoundMetaVariant[]> {
    let p = this.sounds.get(eventId);
    if (!p) {
      p = this.resolve('sound-meta', eventId).then(
        (raw) => {
          if (!raw) return [];
          const parsed = SoundMetaPayloadSchema.safeParse(raw);
          if (parsed.success) return parsed.data.variants;
          this.log('warn', `invalid sound-meta payload for ${eventId}`);
          return [];
        },
        (error: unknown) => {
          this.log('warn', `sound-meta ${eventId} failed: ${error instanceof Error ? error.message : String(error)}`);
          return [];
        },
      );
      this.sounds.set(eventId, p);
    }
    return p;
  }

  dispose(): void {
    this.clear();
    this.placeholder?.dispose();
    this.placeholder = null;
  }

  /** 每个子帧调用：所有动画贴图切到 t 时刻的帧（2.8） */
  applyAnimations(t: number): void {
    for (const tex of this.animated) {
      const info = textureInfo(tex);
      if (info?.animation) showFrame(tex, info, animationFrameAt(info.animation, t));
    }
  }

  /** 设好过滤和色彩空间的贴图；缺失时返回占位图并经 warn 记一条警告（3.2、T-AST-3） */
  texture(id: string, warn: Warn): Promise<THREE.Texture> {
    if (typeof id !== 'string' || id.length === 0 || id.length > 512) return Promise.reject(new TypeError('invalid texture id'));
    const cached = this.textures.get(id);
    const entry = cached && !cached.retryRequired ? cached : this.loadTexture(id);
    return entry.result.then((tex) => {
      if (tex) return tex;
      const placeholder = this.requiredPlaceholder(id);
      warn(`texture ${id} is missing; a placeholder is used`, placeholder === this.placeholder ? undefined : 'catalog-placeholder');
      return placeholder;
    });
  }

  optionalTexture(id: string): Promise<THREE.Texture | null> {
    if (typeof id !== 'string' || id.length === 0 || id.length > 512) return Promise.reject(new TypeError('invalid texture id'));
    return (this.textures.get(id) ?? this.loadTexture(id)).result;
  }

  private requiredPlaceholder(id: string): THREE.Texture {
    const existing = this.catalogPlaceholders.get(id);
    if (existing) return existing;
    const image = catalogPlaceholder(id);
    if (!image) return this.placeholderTexture();
    const { width, height, pixels, nineSlice } = image;
    const texture = makeDataTexture(width, height, pixels);
    attachInfo(texture, { id, pixels, width, height, frameWidth: width, frameHeight: height, nineSlice, animation: null, missing: true });
    this.catalogPlaceholders.set(id, texture);
    return texture;
  }

  private loadTexture(id: string): TextureEntry {
    const entry: TextureEntry = {
      retryRequired: false,
      result: this.fetchTexture(id).then((tex) => {
        if (!tex) entry.retryRequired = true;
        if (tex && this.textures.get(id) === entry && textureInfo(tex)?.animation) this.animated.add(tex);
        return tex;
      }).catch((error: unknown) => {
        entry.retryRequired = true;
        this.log('warn', `texture ${id} failed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }),
    };
    this.textures.set(id, entry);
    return entry;
  }

  placeholderTexture(): THREE.Texture {
    if (!this.placeholder) {
      const pixels = placeholderPixels();
      this.placeholder = makeDataTexture(16, 16, pixels);
      attachInfo(this.placeholder, { id: 'placeholder', pixels, width: 16, height: 16, frameWidth: 16, frameHeight: 16, animation: null, nineSlice: null, missing: true });
    }
    return this.placeholder;
  }

  private async fetchTexture(id: string): Promise<THREE.Texture | null> {
    const raw = await this.resolve('texture', id);
    if (raw === null) return null;
    const payload = TexturePayloadSchema.parse(raw);
    let animation: AnimationLayout | null = null;
    let nineSlice: NineSlice | null = null;
    if (payload.mcmeta !== undefined) {
      const meta = parseAnimationMeta(payload.mcmeta);
      if (meta) {
        animation = layoutAnimation(meta, payload.width, payload.height);
        if (!animation) this.log('warn', `texture ${id}: animation metadata does not fit the image; shown as a still image`);
      }
      nineSlice = parseGuiNineSlice(payload.mcmeta);
    }
    const tex = makeDataTexture(payload.width, payload.height, payload.data);
    const info: TextureInfo = {
      id,
      pixels: payload.data,
      width: payload.width,
      height: payload.height,
      frameWidth: animation?.frameWidth ?? payload.width,
      frameHeight: animation?.frameHeight ?? payload.height,
      animation,
      nineSlice,
      missing: false,
    };
    attachInfo(tex, info);
    if (animation) {
      tex.repeat.set(animation.frameWidth / payload.width, animation.frameHeight / payload.height);
      showFrame(tex, info, animationFrameAt(animation, 0));
    }
    return tex;
  }

  /** 文字用的字体，在每次 setup 之前载入（text.create 是同步的） */
  async fonts(requested = DEFAULT_FONT_ID): Promise<FontPayload | null> {
    const id = normalizeRequestedFont(requested);
    let font = this.fontCache.get(id);
    if (!font) {
      font = this.resolve('font', id).then((raw) => raw === null ? null : FontPayloadSchema.parse(raw)).catch((error: unknown) => {
        this.log('warn', `font ${id} failed: ${String(error)}`);
        return null;
      });
      this.fontCache.set(id, font);
      if (this.fontCache.size > 8) this.fontCache.delete(this.fontCache.keys().next().value!);
    }
    return font;
  }
}
