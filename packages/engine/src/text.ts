// 文字：逐字查询所选资源栈字体、minecraft:default、本机系统字体。
import { glyphInkWidth, GLYPH_SPACING, outlineCoverage, SPACE_ADVANCE } from '@allay/assets';
import { DEFAULT_FONT_ID, normalizeRequestedFont, FontUsageFlag } from '@allay/template-sdk';
import type { FontPayload, FontProviderPayload, SetupContext, TextObject, TextOptions } from '@allay/template-sdk';
import * as THREE from 'three';
import { makeDataTexture, type Warn } from './resources';
import { isScalar, systemGlyph, type GlyphRaster } from './system-glyphs';

type BitmapProvider = Extract<FontProviderPayload, { type: 'bitmap' }>;

/** 一个字形的栅格：在字体像素坐标里的位置（相对基线，y 向下）和前进宽度 */
interface Glyph extends GlyphRaster {
  /** 这一字形在基线以上、以下占的像素（排行高用） */
  above: number;
  below: number;
  system?: true;
  gui?: GlyphRaster;
}

type Lookup = (cp: number) => Glyph | null;
const fontSet = 'document' in globalThis ? undefined : (globalThis as { fonts?: FontFaceSet }).fonts;
let nextFace = 0;

async function outlineLookup(provider: Extract<FontProviderPayload, { type: 'ttf' }>): Promise<Lookup | null> {
  const covers = outlineCoverage(provider.bytes);
  if (!covers || !fontSet || typeof OffscreenCanvas === 'undefined') return null;
  const name = `AllayAnimationFace${++nextFace}`;
  const face = await new FontFace(name, new Uint8Array(provider.bytes).buffer).load();
  const skip = new Set(Array.from(provider.skip, (char) => char.codePointAt(0)));
  const canvas = new OffscreenCanvas(1, 1);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  const sample = Math.max(1, Math.floor(Math.min(provider.oversample, 256 / provider.size)));
  const settings = `${provider.size * sample}px "${name}"`;
  return (cp) => {
    if (skip.has(cp) || !covers(cp)) return null;
    fontSet.add(face);
    try {
      const char = String.fromCodePoint(cp);
      ctx.font = settings;
      const metrics = ctx.measureText(char);
      const advance = Math.round(metrics.width / sample);
      const left = Math.floor(-metrics.actualBoundingBoxLeft / sample);
      const top = Math.floor(-metrics.actualBoundingBoxAscent / sample);
      const w = Math.ceil(metrics.actualBoundingBoxRight / sample) - left;
      const h = Math.ceil(metrics.actualBoundingBoxDescent / sample) - top;
      if (![w, h, advance, left, top].every(Number.isFinite) || w < 0 || h < 0 || w > 256 || h > 256 || advance < 0 || advance > 256 || Math.abs(left) > 256 || Math.abs(top) > 256) return null;
      const dx = left + Math.round(provider.shift[0]);
      const dy = top + Math.round(provider.shift[1]);
      if (!w || !h) return { advance, dx, dy, w: 0, h: 0, above: 0, below: 0, alpha: () => 0 };
      const scale = sample;
      canvas.width = w * scale;
      canvas.height = h * scale;
      ctx.font = settings;
      ctx.fillText(char, -left * sample, -top * sample);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const bitmap = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let alpha = 0;
        for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) alpha += data[4 * ((y * scale + sy) * canvas.width + x * scale + sx) + 3]!;
        bitmap[y * w + x] = Math.round(alpha / (scale * scale));
      }
      return {
        advance, dx, dy, w, h, above: Math.max(0, -dy), below: Math.max(0, dy + h), alpha: (x, y) => bitmap[y * w + x]!,
        gui: { advance, dx, dy, w, h, sourceDensity: scale, alpha: (x, y) => data[4 * (y * w * scale + x) + 3] ?? 0 },
      };
    } catch {
      return null;
    } finally {
      fontSet.delete(face);
    }
  };
}

/** 资源字体缓存与系统字体缓存独立，不在每个模板实例里重复缓存系统遮罩。 */
class ResourceGlyphs {
  private readonly cache = new Map<number, Glyph | null>();
  constructor(private readonly layers: readonly Lookup[]) {}

