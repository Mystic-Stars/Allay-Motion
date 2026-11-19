// pnpm templates:build：把 packages/templates/<name>/ 打成 .allaytpl，输出到 resources/templates/（docs/04-templates.md 4.9）。
//
// - esbuild 把 src/index.ts 打成单文件 ESM。只有本目录内的相对导入会被打进去；任何包导入（包括 three、
//   template-sdk 的运行时）都保持外部，随后被 es-module-lexer 的检查拦下——内置模板必须只用 ctx。
// - manifest 经 template-sdk 的 schema 校验，id 必须以 allay. 开头。
// - 包里只有 manifest.json、template.js、README.md（若有）和 assets/ 下白名单扩展名的文件。
// - 产物是确定的：同样的源码产出逐字节相同的 .allaytpl。
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { parseManifest, type TemplateManifest } from '../packages/template-sdk/src/index';
import { writeZip, type ZipInput } from '../apps/desktop/src/main/templates/zip-writer';
import { analyzeTemplateCode } from '../apps/desktop/src/shared/template-code';
import { PACKAGE_EXTENSIONS, packageFileName } from '../apps/desktop/src/shared/templates';

const ROOT = resolve(import.meta.dirname, '..');
export const TEMPLATES_SRC = join(ROOT, 'packages/templates');
export const TEMPLATES_OUT = join(ROOT, 'resources/templates');

/** 当前随应用分发的原始六款；用户模板仍由独立的导入流程装载。 */
export const BUILTIN_TEMPLATE_NAMES = [
  'advancement-toast', 'block-fall', 'block-wipe', 'item-stinger', 'loading-screen', 'pixel-dissolve',
] as const;

/** 意外放回已撤下的目录时构建失败，不能悄悄重新分发。 */
export function templateDirs(): string[] {
  const dirs = readdirSync(TEMPLATES_SRC)
    .map((name) => join(TEMPLATES_SRC, name))
    .filter((dir) => statSync(dir).isDirectory() && existsSync(join(dir, 'manifest.json')))
    .sort();
  const expected: readonly string[] = BUILTIN_TEMPLATE_NAMES;
  const extra = dirs.filter((dir) => !expected.includes(basename(dir)));
  const missing = expected.filter((name) => !dirs.some((dir) => basename(dir) === name));
  if (extra.length || missing.length) throw new Error(`built-in catalog must contain the original six only; extra: ${extra.map((dir) => basename(dir)).join(', ')}; missing: ${missing.join(', ')}`);
  return dirs;
}

export function readTemplateManifest(dir: string): TemplateManifest {
  const parsed = parseManifest(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')));
  if (!parsed.ok) throw new Error(`${relative(ROOT, dir)}/manifest.json: ${parsed.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`);
  if (parsed.manifest.id !== `allay.builtin.${basename(dir)}`) throw new Error(`${parsed.manifest.id}: id does not match template directory ${basename(dir)}`);
  return parsed.manifest;
}

/** 把模板源码打成不含 import 的单文件 ESM 文本 */
export async function bundleTemplate(dir: string, onSource?: (path: string) => void): Promise<string> {
  const result = await build({
    entryPoints: [join(dir, 'src/index.ts')],
    bundle: true,
    metafile: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    target: 'es2023',
    charset: 'utf8',
    legalComments: 'none',
    logLevel: 'silent',
    plugins: [
      {
        name: 'local-only',
        setup(b) {
          // 非相对路径一律外部：留在产物里，交给下面的导入检查拒绝
          b.onResolve({ filter: /^[^./]/ }, (args) => (args.kind === 'entry-point' ? undefined : { path: args.path, external: true }));
        },
      },
    ],
  });
  const root = realpathSync(dir);
  for (const input of Object.keys(result.metafile.inputs)) {
    const path = realpathSync(input);
    if (!path.startsWith(`${root}${sep}`)) throw new Error(`${dir}: unexpected bundled source ${input}`);
    onSource?.(path);
  }
  const out = result.outputFiles[0];
  if (!out) throw new Error(`${relative(ROOT, dir)}: esbuild produced no output`);
  const code = out.text;
  // 内置模板也过确定性的静态规则（H12）：有 Math.random、Date.now 之类就让构建失败（硬性规则 2）
  const rules = await analyzeTemplateCode(code);
  if (rules.length > 0) {
    throw new Error(`${relative(ROOT, dir)}: ${rules.map((d) => `${d.code} at ${d.line ?? '?'}:${d.column ?? '?'}`).join(', ')} (bundled output)`);
  }
  return code;
}

function listFiles(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p, base));
    else out.push(relative(base, p).split(sep).join('/'));
  }
  return out;
}

/** 一个模板目录 → .allaytpl 的内容 */
export async function packTemplate(dir: string): Promise<{ manifest: TemplateManifest; fileName: string; zip: Buffer; code: string }> {
  const manifest = readTemplateManifest(dir);
  const code = await bundleTemplate(dir);
  const entries: ZipInput[] = [
    { path: 'manifest.json', data: readFileSync(join(dir, 'manifest.json')) },
    { path: 'template.js', data: Buffer.from(code, 'utf8') },
  ];
  if (existsSync(join(dir, 'README.md'))) entries.push({ path: 'README.md', data: readFileSync(join(dir, 'README.md')) });
  for (const rel of listFiles(join(dir, 'assets'))) {
    const ext = rel.slice(rel.lastIndexOf('.')).toLowerCase();
    if (!PACKAGE_EXTENSIONS.includes(ext)) throw new Error(`${relative(ROOT, dir)}/assets/${rel}: extension ${ext} is not allowed in a template package`);
    entries.push({ path: `assets/${rel}`, data: readFileSync(join(dir, 'assets', rel)) });
  }
  return { manifest, fileName: packageFileName(manifest.id, manifest.version), zip: writeZip(entries), code };
}

export async function buildTemplates(outDir = TEMPLATES_OUT, log: (m: string) => void = () => undefined): Promise<string[]> {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  const ids = new Set<string>();
  for (const dir of templateDirs()) {
    const { manifest, fileName, zip } = await packTemplate(dir);
    if (ids.has(manifest.id)) throw new Error(`duplicate built-in template id ${manifest.id}`);
    ids.add(manifest.id);
    writeFileSync(join(outDir, fileName), zip);
    written.push(fileName);
    log(`${manifest.id}@${manifest.version} → ${relative(ROOT, join(outDir, fileName))}（${zip.length} 字节）`);
  }
  return written;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const files = await buildTemplates(TEMPLATES_OUT, (m) => console.log(`[templates:build] ${m}`));
    console.log(`[templates:build] ${files.length} 个内置模板`);
  } catch (error) {
    console.error(`[templates:build] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
