/** 系统字体只在可信 Worker 内栅格化；不读字体文件，也不枚举系统字体。 */
export interface GlyphRaster {
  advance: number;
  dx: number;
  dy: number;
  w: number;
  h: number;
  sourceDensity?: number;
  alpha(x: number, y: number): number;
}

type SystemGlyph = GlyphRaster & { above: number; below: number; system: true };
type Mask = { advance: number; left: number; top: number; width: number; height: number; alpha: Uint8Array };

/** 9 GUI 像素的 em，以 72 像素绘制并保留覆盖率，不把 9px 字形放大。 */
const DENSITY = 8;
const SETTINGS = `${9 * DENSITY}px system-ui`;
const MAX_CACHE_ENTRIES = 512;
const MAX_MASK_SIDE = 256;
/** Canvas 不提供字符覆盖查询，以已知缺字的原始遮罩识别系统 .notdef。 */
const MISSING_PROBES = [0xfdd0, 0xfdef, 0x10ffff];
const IGNORABLE = /^\p{Default_Ignorable_Code_Point}$/u;
const SPACE = /^\p{White_Space}$/u;
const CONTROL = /^\p{Cc}$/u;

export function isScalar(cp: number): boolean {
  return cp >= 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff);
}

function readMask(canvas: OffscreenCanvas, context: OffscreenCanvasRenderingContext2D, text: string): Mask | null {
  const configure = () => {
    context.font = SETTINGS;
    context.textAlign = 'left';
    context.textBaseline = 'alphabetic';
    context.direction = 'ltr';
  };
  configure();
  const metrics = context.measureText(text);
  const advance = Math.round(metrics.width);
  const left = Math.floor(-metrics.actualBoundingBoxLeft);
  const top = Math.floor(-metrics.actualBoundingBoxAscent);
  const width = Math.ceil(metrics.actualBoundingBoxRight) - left;
  const height = Math.ceil(metrics.actualBoundingBoxDescent) - top;
  if (![advance, left, top, width, height].every(Number.isFinite)
    || advance < 0 || advance > MAX_MASK_SIDE || Math.abs(left) > MAX_MASK_SIDE || Math.abs(top) > MAX_MASK_SIDE
    || width > MAX_MASK_SIDE || height > MAX_MASK_SIDE) return null;
  if (width <= 0 || height <= 0) return { advance, left: 0, top: 0, width: 0, height: 0, alpha: new Uint8Array(0) };

  canvas.width = width + 2;
  canvas.height = height + 2;
  configure();
  context.fillText(text, 1 - left, 1 - top);
  const stride = canvas.width;
  const rgba = context.getImageData(0, 0, stride, canvas.height).data;
  let minX = stride, minY = canvas.height, maxX = -1, maxY = -1;
  for (let row = 0; row < canvas.height; row++) {
    for (let column = 0; column < stride; column++) {
      if (rgba[(row * stride + column) * 4 + 3] === 0) continue;
      minX = Math.min(minX, column); maxX = Math.max(maxX, column);
      minY = Math.min(minY, row); maxY = Math.max(maxY, row);
    }
  }
  if (maxX < 0) return { advance, left: 0, top: 0, width: 0, height: 0, alpha: new Uint8Array(0) };
  const inkWidth = maxX - minX + 1;
  const inkHeight = maxY - minY + 1;
  const alpha = new Uint8Array(inkWidth * inkHeight);
  for (let row = 0; row < inkHeight; row++) {
    for (let column = 0; column < inkWidth; column++) alpha[row * inkWidth + column] = rgba[((row + minY) * stride + column + minX) * 4 + 3]!;
  }
  return { advance, left: left + minX - 1, top: top + minY - 1, width: inkWidth, height: inkHeight, alpha };
}

function equalMask(first: Mask, second: Mask): boolean {
  return first.width === second.width && first.height === second.height && first.alpha.every((value, index) => value === second.alpha[index]);
}

function createLookup(): ((cp: number) => SystemGlyph | null) | null {
  if (typeof OffscreenCanvas === 'undefined' || 'document' in globalThis) return null;
  const canvas = new OffscreenCanvas(1, 1);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  const read = (char: string) => readMask(canvas, context, char);
  const missing = MISSING_PROBES.map((cp) => read(String.fromCodePoint(cp))).filter((mask): mask is Mask => mask !== null && mask.alpha.length > 0);
  return (cp) => {
    if (!isScalar(cp) || (cp & 0xfffe) === 0xfffe || (cp >= 0xfdd0 && cp <= 0xfdef)) return null;
    const char = String.fromCodePoint(cp);
    if (cp === 0x09) {
      const space = read(' ');
      return space && { advance: 4 * space.advance / DENSITY, dx: 0, dy: 0, w: 0, h: 0, above: 0, below: 0, system: true, alpha: () => 0 };
    }
    if (CONTROL.test(char)) return null;
    const ignored = IGNORABLE.test(char);
    const mask = ignored ? { advance: 0, left: 0, top: 0, width: 0, height: 0, alpha: new Uint8Array(0) } : read(char);
    if (!mask || (mask.alpha.length === 0 ? !ignored && !SPACE.test(char) : missing.some((probe) => equalMask(mask, probe)))) return null;
    const { advance, left, top, width, height, alpha } = mask;
    return {
      advance: advance / DENSITY, dx: left / DENSITY, dy: top / DENSITY, w: width / DENSITY, h: height / DENSITY,
      above: Math.max(0, -top / DENSITY), below: Math.max(0, (top + height) / DENSITY),
      sourceDensity: DENSITY, alpha: (column, row) => alpha[row * width + column] ?? 0, system: true,
    };
  };
}

let lookup: ReturnType<typeof createLookup> | undefined;
const cache = new Map<number, SystemGlyph | null>();

/** 所有实例共用一个有界缓存（含缺字）；只缓存 CPU alpha，不持有纹理。 */
export function systemGlyph(cp: number): SystemGlyph | null {
  const hit = cache.get(cp);
  if (hit !== undefined) {
    cache.delete(cp);
    cache.set(cp, hit);
    return hit;
  }
  if (lookup === undefined) lookup = createLookup();
  const result = lookup?.(cp) ?? null;
  if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
  cache.set(cp, result);
  return result;
}