  glyph = (cp: number): Glyph | null => {
    const hit = this.cache.get(cp);
    if (hit !== undefined) return hit;
    let found: Glyph | null = null;
    for (const layer of this.layers) if ((found = layer(cp))) break;
    if (this.cache.size >= 512) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(cp, found);
    return found;
  };
}

export class GlyphSource {
  constructor(private readonly layers: readonly Lookup[]) {}

  glyph(cp: number): Glyph | null {
    if (!isScalar(cp)) return null;
    for (const layer of this.layers) {
      const found = layer(cp);
      if (found) return found;
    }
    return systemGlyph(cp);
  }

  missingGlyph(): Glyph | null {
    return this.glyph(0xfffd) ?? this.glyph(0x3f);
  }
}

function bitmapLookup(provider: BitmapProvider): Lookup | null {
  const { rows, image, ascent, height } = provider;
  const cols = Math.max(0, ...rows.map((row) => row.length));
  if (!cols || image.width % cols || image.height % rows.length) return null;
  const cellWidth = image.width / cols;
  const cellHeight = image.height / rows.length;
  const scale = height / cellHeight;
  const cells = new Map<number, { row: number; col: number }>();
  rows.forEach((row, y) => row.forEach((cp, x) => {
    if (cp && !cells.has(cp)) cells.set(cp, { row: y, col: x });
  }));
  return (cp) => {
    const cell = cells.get(cp);
    if (!cell) return null;
    const left = cell.col * cellWidth;
    const top = cell.row * cellHeight;
    const src = (x: number, y: number) => image.data[((top + y) * image.width + left + x) * 4 + 3] ?? 0;
    const ink = glyphInkWidth(cellWidth, cellHeight, src);
    const advance = cp === 0x20 ? SPACE_ADVANCE : Math.floor(0.5 + ink * scale) + GLYPH_SPACING;
    return {
      advance, dx: 0, dy: -ascent, w: Math.round(ink * scale), h: height,
      alpha: (x, y) => src(Math.min(cellWidth - 1, Math.floor(x / scale)), Math.min(cellHeight - 1, Math.floor(y / scale))),
      above: ascent, below: Math.max(0, height - ascent),
      gui: { advance, dx: 0, dy: -ascent, w: ink * scale, h: height, sourceDensity: 1 / scale, alpha: src },
    };
  };
}

function providerLookup(provider: Exclude<FontProviderPayload, { type: 'ttf' }>): Lookup | null {
  if (provider.type === 'bitmap') return bitmapLookup(provider);
  if (provider.type === 'space') {
    const advances = new Map(provider.advances.slice().reverse());
    return (cp) => {
      const advance = advances.get(cp);
      return advance === undefined ? null : { advance, dx: 0, dy: 0, w: 0, h: 0, alpha: () => 0, above: 0, below: 0 };
    };
  }
  const { codepoints, metrics, offsets, bits, ascent, descent } = provider.tables;
  return (cp) => {
    let low = 0;
    let high = codepoints.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (codepoints[mid]! < cp) low = mid + 1;
      else high = mid;
    }
    if (codepoints[low] !== cp) return null;
    const row = low * 5;
    const [advance, width, height, left, bottom] = [metrics[row]!, metrics[row + 1]!, metrics[row + 2]!, metrics[row + 3]!, metrics[row + 4]!];
    const stride = Math.ceil(width / 8);
    const offset = offsets[low]!;
    if (width <= 0 || height !== 16 || offset + height * stride > bits.length) return null;
    const alpha = (x: number, y: number) => (bits[offset + y * stride + (x >> 3)]! & (0x80 >> (x & 7))) ? 255 : 0;
    return {
      advance, dx: left, dy: -(bottom + height), w: width, h: height, alpha, above: ascent, below: descent,
      gui: { advance: Math.floor(width / 2) + 1, dx: 0, dy: -7, w: width / 2, h: height / 2, sourceDensity: 2, alpha },
    };
  };
}

