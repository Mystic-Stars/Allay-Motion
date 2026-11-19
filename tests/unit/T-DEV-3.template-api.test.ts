// T-DEV-3：template-api.d.ts 与 template-sdk 的类型一致（重新生成后没有差异）；用它对内置模板源码和示例 JS 做类型检查，
// 都通过（docs/08-milestones.md MD；docs/code-editing-and-mcp-plan.md H8）。
// 另外核对 d.ts 自包含（不 import 任何包），以及 ctx.THREE 的最小类型面与真实的 three（@types/three）兼容。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { EXAMPLE_DIR, generateAll, OUTPUTS } from '../../scripts/gen-template-api';
import { TEMPLATE_JSCONFIG } from '../../apps/desktop/src/shared/template-dev';
import { analyzeTemplateCode } from '../../apps/desktop/src/shared/template-code';
import { parseManifest } from '../../packages/template-sdk/src/index';
import { catalogNames } from '../fixtures/builtin-catalog';
import { builtinId } from '../fixtures/builtin-template-names';

const ROOT = resolve(import.meta.dirname, '../..');
const DTS = OUTPUTS.dts;
const DTS_MODULE = DTS.replace(/\.d\.ts$/, '');
const norm = (p: string) => p.replace(/\\/g, '/');

/** 与 tsconfig.base.json 相同的严格选项（内置模板就是按它写的） */
const STRICT: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2023,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ['lib.es2023.d.ts'],
  types: [],
  strict: true,
  noUncheckedIndexedAccess: true,
  noImplicitOverride: true,
  verbatimModuleSyntax: true,
  isolatedModules: true,
  skipLibCheck: false,
  noEmit: true,
};

/** 编译一组文件（可以有不在磁盘上的虚拟文件），返回全部诊断的文字 */
function typecheck(rootNames: string[], options: ts.CompilerOptions, virtual: Record<string, string> = {}): string[] {
  const files = new Map(Object.entries(virtual).map(([p, text]) => [norm(p), text]));
  const host = ts.createCompilerHost(options, true);
  const baseRead = host.readFile.bind(host);
  const baseExists = host.fileExists.bind(host);
  const baseGet = host.getSourceFile.bind(host);
  host.readFile = (f) => files.get(norm(f)) ?? baseRead(f);
  host.fileExists = (f) => files.has(norm(f)) || baseExists(f);
  host.getSourceFile = (f, lang, onError, create) => {
    const text = files.get(norm(f));
    return text !== undefined ? ts.createSourceFile(f, text, lang, true) : baseGet(f, lang, onError, create);
  };
  const program = ts.createProgram({ rootNames, options, host });
  return ts.getPreEmitDiagnostics(program).map((d) => {
    const where = d.file && d.start !== undefined ? `${norm(d.file.fileName).replace(`${norm(ROOT)}/`, '')}:${d.file.getLineAndCharacterOfPosition(d.start).line + 1}` : '';
    return `${where} TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`;
  });
}

/** jsconfig.json 的 compilerOptions 换成编译器 API 的形式 */
function jsconfigOptions(): ts.CompilerOptions {
  const { options, errors } = ts.convertCompilerOptionsFromJson(TEMPLATE_JSCONFIG.compilerOptions, ROOT);
  expect(errors).toEqual([]);
  return { ...options, allowJs: true, noEmit: true };
}

