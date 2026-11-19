// Java 字体提供器的解析（docs/03-assets.md 3.9）。
import { fontIdToPath, fontTextureToPath, normalizeResourceId, parseResourceId } from './ids';

/** 字间距 1 像素，空格宽 4 像素（3.9） */
export const GLYPH_SPACING = 1;
export const SPACE_ADVANCE = 4;

export interface BitmapProvider {
  type: 'bitmap';
  /** 贴图文件在资源包里的路径 */
  file: string;
  ascent: number;
  height: number;
  /** 每行一串字符，按码位拆开；U+0000 表示空格子 */
  rows: number[][];
}

export interface SpaceProvider {
  type: 'space';
  advances: Map<number, number>;
}

export interface OutlineProvider {
  type: 'ttf';
  file: string;
  size: number;
  oversample: number;
  shift: [number, number];
  skip: string;
}

export interface UnihexProvider {
  type: 'unihex';
  file: string;
  overrides: { from: number; to: number; left: number; right: number }[];
}

export type FontProvider = BitmapProvider | SpaceProvider | OutlineProvider | UnihexProvider;

export interface ParsedFont {
  providers: FontProvider[];
  /** reference 提供器引用的字体 ID，按出现顺序 */
  references: { index: number; id: string }[];
  /** 跳过的提供器及错误 */
  skipped: string[];
}

function codepoints(s: string): number[] {
  return Array.from(s, (ch) => ch.codePointAt(0) ?? 0);
}

export function fontPathToId(path: string): string | null {
  const match = /^assets\/([a-z0-9_.-]+)\/font\/(.+)\.json$/.exec(path);
  const id = match && match[1] !== '.' && match[1] !== '..' ? normalizeResourceId(`${match[1]}:${match[2]}`) : null;
  return id && id.length <= 256 && !id.startsWith('user-font:') && id !== 'allay:fallback' ? id : null;
}

function bounded(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function providerFile(file: unknown, prefix: string): string | null {
  const id = typeof file === 'string' ? parseResourceId(file) : null;
  return id && id.namespace !== '.' && id.namespace !== '..' ? `assets/${id.namespace}/${prefix}${id.path}` : null;
}

const MAX_FONT_JSON_LENGTH = 4 * 1024 * 1024;

function jsonWhitespace(char: string | undefined): boolean {
  return char === ' ' || char === '\t' || char === '\r' || char === '\n';
}

/** 部分原版字体定义带尾逗号；只在严格解析失败后移除这类逗号，再交给 JSON.parse 校验。 */
function parseFontDocument(source: string): unknown {
  const text = source.replace(/^\uFEFF/, '');
  if (text.length > MAX_FONT_JSON_LENGTH) throw new SyntaxError('font JSON too large');
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    let inString = false;
    let previous = '';
    let start = 0;
    const parts: string[] = [];
    for (let index = 0; index < text.length; index++) {
      const char = text[index]!;
      if (inString) {
        if (char === '\\') index++;
        else if (char === '"') { inString = false; previous = char; }
        continue;
      }
      if (char === '"') inString = true;
      if (char === ',' && previous !== '[' && previous !== '{' && previous !== ',') {
        let next = index + 1;
        while (jsonWhitespace(text[next])) next++;
        if (text[next] === ']' || text[next] === '}') {
          parts.push(text.slice(start, index));
          start = index + 1;
        }
      }
      if (!jsonWhitespace(char)) previous = char;
    }
    if (!parts.length) throw error;
    parts.push(text.slice(start));
    return JSON.parse(parts.join('')) as unknown;
  }
}