export function createGlyphSource(font: FontPayload | null): GlyphSource {
  const layers: Lookup[] = [];
  for (const provider of font?.providers ?? []) {
    if (provider.type === 'ttf') continue;
    const lookup = providerLookup(provider);
    if (lookup) layers.push(lookup);
  }
  return new GlyphSource([new ResourceGlyphs(layers).glyph]);
}

async function prepareResourceGlyphs(font: FontPayload | null, warn: Warn): Promise<ResourceGlyphs | null> {
  const layers: Lookup[] = [];
  for (const skipped of font?.skipped.slice(0, 3) ?? []) warn(`text: skipped font provider: ${skipped}`);
  for (const provider of font?.providers ?? []) {
    const lookup = provider.type === 'ttf' ? await outlineLookup(provider).catch(() => null) : providerLookup(provider);
    if (lookup) layers.push(lookup);
    else warn(`text: unable to load ${provider.type} font provider; using available fallback glyphs`);
  }
  return layers.length ? new ResourceGlyphs(layers) : null;
}

/** 每个模板实例的字体选择；未就绪时同步创建也不会触发 I/O。 */
export async function setupText(fontIds: string[], load: (id: string) => Promise<FontPayload | null>, warn: Warn, owned: THREE.Texture[], isSetup: () => boolean, reportFontUsage?: (flags: number) => void): Promise<SetupContext['text']> {
  const vanilla = await prepareResourceGlyphs(await load(DEFAULT_FONT_ID), warn);
  const defaults = vanilla ? [vanilla.glyph] : [];
  const automatic = new GlyphSource(defaults);
  const sources = new Map<string, GlyphSource>([[DEFAULT_FONT_ID, automatic]]);
  const pending = new Map<string, Promise<void>>();
  const prepare = (requested: string): Promise<void> => {
    const id = normalizeRequestedFont(requested);
    if (sources.has(id)) return Promise.resolve();
    const existing = pending.get(id);
    if (existing) return existing;
    if (!isSetup() || sources.size + pending.size >= 17) return Promise.resolve();
    const task = load(id).then(async (fonts) => {
      const resource = await prepareResourceGlyphs(fonts, warn);
      if (!resource) warn(`text: font ${id} is unavailable; using minecraft:default and system fallback`);
      sources.set(id, resource ? new GlyphSource([resource.glyph, ...defaults]) : automatic);
    }).finally(() => pending.delete(id));
    pending.set(id, task);
    return task;
  };
  for (const id of new Set(fontIds)) await prepare(id);
  const sourceFor = (font?: string) => {
    const source = sources.get(normalizeRequestedFont(font));
    if (!source) warn('text: font was not prepared; using minecraft:default and system fallback');
    return source ?? automatic;
  };
  return {
    prepare,
    measureGui(text, font) {
      const { advance, width, left, above, below } = guiLine(text, sourceFor(font));
      return { advance, width, left, above, below };
    },
    create(opts) {
      return createText(opts, sourceFor(opts?.font), warn, owned, reportFontUsage);
    },
  };
}

interface PositionedGlyph {
  glyph: GlyphRaster;
  left: number;
  system: boolean;
}

function guiLine(text: string, source: GlyphSource, onMissing?: (cp: number) => void) {
  const glyphs: PositionedGlyph[] = [];
  let advance = 0;
  let left = 0;
  let right = 0;
  let above = 0;
  let below = 0;
  let density = 1;
  for (const character of String(text).slice(0, 10_000).split(/[\r\n]/, 1)[0]!) {
    const cp = character.codePointAt(0)!;
    const found = source.glyph(cp);
    if (!found) onMissing?.(cp);
    const entry = found ?? source.missingGlyph();
    if (!entry) continue;
    const glyph = entry.gui ?? entry;
    if (glyph.w > 0 && glyph.h > 0) {
      const x = advance + glyph.dx;
      left = Math.min(left, x);
      right = Math.max(right, x + glyph.w);
      above = Math.max(above, -glyph.dy);
      below = Math.max(below, glyph.dy + glyph.h);
      density = Math.max(density, glyph.sourceDensity ?? 1);
      glyphs.push({ glyph, left: x, system: entry.system === true });
    }
    advance += glyph.advance;
  }
  return { glyphs, left, advance, width: Math.max(0, advance, right) - left, above, below, density };
}

