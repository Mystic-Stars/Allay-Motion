// manifest 的解析入口，以及派生模板的装载（docs/04-templates.md 4.3、4.7）。
import { z } from 'zod';
import {
  MANIFEST_FORMAT_VERSION,
  RESERVED_ID_PREFIX,
  TemplateManifestSchema,
  formatIssues,
  type ManifestIssue,
  type ParamDef,
  type TemplateManifest,
} from './manifest';
import { MANIFEST_MIGRATIONS, migrate, type Migrations } from './migrate';
import { readLegacyParam, readLegacyText, sanitizeValue } from './params';
import { satisfies } from './semver';

export type ManifestParseResult =
  | { ok: true; manifest: TemplateManifest; migratedFrom: number | null }
  | { ok: false; code: 'manifest-invalid' | 'format-too-new'; issues: ManifestIssue[] };

/** 解析 manifest.json 的内容（已经 JSON.parse 过）：格式版本、迁移、schema */
export function parseManifest(raw: unknown, migrations: Migrations = MANIFEST_MIGRATIONS): ManifestParseResult {
  const m = migrate(raw, migrations);
  if (!m.ok) {
    if (m.error === 'format-too-new') {
      return { ok: false, code: 'format-too-new', issues: [{ path: 'formatVersion', message: `formatVersion ${m.version} is newer than ${MANIFEST_FORMAT_VERSION}; update the app` }] };
    }
    const path = m.error === 'not-an-object' ? '(root)' : 'formatVersion';
    return { ok: false, code: 'manifest-invalid', issues: [{ path, message: m.error }] };
  }
  const parsed = TemplateManifestSchema.safeParse(m.doc);
  if (!parsed.success) return { ok: false, code: 'manifest-invalid', issues: formatIssues(parsed.error) };
  return { ok: true, manifest: parsed.data, migratedFrom: m.migratedFrom };
}

/** 用户模板的 id 不得以 allay. 开头 */
export function isReservedId(id: string): boolean {
  return id.startsWith(RESERVED_ID_PREFIX);
}

/**
 * 装载用的模板：脚本模板就是它自己；派生模板是“基模板的代码和参数定义 + 自己的 overrides”。
 * 引擎拿 manifest 和 params 去 load；界面按 params 生成属性面板、跳过 hidden。
 */
export interface ResolvedTemplate {
  /** 这个模板自己的 manifest（派生模板是派生的那份） */
  manifest: TemplateManifest;
  /** 生效的参数定义：派生模板的默认值已被覆盖 */
  params: ParamDef[];
  /** 不显示的参数（取覆盖后的默认值） */
  hidden: string[];
  /** 时间段：派生模板沿用基模板的 */
  timeline: TemplateManifest['timeline'];
  /**
   * 参数分组：派生模板沿用基模板的。参数定义里的 group 指向这些分组，两者必须一起带走，
   * 否则生效 manifest 过不了 schema（试用版的缺陷：派生模板的预览报 unknown group，docs/decisions.md）
   */
  groups: TemplateManifest['groups'];
  /** 代码来自哪个脚本模板 */
  codeFrom: { id: string; version: string };
}

export class DeriveError extends Error {
  constructor(
    readonly code: 'base-missing' | 'base-not-script' | 'not-derived',
    message: string,
  ) {
    super(message);
    this.name = 'DeriveError';
  }
}

/** 脚本模板：原样 */
export function resolveScript(manifest: TemplateManifest): ResolvedTemplate {
  if (manifest.extends) throw new DeriveError('not-derived', 'expected a script template');
  return { manifest, params: manifest.params ?? [], hidden: [], timeline: manifest.timeline, groups: manifest.groups, codeFrom: { id: manifest.id, version: manifest.version } };
}

/**
 * 派生模板：取基模板的参数定义，套上 overrides（4.7）。
 * - 覆盖的默认值经参数校验清洗（类型不对的回到基模板的默认值，越界的钳制）；不认识的键丢弃。
 * - 只允许派生一层：基模板必须是脚本模板，版本须满足 extends.version。
 */
export function resolveDerived(derived: TemplateManifest, base: TemplateManifest): ResolvedTemplate {
  const ext = derived.extends;
  if (!ext) throw new DeriveError('not-derived', `${derived.id} does not extend another template`);
  if (base.id !== ext.id || !satisfies(base.version, ext.version)) {
    throw new DeriveError('base-missing', `${derived.id} needs ${ext.id}@${ext.version}, got ${base.id}@${base.version}`);
  }
  if (base.extends) throw new DeriveError('base-not-script', `${base.id} is itself a derived template`);
  const defaults = derived.overrides?.defaults ?? {};
  const params = (base.params ?? []).map((def): ParamDef => {
    const raw = Object.hasOwn(defaults, def.key) ? defaults[def.key] : readLegacyParam(def, defaults);
    if (raw === undefined) return def;
    const value = sanitizeValue(def, raw);
    return { ...def, default: value } as ParamDef;
  });
  const keys = new Set(params.map((p) => p.key));
  const hiddenKeys = new Set(derived.overrides?.hidden ?? []);
  const hidden = [...hiddenKeys].filter((k) => keys.has(k));
  for (const def of params) {
    if (def.type === 'text' && readLegacyText(def, defaults) !== undefined && def.legacyText?.some(({ key }) => hiddenKeys.has(key))) hidden.push(def.key);
  }
  return { manifest: derived, params, hidden: [...new Set(hidden)], timeline: base.timeline, groups: base.groups, codeFrom: { id: base.id, version: base.version } };
}

/** 从已安装的版本里挑满足范围的最高版本 */
export function pickVersion(versions: readonly string[], range: string, compare: (a: string, b: string) => number): string | null {
  const ok = versions.filter((v) => satisfies(v, range)).sort(compare);
  return ok.at(-1) ?? null;
}

/**
 * 生效 manifest：给引擎的 load 用（参数定义是生效的那份，code 来自基模板）。
 * 参数定义、分组、时间段三者互相引用，一律取 resolved 里的同一份（派生模板的是基模板的），不混用派生模板自己的。
 */
export function effectiveManifest(resolved: ResolvedTemplate): TemplateManifest {
  const { extends: _e, overrides: _o, groups: _g, timeline: _t, ...rest } = resolved.manifest;
  return {
    ...rest,
    params: resolved.params,
    ...(resolved.groups ? { groups: resolved.groups } : {}),
    ...(resolved.timeline ? { timeline: resolved.timeline } : {}),
  };
}

export const TemplateRefSchema = z.strictObject({ id: z.string().max(128), version: z.string().max(64) });
export type TemplateRef = z.infer<typeof TemplateRefSchema>;