/** 解析一个字体定义 JSON。提供器的顺序保持不变；reference 在 references 里记下插入位置 */
export function parseFontJson(text: string): ParsedFont {
  const out: ParsedFont = { providers: [], references: [], skipped: [] };
  let root: unknown;
  try {
    root = parseFontDocument(text);
  } catch {
    out.skipped.push('invalid-json');
    return out;
  }
  const list = typeof root === 'object' && root !== null && Array.isArray((root as { providers?: unknown }).providers) ? (root as { providers: unknown[] }).providers : [];
  for (const raw of list.slice(0, 256)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const p = raw as Record<string, unknown>;
    // 使用 Java 的默认文字变体；不启用强制 Unicode 和日文字形变体。
    if (p.filter && typeof p.filter === 'object' && Object.values(p.filter).some((value) => value === true)) continue;
    switch (p.type) {
      case 'bitmap': {
        const file = typeof p.file === 'string' ? fontTextureToPath(p.file) : null;
        const chars = Array.isArray(p.chars) && p.chars.length <= 1024 && p.chars.every((c) => typeof c === 'string' && c.length <= 1024) ? (p.chars as string[]).map(codepoints) : null;
        const ascent = bounded(p.ascent, -512, 512) ? Math.trunc(p.ascent) : null;
        const height = bounded(p.height, 1, 512) ? Math.trunc(p.height) : p.height === undefined ? 8 : null;
        if (!file || !chars?.[0]?.length || chars.some((row) => row.length !== chars[0]!.length) || ascent === null || height === null || ascent > height) {
          out.skipped.push('bitmap(invalid)');
          break;
        }
        out.providers.push({ type: 'bitmap', file, ascent, height, rows: chars });
        break;
      }
      case 'space': {
        const advances = new Map<number, number>();
        if (typeof p.advances === 'object' && p.advances !== null) {
          for (const [ch, adv] of Object.entries(p.advances as Record<string, unknown>).slice(0, 65_536)) {
            const cps = codepoints(ch);
            if (cps.length === 1 && bounded(adv, -512, 512)) advances.set(cps[0] ?? 0, adv);
          }
        }
        if (advances.size) out.providers.push({ type: 'space', advances });
        break;
      }
      case 'ttf': {
        const file = providerFile(p.file, 'font/');
        if (!file || !/\.(ttf|otf)$/.test(file)) {
          out.skipped.push('ttf(invalid)');
          break;
        }
        const shift: [number, number] = Array.isArray(p.shift) && p.shift.length === 2 && bounded(p.shift[0], -32, 32) && bounded(p.shift[1], -32, 32)
          ? [p.shift[0], p.shift[1]] : [0, 0];
        const skip = typeof p.skip === 'string' ? p.skip : Array.isArray(p.skip) ? p.skip.slice(0, 256).filter((v): v is string => typeof v === 'string').map((v) => v.slice(0, 4096)).join('') : '';
        out.providers.push({ type: 'ttf', file, size: bounded(p.size, 1, 64) ? p.size : 11, oversample: bounded(p.oversample, 1, 8) ? p.oversample : 1, shift, skip: skip.slice(0, 65_536) });
        break;
      }
      case 'unihex': {
        const file = providerFile(p.hex_file, '');
        if (!file?.endsWith('.zip')) {
          out.skipped.push('unihex(invalid)');
          break;
        }
        const overrides: UnihexProvider['overrides'] = [];
        for (const entry of Array.isArray(p.size_overrides) ? p.size_overrides.slice(0, 256) : []) {
          if (!entry || typeof entry !== 'object') continue;
          const { from, to, left, right } = entry as Record<string, unknown>;
          const first = typeof from === 'string' && [...from].length === 1 ? from.codePointAt(0) : undefined;
          const last = typeof to === 'string' && [...to].length === 1 ? to.codePointAt(0) : undefined;
          if (first !== undefined && last !== undefined && first <= last && bounded(left, 0, 31) && bounded(right, left, 31)) {
            overrides.push({ from: first, to: last, left: Math.trunc(left), right: Math.trunc(right) });
          }
        }
        out.providers.push({ type: 'unihex', file, overrides });
        break;
      }
      case 'reference': {
        const id = typeof p.id === 'string' ? normalizeResourceId(p.id) : null;
        if (id) out.references.push({ index: out.providers.length, id });
        else out.skipped.push('reference(invalid)');
        break;
      }
      default:
        out.skipped.push(typeof p.type === 'string' ? p.type : 'unknown');
    }
  }
  return out;
}

/**
 * 展开 reference，得到扁平的提供器列表。loadFont 按字体 ID 取各层合并后的定义（上层在前），
 * 找不到时返回 null。带环检测和深度上限。
 */
export async function resolveFontProviders(
  fontId: string,
  loadFont: (path: string) => Promise<ParsedFont[] | null>,
): Promise<{ providers: FontProvider[]; skipped: string[] }> {
  const providers: FontProvider[] = [];
  const skipped: string[] = [];
  let visits = 0;
  const visit = async (id: string, stack: string[]): Promise<void> => {
    if (++visits > 128 || providers.length >= 256) return;
    if (stack.includes(id) || stack.length > 8) {
      skipped.push(`reference-cycle(${id})`);
      return;
    }
    const path = fontIdToPath(id);
    const fonts = path ? await loadFont(path) : null;
    if (!fonts) {
      skipped.push(`missing(${id})`);
      return;
    }
    for (const font of fonts) {
      skipped.push(...font.skipped);
      let refIdx = 0;
      for (let i = 0; i <= font.providers.length; i++) {
        while (refIdx < font.references.length && font.references[refIdx]?.index === i) {
          const ref = font.references[refIdx];
          if (ref) await visit(ref.id, [...stack, id]);
          refIdx++;
        }
        const p = font.providers[i];
        if (p && providers.length < 256) providers.push(p);
      }
    }
  };
  await visit(normalizeResourceId(fontId) ?? fontId, []);
  return { providers, skipped: skipped.slice(0, 256) };
}

export interface BitmapGlyph {
  kind: 'bitmap';
  file: string;
  /** 格子在贴图里的行列 */
  row: number;
  col: number;
  rows: number;
  cols: number;
  ascent: number;
  height: number;
}

export type GlyphSource = BitmapGlyph | { kind: 'space'; advance: number };

/** 某个码位由哪个提供器提供：按列表顺序第一个有它的胜出 */
export function findGlyph(providers: readonly FontProvider[], codepoint: number): GlyphSource | null {
  if (codepoint === 0) return null;
  for (const p of providers) {
    if (p.type === 'space') {
      const adv = p.advances.get(codepoint);
      if (adv !== undefined) return { kind: 'space', advance: adv };
      continue;
    }
    if (p.type !== 'bitmap') continue;
    for (let row = 0; row < p.rows.length; row++) {
      const col = p.rows[row]?.indexOf(codepoint) ?? -1;
      if (col >= 0) {
        const cols = Math.max(...p.rows.map((r) => r.length));
        return { kind: 'bitmap', file: p.file, row, col, rows: p.rows.length, cols, ascent: p.ascent, height: p.height };
      }
    }
  }
  return null;
}

/**
 * 字形宽度：该格子里最右侧不透明像素列 + 1（3.9）。整格透明时为 0。
 * alphaAt 读格子内 (x, y) 的不透明度（0–255）。
 */
export function glyphInkWidth(cellWidth: number, cellHeight: number, alphaAt: (x: number, y: number) => number): number {
  for (let x = cellWidth - 1; x >= 0; x--) {
    for (let y = 0; y < cellHeight; y++) if (alphaAt(x, y) > 0) return x + 1;
  }
  return 0;
}

/** 前进宽度（未缩放的字体像素）：字形宽度加字间距；空格固定 4 */
export function glyphAdvance(codepoint: number, inkWidth: number): number {
  if (codepoint === 0x20) return SPACE_ADVANCE;
  return inkWidth + GLYPH_SPACING;
}