const MAX_RASTER_SIDE = 4096;

function makeRaster(width: number, height: number, desiredDensity: number): RasterText {
  const density = Math.max(1, Math.min(8, Math.ceil(desiredDensity), Math.floor(MAX_RASTER_SIDE / Math.max(1, width, height))));
  width = Math.min(MAX_RASTER_SIDE, Math.max(1, Math.ceil(width * density)));
  height = Math.min(MAX_RASTER_SIDE, Math.max(1, Math.ceil(height * density)));
  return { width, height, pixels: new Uint8Array(width * height * 4), density, fontUsage: 0 };
}

/** 缩采样系统墨迹时累计覆盖率；游戏字形仍使用其原有的最近邻规则。 */
function systemAlpha(glyph: GlyphRaster, sx: number, sy: number, density: number): number {
  const sourceDensity = glyph.sourceDensity ?? 1;
  const radius = sourceDensity / (2 * density);
  const left = sx * sourceDensity - radius;
  const top = sy * sourceDensity - radius;
  const right = left + 2 * radius;
  const bottom = top + 2 * radius;
  let alpha = 0;
  for (let row = Math.max(0, Math.floor(top)); row < Math.min(glyph.h * sourceDensity, Math.ceil(bottom)); row++) {
    const yCoverage = Math.min(row + 1, bottom) - Math.max(row, top);
    for (let column = Math.max(0, Math.floor(left)); column < Math.min(glyph.w * sourceDensity, Math.ceil(right)); column++) {
      const xCoverage = Math.min(column + 1, right) - Math.max(column, left);
      alpha += glyph.alpha(column, row) * xCoverage * yCoverage;
    }
  }
  return Math.round(alpha / (4 * radius * radius));
}

function paintLine(raster: RasterText, glyphs: PositionedGlyph[], origin: number, baseline: number): number {
  const { width, height, pixels, density } = raster;
  let sources = 0;
  for (const { glyph, left, system } of glyphs) {
    const x0 = left + origin;
    const y0 = baseline + glyph.dy;
    const sourceDensity = glyph.sourceDensity ?? 1;
    const downsample = system && sourceDensity > density;
    const right = Math.min(width, Math.ceil((x0 + glyph.w) * density));
    const bottom = Math.min(height, Math.ceil((y0 + glyph.h) * density));
    let ink = false;
    for (let y = Math.max(0, Math.floor(y0 * density)); y < bottom; y++) {
      const sy = (y + 0.5) / density - y0;
      if (!downsample && (sy < 0 || sy >= glyph.h)) continue;
      const sourceY = Math.floor(sy * sourceDensity);
      for (let x = Math.max(0, Math.floor(x0 * density)); x < right; x++) {
        const sx = (x + 0.5) / density - x0;
        if (!downsample && (sx < 0 || sx >= glyph.w)) continue;
        const alpha = downsample ? systemAlpha(glyph, sx, sy, density) : glyph.alpha(Math.floor(sx * sourceDensity), sourceY);
        if (!alpha) continue;
        ink = true;
        const offset = (y * width + x) * 4;
        pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 255;
        pixels[offset + 3] = Math.max(pixels[offset + 3]!, alpha);
      }
    }
    if (ink) sources |= system ? 1 : 2;
  }
  return lineFontUsage(sources);
}

function rasterizeGui(line: ReturnType<typeof guiLine>): RasterText {
  const raster = makeRaster(line.width, line.above + line.below, line.density);
  raster.fontUsage = paintLine(raster, line.glyphs, -line.left, line.above);
  return raster;
}

function lineFontUsage(sources: number): number {
  return sources === 3 ? FontUsageFlag.partial : sources === 1 ? FontUsageFlag.whole : 0;
}

function isCjk(cp: number): boolean {
  return (cp >= 0x1100 && cp <= 0x11ff) || (cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0xac00 && cp <= 0xd7ff) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xffef) || (cp >= 0x20000 && cp <= 0x323af);
}

