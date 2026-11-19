import { z } from 'zod';

export const DEFAULT_FONT_ID = 'minecraft:default';
/** @deprecated 仅用于识别旧工程引用，实际选用 minecraft:default。 */
export const FALLBACK_FONT_ID = 'allay:fallback';
export const IMPORTED_FONT_PREFIX = 'user-font:';
export const MAX_OUTLINE_FONT_BYTES = 32 * 1024 * 1024;

export const ImportedFontIdSchema = z.string().length(IMPORTED_FONT_PREFIX.length + 64).regex(/^user-font:[0-9a-f]{64}$/);
export const FontRefSchema = z.string().max(256).refine((value) => {
  if (value !== value.trim()) return false;
  if (value.startsWith(IMPORTED_FONT_PREFIX)) return ImportedFontIdSchema.safeParse(value).success;
  const match = /^([a-z0-9_.-]+):([a-z0-9_./-]+)$/.exec(value);
  return match !== null && match[1] !== '.' && match[1] !== '..' && match[2]!.split('/').every((part) => part && part !== '.' && part !== '..');
});
export type FontRef = z.infer<typeof FontRefSchema>;

/** 保留有效资源包 ID；旧内置、旧导入和无效引用都按自动字体处理。 */
export function normalizeRequestedFont(value: unknown): string {
  const parsed = FontRefSchema.safeParse(value);
  if (!parsed.success || parsed.data === FALLBACK_FONT_ID || parsed.data.startsWith(IMPORTED_FONT_PREFIX)) return DEFAULT_FONT_ID;
  return parsed.data;
}
