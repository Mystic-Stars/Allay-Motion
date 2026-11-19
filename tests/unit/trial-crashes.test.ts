// 试用版报的缺陷（docs/decisions.md “试用版的三个崩溃”）里能在 Node 里复现的部分：
// 缺陷 2——从内置模板另存出的派生模板，生效 manifest 丢了参数分组，引擎的 load 校验报 unknown group。
// 缺陷 1、3 的根因（菜单的分组标题放在分组外，Base UI 抛错 #31）的源码检查；真正点出来的复现在 e2e（smoke.spec.ts、trial-crashes.spec.ts）。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '../../apps/desktop/src/renderer/i18n/locales/en.json';
import zhCN from '../../apps/desktop/src/renderer/i18n/locales/zh-CN.json';
import { buildDiagnostics, uncaughtLine } from '../../apps/desktop/src/renderer/app/diagnostics';
import { describeLoadIssues, loadIssuesOf } from '../../apps/desktop/src/renderer/features/preview/loadIssues';
import { rendererErrorLimiter } from '../../apps/desktop/src/main/renderer-log';
import { effectiveManifest, LoadRequestSchema, parseManifest, resolveDerived, resolveScript, type TemplateManifest } from '../../packages/template-sdk/src/index';
import { catalogNames } from '../fixtures/builtin-catalog';

const ROOT = join(import.meta.dirname, '../..');

function builtin(name: string): TemplateManifest {
  const r = parseManifest(JSON.parse(readFileSync(join(ROOT, 'packages/templates', name, 'manifest.json'), 'utf8')));
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.manifest;
}

/** 和“另存为模板”（templates.saveDerived）写出的 manifest 同一个形状 */
function derivedOf(base: TemplateManifest): TemplateManifest {
  const r = parseManifest({
    formatVersion: 1,
    id: 'user.08ba8e.234',
    version: '1.0.0',
    name: '234',
    category: base.category,
    extends: { id: base.id, version: `^${base.version}` },
    overrides: { defaults: {}, hidden: [] },
  });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.manifest;
}

const loadRequest = (manifest: TemplateManifest) => ({ manifest, code: 'export default {}', params: {}, output: { width: 1920, height: 1080, fps: 60 }, resourceStamp: '' });

describe('缺陷 2：派生模板的生效 manifest 带上基模板的参数分组', () => {
  it('T1 方块擦除另存出的派生模板：生效 manifest 过得了引擎的 load 校验', () => {
    const base = builtin('block-wipe');
    // 前提：T1 的参数确实引用了分组（试用时报错的就是这 16 个参数）
    expect(base.groups?.length).toBeGreaterThan(0);
    expect((base.params ?? []).filter((p) => p.group !== undefined).length).toBeGreaterThan(0);
    const m = effectiveManifest(resolveDerived(derivedOf(base), base));
    expect(m.groups).toEqual(base.groups);
    const r = LoadRequestSchema.safeParse(loadRequest(m));
    expect(r.success, r.success ? '' : JSON.stringify(r.error.issues.slice(0, 3))).toBe(true);
  });

  it.each(catalogNames)('%s：脚本模板和由它派生的模板，生效 manifest 都合法', (name) => {
    const base = builtin(name);
    for (const m of [effectiveManifest(resolveScript(base)), effectiveManifest(resolveDerived(derivedOf(base), base))]) {
      expect(parseManifest(m).ok).toBe(true);
      expect(LoadRequestSchema.safeParse(loadRequest(m)).success).toBe(true);
      expect(m.groups).toEqual(base.groups);
      expect(m.timeline).toEqual(base.timeline);
    }
  });

  it('派生模板自己写了分组也不混进来：分组和参数定义取同一份（基模板的）', () => {
    const base = builtin('block-wipe');
    const derived = { ...derivedOf(base), groups: [{ key: 'other', label: 'Other' }] };
    const m = effectiveManifest(resolveDerived(derived, base));
    expect(m.groups).toEqual(base.groups);
  });
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (name === 'node_modules' || name === 'out' || name === 'dist') return [];
    return statSync(full).isDirectory() ? walk(full) : /\.tsx$/.test(name) ? [full] : [];
  });
}

describe('缺陷 1、3：菜单的分组标题只出现在分组里', () => {
  it('每个 <DropdownMenuLabel> 都在某个 <DropdownMenuGroup> / <DropdownMenuRadioGroup> 里（否则渲染时抛 Base UI 错误 #31）', () => {
    const files = [...walk(join(ROOT, 'apps/desktop/src/renderer')), ...walk(join(ROOT, 'packages'))];
    const bad: string[] = [];
    let seen = 0;
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/<DropdownMenuLabel\b/g)) {
        seen++;
        const before = text.slice(0, m.index);
        const open = (before.match(/<DropdownMenu(Radio)?Group\b(?:\s[^>]*)?(?<!\/)>/g) ?? []).length;
        const close = (before.match(/<\/DropdownMenu(Radio)?Group>/g) ?? []).length;
        if (open <= close) bad.push(`${file.slice(ROOT.length + 1)}:${before.split('\n').length}`);
      }
    }
    expect(seen).toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });
});

