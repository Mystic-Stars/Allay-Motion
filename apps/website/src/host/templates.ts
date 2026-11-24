// 内置模板：构建时由 virtual:allay-builtin-templates 从 packages/templates 现场打包（见 build/plugins.ts）。
// 这里把它们整理成桌面版主进程 templates.list / templates.read 返回的同一种数据。
import { parseManifest, resolveScript, localize, type TemplateManifest } from '@allay/template-sdk';
import builtin from 'virtual:allay-builtin-templates';
import type { TemplateBundle, TemplateEntry } from '../../../desktop/src/shared/templates';

interface Builtin {
  entry: TemplateEntry;
  code: string;
}

/**
 * 条目的 contentHash（16 位十六进制）。桌面版主进程用包内容的 SHA-256；网页里没有同步的 SHA-256，这里用两路 32 位 FNV-1a
 * 拼成 64 位（只用来区分内容、让封面缓存作废，不需要密码学强度；按码元算，几十 KB 的代码也只要几十微秒）
 */
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

function load(): Builtin[] {
  const out: Builtin[] = [];
  for (const raw of builtin) {
    // 文件边界的数据照样过 schema（AGENTS.md 代码约定）
    const parsed = parseManifest(raw.manifest);
    if (!parsed.ok) throw new Error(`invalid built-in manifest: ${parsed.issues.map((i) => i.message).join('; ')}`);
    const manifest = parsed.manifest;
    out.push({
      entry: { id: manifest.id, version: manifest.version, source: 'builtin', kind: 'script', manifest, baseMissing: false, trialWarnings: [], contentHash: contentHash(`${JSON.stringify(raw.manifest)}\u0000${raw.code}`) },
      code: raw.code,
    });
  }
  // 与主进程的排序一致（内置在前，再按 id）
  return out.sort((a, b) => a.entry.id.localeCompare(b.entry.id));
}

let cache: Builtin[] | null = null;
function all(): Builtin[] {
  cache ??= load();
  return cache;
}

export function builtinEntries(): TemplateEntry[] {
  return all().map((b) => b.entry);
}

export function builtinBundle(id: string, version: string): TemplateBundle | null {
  const b = all().find((x) => x.entry.id === id && x.entry.version === version);
  if (!b) return null;
  return { entry: b.entry, resolved: resolveScript(b.entry.manifest), code: b.code };
}

/** 模板的默认时长：timeline 各段默认值之和（模板库卡片上的读数，6.4）；不知道时为 null */
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

export function templateName(manifest: TemplateManifest, locale: string): string {
  return localize(manifest.name, locale);
}

/**
 * 官网展示用的顺序：先放画面最有代表性的几个，其余（包括以后新加的）按 id 排在后面。
 * 这只是一个偏好，不是清单：packages/templates 下新加的模板不用改这里也会出现。
 */
const SHOWCASE_FIRST = ['allay.builtin.block-wipe', 'allay.builtin.block-fall', 'allay.builtin.item-stinger', 'allay.builtin.pixel-dissolve', 'allay.builtin.loading-screen', 'allay.builtin.advancement-toast'];

export function showcaseEntries(): TemplateEntry[] {
  const rank = (id: string) => {
    const i = SHOWCASE_FIRST.indexOf(id);
    return i < 0 ? SHOWCASE_FIRST.length : i;
  };
  return [...builtinEntries()].sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

/** 剪辑点所在的时刻（按 timeline 的默认时长：进入段加停留段的一半，与转场模板的 cutTime 约定一致）；不知道时为 null */
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
