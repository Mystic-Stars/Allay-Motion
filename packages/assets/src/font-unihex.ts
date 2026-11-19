import type { BitmapFontTables } from './bdf';
import type { UnihexProvider } from './font';

/** Java unihex 每字 16 行，原始位宽可为 8/16/24/32；宽度按有墨迹的列裁切。 */
export function parseUnihex(text: string, overrides: UnihexProvider['overrides'] = []): BitmapFontTables | null {
  const glyphs = new Map<number, { width: number; bitmap: Uint8Array }>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([\da-f]{4,6}):([\da-f]{32}|[\da-f]{64}|[\da-f]{96}|[\da-f]{128})$/i.exec(line);
    if (!match) continue;
    const cp = Number.parseInt(match[1]!, 16);
    if (cp === 0 || cp > 0x10ffff || glyphs.has(cp)) continue;
    if (glyphs.size >= 100_000) break;
    const hex = match[2]!;
    const stride = hex.length / 32;
    const rows = Array.from({ length: 16 }, (_, y) => Number.parseInt(hex.slice(y * stride * 2, (y + 1) * stride * 2), 16));
    const sourceWidth = stride * 8;
    let left = sourceWidth;
    let right = -1;
    const ink = (x: number, row: number) => (rows[row]! >>> (sourceWidth - 1 - x)) & 1;
    for (let x = 0; x < sourceWidth; x++) {
      if (rows.some((_, y) => ink(x, y))) {
        left = Math.min(left, x);
        right = x;
      }
    }
    const override = overrides.find((entry) => cp >= entry.from && cp <= entry.to);
    if (override) ({ left, right } = override);
    const width = Math.max(0, right - left + 1);
    if (!width) continue;
    const rowBytes = Math.ceil(width / 8);
    const bitmap = new Uint8Array(rowBytes * 16);
    for (let x = 0; x < width; x++) {
      if (x + left < 0 || x + left >= sourceWidth) continue;
      for (let y = 0; y < 16; y++) if (ink(x + left, y)) bitmap[y * rowBytes + (x >> 3)]! |= 0x80 >>> (x & 7);
    }
    glyphs.set(cp, { width, bitmap });
  }
  if (!glyphs.size) return null;
  const codepoints = Uint32Array.from([...glyphs.keys()].sort((a, b) => a - b));
  const metrics = new Int16Array(glyphs.size * 5);
  const offsets = new Uint32Array(glyphs.size);
  const bits = new Uint8Array([...glyphs.values()].reduce((total, value) => total + value.bitmap.length, 0));
  let offset = 0;
  codepoints.forEach((cp, index) => {
    const { width, bitmap } = glyphs.get(cp)!;
    offsets[index] = offset;
    metrics.set([width + 1, width, 16, 0, -2], index * 5);
    bits.set(bitmap, offset);
    offset += bitmap.length;
  });
  return { ascent: 14, descent: 2, codepoints, metrics, offsets, bits };
}