/** 极简的 t：按点号路径取 locale JSON，替换 {{x}} */
function makeT(dict: unknown) {
  return (key: string, vars: Record<string, unknown> = {}) => {
    const v = key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], dict);
    if (typeof v !== 'string') throw new Error(`missing ${key}`);
    return v.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => String(vars[k]));
  };
}

describe('装载失败的提示：zod 的 issue 整理成“哪个参数、什么问题”', () => {
  const base = builtin('block-wipe');
  // 修复前的生效 manifest（丢了 groups）在引擎里 parse 失败时，Worker 传回来的就是这样一个错误
  const { groups: _g, ...broken } = effectiveManifest(resolveDerived(derivedOf(base), base));
  const parsed = LoadRequestSchema.safeParse(loadRequest(broken as TemplateManifest));
  if (parsed.success) throw new Error('expected the broken manifest to fail');
  const wire = { name: parsed.error.name, message: parsed.error.message };

  it('从跨 Worker 的错误（只剩 name、message）里取回 issue；别的错误不当成校验错误', () => {
    const issues = loadIssuesOf(wire);
    expect(issues?.length).toBe(parsed.error.issues.length);
    expect(issues![0]!.path.slice(0, 3)).toEqual(['manifest', 'params', issues![0]!.path[2]]);
    expect(loadIssuesOf(new Error('boom'))).toBeNull();
    expect(loadIssuesOf({ name: 'ZodError', message: 'not json' })).toBeNull();
    expect(loadIssuesOf(null)).toBeNull();
  });

  it('两种语言各一句话，带参数的显示名，不出现原始 JSON', () => {
    const issues = loadIssuesOf(wire)!;
    const first = issues[0]!;
    const def = base.params![first.path[2] as number]!;
    const zh = describeLoadIssues(issues, broken as TemplateManifest, makeT(zhCN), 'zh-CN');
    const eng = describeLoadIssues(issues, broken as TemplateManifest, makeT(en), 'en');
    expect(zh).toHaveLength(issues.length);
    const label = (l: unknown, lang: 'zh-CN' | 'en') => (typeof l === 'string' ? l : (l as Record<string, string>)[lang]);
    expect(zh[0]).toBe(`参数“${label(def.label, 'zh-CN')}”的 group：引用了不存在的分组“${def.group}”`);
    expect(eng[0]).toBe(`Parameter “${label(def.label, 'en')}”, group: refers to a group “${def.group}” that does not exist`);
    for (const line of [...zh, ...eng]) expect(line).not.toMatch(/[{}[\]]/);
  });

  it('不在参数上的问题、认不出的问题也有一句话', () => {
    const t = makeT(zhCN);
    expect(describeLoadIssues([{ path: ['output', 'fps'], message: 'Too big', code: 'too_big' }], null, t, 'zh-CN')).toEqual(['output.fps：超出上限']);
    expect(describeLoadIssues([{ path: [], message: '???' }], null, t, 'zh-CN')).toEqual(['取值不合法']);
    expect(describeLoadIssues([{ path: ['params', 3, 'default'], message: 'default is outside [min, max]' }], null, t, 'zh-CN')).toEqual(['参数“#4”的 default：默认值不合法']);
  });
});

describe('诊断信息与日志行', () => {
  it('诊断信息：哪一块、错误、组件栈、现场，是合法 JSON', () => {
    const err = new Error('Base UI error #31');
    const text = buildDiagnostics({ scope: 'right.props', error: err, componentStack: '\n    at MenuGroupLabel\n    at PropsTab', context: { template: { id: 'a.b.c', version: '1.0.0' } }, now: new Date(0), userAgent: 'ua' });
    const info = JSON.parse(text) as Record<string, unknown>;
    expect(info).toMatchObject({ scope: 'right.props', error: { name: 'Error', message: 'Base UI error #31' }, template: { id: 'a.b.c' }, userAgent: 'ua', time: '1970-01-01T00:00:00.000Z' });
    expect(String(info.componentStack)).toContain('MenuGroupLabel');
    expect(JSON.parse(buildDiagnostics({ scope: 'app', error: 'just a string', userAgent: 'ua' }))).toMatchObject({ error: { message: 'just a string' } });
  });

  it('日志行带前缀和栈的前几行', () => {
    const e = new Error('x');
    expect(uncaughtLine('unhandled-rejection', null, e)).toMatch(/^\[unhandled-rejection\] Error: x @ /);
    expect(uncaughtLine('render-error', 'topbar', 'plain')).toBe('[render-error] [topbar] Error: plain');
  });

  it('渲染进程错误写日志限流：每分钟 60 条，超出的第一条换成提示，其余丢掉，下一分钟恢复', () => {
    const limit = rendererErrorLimiter(3);
    expect([0, 1, 2, 3, 4].map((t) => limit(t))).toEqual(['log', 'log', 'log', 'notice', 'drop']);
    expect(limit(60_000)).toBe('log');
  });
});