interface Line {
  glyphs: (PositionedGlyph & { glyph: Glyph })[];
  width: number;
  inset: number;
}

/** 断行：显式换行；超过 maxWidth（字体像素）时在空格处断，中日韩字符可以逐字断 */
function layoutLines(text: string, source: GlyphSource, maxWidth: number, onMissing: (cp: number) => void): Line[] {
  const lines: Line[] = [];
  for (const para of text.split(/\r\n?|\n/)) {
    const cps = Array.from(para, (ch) => ch.codePointAt(0) ?? 0);
    let cur: { cp: number; g: Glyph }[] = [];
    let width = 0;
    let breakAt = -1;
    const flush = (items: { cp: number; g: Glyph }[]) => {
      // 行尾的空格不算宽度
      let end = items.length;
      while (end > 0 && items[end - 1]!.cp === 0x20) end--;
      let pen = 0;
      let left = 0;
      let right = 0;
      const glyphs = items.slice(0, end).map(({ g: glyph }) => {
        const start = (glyph.system ? pen : Math.round(pen)) + glyph.dx;
        if (glyph.w) {
          left = Math.min(left, start);
          right = Math.max(right, start + glyph.w);
        }
        pen += glyph.advance;
        return { glyph, left: start, system: glyph.system === true };
      });
      lines.push({ glyphs, width: Math.ceil(Math.max(pen, right) - left), inset: -left });
    };
    for (const cp of cps) {
      let g = source.glyph(cp);
      if (!g) {
        onMissing(cp);
        g = source.missingGlyph();
        if (!g) continue;
      }
      if (maxWidth > 0 && width + g.advance > maxWidth && cur.length > 0 && cp !== 0x20) {
        if (isCjk(cp) || breakAt < 0) {
          flush(cur);
          cur = [];
          width = 0;
          breakAt = -1;
        } else {
          const head = cur.slice(0, breakAt);
          const tail = cur.slice(breakAt + 1);
          flush(head);
          cur = tail;
          width = tail.reduce((n, i) => n + i.g.advance, 0);
          breakAt = -1;
        }
      }
      if (cp === 0x20) breakAt = cur.length;
      else if (isCjk(cp)) breakAt = -1;
      cur.push({ cp, g });
      width += g.advance;
    }
    flush(cur);
  }
  return lines;
}

/** 栅格化后的一段文字（字体像素） */
export interface RasterText {
  width: number;
  height: number;
  /** RGBA8，白色 + alpha，第一行是顶部 */
  pixels: Uint8Array;
  /** 每个逻辑字体像素对应多少贴图像素 */
  density: number;
  fontUsage: number;
}

export function rasterizeText(text: string, source: GlyphSource, maxWidthPx: number, align: 'left' | 'center' | 'right', onMissing: (cp: number) => void): RasterText {
  const lines = layoutLines(text, source, maxWidthPx, onMissing);
  const metrics = lines.map((l) => {
    let above = 0;
    let below = 0;
    for (const { glyph } of l.glyphs) {
      above = Math.max(above, glyph.above);
      below = Math.max(below, glyph.below);
    }
    // 空行按兜底字体或原版的常见高度（7 + 1）
    if (above === 0 && below === 0) above = 7;
    return { above, below };
  });
  const width = Math.min(MAX_RASTER_SIDE, Math.max(1, ...lines.map((line) => line.width)));
  // 行距：每行高度加 1 像素间隔（游戏的行高 9 = 8 + 1）
  const height = metrics.reduce((total, line) => total + line.above + line.below, 0) + Math.max(0, lines.length - 1);
  const density = lines.reduce((maximum, line) => line.glyphs.reduce((current, entry) => Math.max(current, entry.glyph.sourceDensity ?? 1), maximum), 1);
  const raster = makeRaster(width, height, density);
  let top = 0;
  lines.forEach((line, i) => {
    if (top >= raster.height / raster.density) return;
    const m = metrics[i]!;
    const baseline = top + m.above;
    const origin = align === 'left' ? 0 : align === 'center' ? Math.floor((width - line.width) / 2) : width - line.width;
    raster.fontUsage |= paintLine(raster, line.glyphs, origin + line.inset, baseline);
    top += m.above + m.below + 1;
  });
  return raster;
}