describe('T-DEV-3 模板接口的类型定义与编写指南', () => {
  it('生成物与源一致：重新生成后没有差异（d.ts、接口 JSON、编写指南）', () => {
    const fresh = generateAll();
    for (const key of Object.keys(OUTPUTS) as (keyof typeof OUTPUTS)[]) {
      expect(existsSync(OUTPUTS[key]), `${OUTPUTS[key]} 不存在，先跑 pnpm templates:api`).toBe(true);
      // 检出时可能被换成 CRLF：比较前统一成 LF
      const committed = readFileSync(OUTPUTS[key], 'utf8').replace(/\r\n/g, '\n');
      expect(committed, `${key} 过期了，跑 pnpm templates:api`).toBe(fresh[key]);
    }
  });

  it('d.ts 自包含：不 import 任何包，单独编译没有错误', () => {
    const sf = ts.createSourceFile(DTS, readFileSync(DTS, 'utf8'), ts.ScriptTarget.ES2023, true);
    const imports: string[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isImportDeclaration(n) || ts.isImportEqualsDeclaration(n) || ts.isImportTypeNode(n) || ts.isExportDeclaration(n)) imports.push(n.getText(sf));
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(imports).toEqual([]);
    expect(sf.referencedFiles.length + sf.typeReferenceDirectives.length + sf.libReferenceDirectives.length).toBe(0);
    expect(typecheck([DTS], STRICT)).toEqual([]);
  });

  it('接口 JSON 列出 ctx 的全部成员，每个都有说明', () => {
    const api = JSON.parse(readFileSync(OUTPUTS.json, 'utf8')) as { ctx: { name: string; doc: string; members?: { name: string; doc: string }[] }[]; easings: string[] };
    const names = api.ctx.map((m) => m.name);
    for (const n of ['THREE', 'params', 'stage', 'scene', 'camera', 'setCamera', 'createStageCamera', 'resources', 'text', 'sprite', 'random', 'noise2D', 'ease', 'math', 'time', 'audio', 'warn']) {
      expect(names).toContain(n);
    }
    const undocumented = api.ctx.flatMap((m) => [m, ...(m.members ?? [])]).filter((m) => m.doc.trim() === '').map((m) => m.name);
    expect(undocumented).toEqual([]);
    expect(api.easings).toContain('cubicInOut');
  });

  it('用生成的 d.ts 严格检查原有六款和两个工作台模板的源码', () => {
    const dir = join(ROOT, 'packages/templates');
    const templates = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'manifest.json')))
      .map((d) => d.name);
    expect(templates.sort()).toEqual(catalogNames);
    for (const name of catalogNames) {
      expect(JSON.parse(readFileSync(join(dir, name, 'manifest.json'), 'utf8'))).toMatchObject({ id: builtinId(name) });
    }
    const sources = templates
      .flatMap((name) => {
        const src = join(dir, name, 'src');
        const files = readdirSync(src);
        expect(files, name).toContain('index.ts');
        return files.map((file) => join(src, file));
      })
      .filter((f) => f.endsWith('.ts'));
    // 模板源码的 @allay/template-sdk 指向生成的 d.ts；types 为空，看不到 @types/three
    const diagnostics = typecheck(sources, { ...STRICT, paths: { '@allay/template-sdk': [DTS_MODULE] } });
    expect(diagnostics).toEqual([]);
  });

  it('示例 JS（编写指南里的最小示例）：按写进模板文件夹的 jsconfig 做 checkJs，也按严格模式检查，都通过', async () => {
    const dtsText = readFileSync(DTS, 'utf8');
    const code = readFileSync(join(EXAMPLE_DIR, 'template.js'), 'utf8');
    const file = join(EXAMPLE_DIR, 'template.js');
    const virtual = { [join(EXAMPLE_DIR, 'template-api.d.ts')]: dtsText };
    expect(typecheck([file], jsconfigOptions(), virtual)).toEqual([]);
    expect(typecheck([file], { ...STRICT, allowJs: true, checkJs: true }, virtual)).toEqual([]);
    // 示例本身也守规矩：没有规则提示，manifest 合法
    expect(await analyzeTemplateCode(code)).toEqual([]);
    const parsed = parseManifest(JSON.parse(readFileSync(join(EXAMPLE_DIR, 'manifest.json'), 'utf8')));
    expect(parsed.ok ? [] : parsed.issues).toEqual([]);
  });

  it('checkJs 确实在检查：用错 ctx 的成员会报错（反例）', () => {
    const file = join(EXAMPLE_DIR, 'broken.js');
    const virtual = {
      [file]: "/** @type {import('./template-api').TemplateModule} */\nexport default { setup(ctx) { ctx.resources.textur('x'); return { duration: 'long', update() {} }; } };\n",
      [join(EXAMPLE_DIR, 'template-api.d.ts')]: readFileSync(DTS, 'utf8'),
    };
    const diagnostics = typecheck([file], jsconfigOptions(), virtual).join('\n');
    expect(diagnostics).toMatch(/textur/);
    expect(diagnostics).toMatch(/duration/);
  });

  it('ctx.THREE 的最小类型面与真实的 three 兼容：真实的 THREE 可以赋给它', () => {
    // 虚拟文件放在 engine 包里，按它的位置解析 three 和 @types/three（engine 依赖 three 0.187）
    const check = join(ROOT, 'packages/engine/src/__t_dev_3_three_surface__.ts');
    const source = [
      "import type * as Real from 'three';",
      `import type { THREE as Surface, SetupContext } from '${norm(DTS_MODULE)}';`,
      'declare const real: typeof Real;',
      'export const asSurface: typeof Surface = real;',
      // 引擎交给模板的 ctx.THREE 就是 three 本身：真实的 SetupContext['THREE'] 也能赋过去
      "declare const realCtxThree: import('@allay/template-sdk').SetupContext['THREE'];",
      "export const ctxThree: SetupContext['THREE'] = realCtxThree;",
    ].join('\n');
    // 参数按双向比较（strictFunctionTypes 关掉）：类型面是真实 three 的子集，构造函数参数里出现的
    // Color、Texture 等是“少了成员”的版本，逆变比较必然不过；双向比较仍能抓出不存在的成员和类型不对的属性
    const diagnostics = typecheck([check], { ...STRICT, types: [], skipLibCheck: true, strictFunctionTypes: false }, { [check]: source });
    expect(diagnostics).toEqual([]);
  });
});
