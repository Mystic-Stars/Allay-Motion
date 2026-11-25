// 官网精选内置模板：构建时由 virtual:allay-builtin-templates 只打入固定 8 个精选代表性模板（build/plugins.ts）。
// 同时供落地页轻量引擎与试玩台里的 1:1 真实桌面编辑器（browser-host.ts）使用，不会随桌面端后续加新模板无限膨胀。
import { localize, parseManifest, resolveScript, type TemplateManifest } from '@allay/template-sdk';
import builtin from 'virtual:allay-builtin-templates';
import type { TemplateBundle, TemplateEntry } from '../../../desktop/src/shared/templates';

export type SiteTemplateEntry = TemplateEntry;

export interface SiteTemplateBundle {
  entry: TemplateEntry;
  code: string;
}

function contentHash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x9dc5811c;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 15);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

function load(): SiteTemplateBundle[] {
  const out: SiteTemplateBundle[] = [];
  for (const raw of builtin) {
    const parsed = parseManifest(raw.manifest);
    if (!parsed.ok) throw new Error(`invalid showcase manifest: ${parsed.issues.map((i) => i.message).join('; ')}`);
    const manifest = parsed.manifest;
    out.push({
      entry: {
        id: manifest.id,
        version: manifest.version,
        source: 'builtin',
        kind: 'script',
        manifest,
        baseMissing: false,
        trialWarnings: [],
        contentHash: contentHash(`${JSON.stringify(raw.manifest)}\u0000${raw.code}`),
      },
      code: raw.code,
    });
  }
  return out;
}

let cache: SiteTemplateBundle[] | null = null;
function all(): SiteTemplateBundle[] {
  cache ??= load();
  return cache;
}

/** 按 SHOWCASE_TEMPLATE_IDS 精选顺序返回 */
export function showcaseEntries(): TemplateEntry[] {
  return all().map((b) => b.entry);
}

/** 按 id 字母序返回（与桌面端主进程列表顺序一致，供 browser-host 使用） */
export function builtinEntries(): TemplateEntry[] {
  return [...showcaseEntries()].sort((a, b) => a.id.localeCompare(b.id));
}

export function showcaseBundle(id: string): SiteTemplateBundle | null {
  return all().find((x) => x.entry.id === id) ?? null;
}

export function builtinBundle(id: string, version: string): TemplateBundle | null {
  const b = all().find((x) => x.entry.id === id && x.entry.version === version);
  if (!b) return null;
  return { entry: b.entry, resolved: resolveScript(b.entry.manifest), code: b.code };
}

export function defaultDuration(manifest: TemplateManifest): number | null {
  const segments = manifest.timeline?.segments ?? [];
  if (segments.length === 0) return null;
  let total = 0;
  for (const s of segments) {
    const def = (manifest.params ?? []).find((p) => p.key === s.param);
    if (!def || typeof def.default !== 'number') return null;
    total += def.default;
  }
  return total;
}

export function defaultCutTime(manifest: TemplateManifest): number | null {
  const segments = manifest.timeline?.segments ?? [];
  const value = (i: number) => {
    const def = (manifest.params ?? []).find((p) => p.key === segments[i]?.param);
    return def && typeof def.default === 'number' ? def.default : null;
  };
  const enter = value(0);
  const hold = value(1);
  return enter === null || hold === null ? null : enter + hold / 2;
}

export function templateName(manifest: TemplateManifest, locale: string): string {
  return localize(manifest.name, locale);
}