/** ctx.text.create(opts)（04-templates.md 4.5）。owned 收集这段文字自己的贴图，模板实例销毁时一起释放 */
export function createText(opts: TextOptions, source: GlyphSource, warn: Warn, owned: THREE.Texture[], reportFontUsage?: (flags: number) => void): TextObject {
  if (typeof opts !== 'object' || opts === null) throw new TypeError('text options must be an object');
  const text = String(opts.text ?? '').slice(0, 10_000);
  const size = Number(opts.size);
  if (!Number.isFinite(size) || size <= 0) throw new RangeError('text size must be a positive number');
  const align = opts.align === 'center' || opts.align === 'right' ? opts.align : 'left';
  const maxWidthPx = opts.maxWidth !== undefined && Number.isFinite(opts.maxWidth) && opts.maxWidth > 0 ? Math.floor(opts.maxWidth / size) : 0;
  const color = new THREE.Color().setStyle(typeof opts.color === 'string' ? opts.color : '#ffffff', THREE.SRGBColorSpace);

  const missing = new Set<number>();
  const gui = opts.origin === 'guiBaseline' ? guiLine(text, source, (cp) => missing.add(cp)) : null;
  const raster = gui ? rasterizeGui(gui) : rasterizeText(text, source, maxWidthPx, align, (cp) => missing.add(cp));
  if (missing.size > 0) {
    const list = [...missing].slice(0, 8).map((cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`).join(', ');
    warn(`text: ${missing.size} character(s) have no glyph in any font (${list})`);
  }

  const tex = makeDataTexture(raster.width, raster.height, raster.pixels);
  // 游戏字形保持最近邻；系统字形的抗锯齿来自高密度遮罩本身。
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  owned.push(tex);

  const w = raster.width * size / raster.density;
  const h = raster.height * size / raster.density;
  const x0 = align === 'left' ? (gui?.left ?? 0) * size : align === 'center' ? -w / 2 : -w;
  const geometry = new THREE.PlaneGeometry(w, h);
  geometry.translate(x0 + w / 2, gui ? gui.above * size - h / 2 : 0, 0);
  const group = new THREE.Group();
  const main = new THREE.MeshBasicMaterial({ map: tex, color, transparent: true, depthWrite: false });
  const body = new THREE.Mesh(geometry, main);
  const usage = !raster.fontUsage ? 0 : raster.fontUsage | (normalizeRequestedFont(opts.font) === DEFAULT_FONT_ID ? FontUsageFlag.resourceDefault : 0);
  if (usage && reportFontUsage) body.onAfterRender = () => { if (main.opacity > 0) reportFontUsage(usage); };
  let shadowMat: THREE.MeshBasicMaterial | null = null;
  if (opts.shadow) {
    // 阴影颜色：正文颜色各通道 × 0.25（sRGB 空间，和游戏一样）
    const srgb = { r: 0, g: 0, b: 0 };
    color.getRGB(srgb, THREE.SRGBColorSpace);
    const shadowColor = new THREE.Color().setRGB(srgb.r * 0.25, srgb.g * 0.25, srgb.b * 0.25, THREE.SRGBColorSpace);
    shadowMat = new THREE.MeshBasicMaterial({ map: tex, color: shadowColor, transparent: true, depthWrite: false });
    const shadow = new THREE.Mesh(geometry.clone(), shadowMat);
    if (usage && reportFontUsage) {
      const material = shadowMat;
      shadow.onAfterRender = () => { if (material.opacity > 0) reportFontUsage(usage); };
    }
    shadow.position.set(size, -size, -0.001);
    group.add(shadow);
  }
  group.add(body);
  return {
    object: group,
    width: w,
    height: h,
    setOpacity(a) {
      const v = Math.min(1, Math.max(0, Number.isFinite(a) ? a : 0));
      main.opacity = v;
      if (shadowMat) shadowMat.opacity = v;
    },
  };
}
