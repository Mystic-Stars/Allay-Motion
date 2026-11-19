/** sfnt 的 Unicode cmap。只判断覆盖范围，轮廓解码由 Chromium 的字体校验器处理。 */
export function outlineCoverage(bytes: Uint8Array): ((cp: number) => boolean) | null {
  if (bytes.length < 12 || bytes.length > 32 * 1024 * 1024) return null;
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = data.getUint32(0);
  if (magic !== 0x00010000 && magic !== 0x4f54544f) return null;
  const count = data.getUint16(4);
  if (count < 1 || count > 256 || 12 + count * 16 > bytes.length) return null;
  const tables = new Map<number, { start: number; end: number }>();
  for (let index = 0; index < count; index++) {
    const record = 12 + index * 16;
    const tag = data.getUint32(record);
    const start = data.getUint32(record + 8);
    const end = start + data.getUint32(record + 12);
    if (start < 12 + count * 16 || end > bytes.length || tables.has(tag)) return null;
    tables.set(tag, { start, end });
  }
  const cmap = tables.get(0x636d6170);
  const head = tables.get(0x68656164);
  const maxp = tables.get(0x6d617870);
  if (!cmap || !head || head.end - head.start < 54 || !maxp || maxp.end - maxp.start < 6 || cmap.end - cmap.start < 4) return null;
  const glyphCount = data.getUint16(maxp.start + 4);
  const subCount = data.getUint16(cmap.start + 2);
  if (!glyphCount || subCount > 256 || cmap.start + 4 + subCount * 8 > cmap.end) return null;
  const candidates: { rank: number; covers(cp: number): boolean }[] = [];
  const validGlyph = (glyph: number) => glyph > 0 && glyph < glyphCount;
  for (let index = 0; index < subCount; index++) {
    const record = cmap.start + 4 + index * 8;
    const platform = data.getUint16(record);
    const encoding = data.getUint16(record + 2);
    if (platform !== 0 && !(platform === 3 && (encoding === 1 || encoding === 10))) continue;
    const start = cmap.start + data.getUint32(record + 4);
    if (start < cmap.start + 4 + subCount * 8 || start + 4 > cmap.end) continue;
    const format = data.getUint16(start);
    if (format === 12 && start + 16 <= cmap.end) {
      const end = start + data.getUint32(start + 4);
      const groups = data.getUint32(start + 12);
      if (end > cmap.end || start + 16 + groups * 12 > end || groups > 0x110000) continue;
      const group = (index: number) => start + 16 + index * 12;
      let last = -1;
      let sorted = true;
      for (let groupIndex = 0; groupIndex < groups; groupIndex++) {
        const offset = group(groupIndex);
        if (data.getUint32(offset) <= last || data.getUint32(offset) > data.getUint32(offset + 4)) {
          sorted = false;
          break;
        }
        last = data.getUint32(offset + 4);
      }
      if (!groups || !sorted || last > 0x10ffff) continue;
      candidates.push({ rank: 12, covers: (cp) => {
        const index = lowerBound(groups, (i) => data.getUint32(group(i) + 4) >= cp);
        if (index === groups) return false;
        const offset = group(index);
        const first = data.getUint32(offset);
        return cp >= first && validGlyph(data.getUint32(offset + 8) + cp - first);
      } });
    } else if (format === 4 && start + 16 <= cmap.end) {
      const end = start + data.getUint16(start + 2);
      const segments = data.getUint16(start + 6) / 2;
      if (!Number.isInteger(segments) || !segments || end > cmap.end || start + 16 + segments * 8 > end) continue;
      const ends = start + 14;
      const starts = ends + 2 + segments * 2;
      const deltas = starts + segments * 2;
      const offsets = deltas + segments * 2;
      candidates.push({ rank: 4, covers: (cp) => {
        if (cp > 0xffff) return false;
        const index = lowerBound(segments, (i) => data.getUint16(ends + i * 2) >= cp);
        if (index === segments) return false;
        const first = data.getUint16(starts + index * 2);
        if (cp < first) return false;
        const delta = data.getInt16(deltas + index * 2);
        const address = offsets + index * 2;
        const relative = data.getUint16(address);
        if (relative === 0) return validGlyph((cp + delta) & 0xffff);
        const location = address + relative + (cp - first) * 2;
        if (location < offsets + segments * 2 || location + 2 > end) return false;
        const glyph = data.getUint16(location);
        return glyph !== 0 && validGlyph((glyph + delta) & 0xffff);
      } });
    }
  }
  return candidates.sort((a, b) => b.rank - a.rank)[0]?.covers ?? null;
}

function lowerBound(count: number, matches: (index: number) => boolean): number {
  let first = 0;
  let last = count;
  while (first < last) {
    const mid = (first + last) >>> 1;
    if (matches(mid)) last = mid;
    else first = mid + 1;
  }
  return first;
}
