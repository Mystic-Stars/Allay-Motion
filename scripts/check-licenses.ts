// 生产依赖的许可检查（docs/09-compliance.md 9.8）。CI 里运行，遇到不在允许列表里的许可就失败。
//
// - 允许：MIT、BSD、ISC、Apache-2.0、0BSD、Zlib、CC0。生产依赖不分发文字字体。
// - 不允许：GPL、AGPL、SSPL、任何带“禁止某类用途”条款的许可、无法识别的许可。
// - LGPL 只允许以独立进程调用的 FFmpeg，它不是 npm 依赖，不在这里出现。
// - 点名禁止 GSAP 和 Theatre.js（9.8）。
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

export const ALLOWED_LICENSES = new Set([
  'MIT',
  'MIT-0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'Apache-2.0',
  '0BSD',
  'Zlib',
  'CC0-1.0',
]);

/** 无论许可写的是什么都不许用的包 */
export const BANNED_PACKAGES: { pattern: RegExp; reason: string }[] = [
  { pattern: /^gsap$|^@gsap\//, reason: 'GSAP 的标准许可禁止用于本类工具（9.8）' },
  { pattern: /^@theatre\//, reason: 'Theatre.js 的 studio 是 AGPL-3.0（9.8）' },
];

type Expr = { kind: 'id'; id: string } | { kind: 'and' | 'or'; left: Expr; right: Expr };

/** 解析 SPDX 表达式（支持括号、AND、OR、WITH） */
export function parseSpdx(input: string): Expr {
  const tokens = input
    .replace(/\(/g, ' ( ')
    .replace(/\)/g, ' ) ')
    .split(/\s+/)
    .filter(Boolean);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function primary(): Expr {
    const tok = next();
    if (tok === undefined) throw new Error(`unexpected end of license expression: ${input}`);
    if (tok === '(') {
      const e = orExpr();
      if (next() !== ')') throw new Error(`missing ) in license expression: ${input}`);
      return e;
    }
    let id = tok;
    if (peek()?.toUpperCase() === 'WITH') {
      next();
      id = `${id} WITH ${next() ?? ''}`;
    }
    return { kind: 'id', id };
  }
  function andExpr(): Expr {
    let left = primary();
    while (peek()?.toUpperCase() === 'AND') {
      next();
      left = { kind: 'and', left, right: primary() };
    }
    return left;
  }
  function orExpr(): Expr {
    let left = andExpr();
    while (peek()?.toUpperCase() === 'OR') {
      next();
      left = { kind: 'or', left, right: andExpr() };
    }
    return left;
  }
  const expr = orExpr();
  if (pos !== tokens.length) throw new Error(`unexpected token in license expression: ${input}`);
  return expr;
}

export function isLicenseAllowed(license: string, packageName: string): boolean {
  if (/^@fontsource(?:-variable)?\//.test(packageName)) return false;
  let expr: Expr;
  try {
    expr = parseSpdx(license.trim());
  } catch {
    return false;
  }
  const ok = (e: Expr): boolean => {
    switch (e.kind) {
      case 'id':
        return ALLOWED_LICENSES.has(e.id);
      case 'and':
        return ok(e.left) && ok(e.right);
      case 'or':
        return ok(e.left) || ok(e.right);
    }
  };
  return ok(expr);
}

export interface PackageLicense {
  name: string;
  version: string;
  license: string;
}

export interface LicenseViolation extends PackageLicense {
  reason: string;
}

export function findViolations(packages: readonly PackageLicense[]): LicenseViolation[] {
  const out: LicenseViolation[] = [];
  for (const pkg of packages) {
    const banned = BANNED_PACKAGES.find((b) => b.pattern.test(pkg.name));
    if (banned) {
      out.push({ ...pkg, reason: banned.reason });
      continue;
    }
    if (!isLicenseAllowed(pkg.license, pkg.name)) {
      out.push({ ...pkg, reason: `许可 "${pkg.license}" 不在允许列表里（9.8）` });
    }
  }
  return out;
}

const PnpmLicensesSchema = z.record(
  z.string(),
  z.array(
    z.object({
      name: z.string(),
      versions: z.array(z.string()),
      paths: z.array(z.string()).optional(),
      license: z.string(),
      author: z.string().optional(),
      homepage: z.string().optional(),
    }),
  ),
);

/** 生产依赖，带上安装位置和作者、主页（第三方许可清单用，M8） */
export interface PackageInfo extends PackageLicense {
  /** 本机的安装目录（只在生成时用，不写进清单） */
  path: string | null;
  author: string | null;
  homepage: string | null;
}

/** 读 pnpm 列出的全部生产依赖（所有 workspace 包，含传递依赖） */
export function listProductionPackages(cwd: string): PackageInfo[] {
  // 固定的命令行，没有外部输入
  const raw = execSync('pnpm -r licenses list --prod --json', { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const parsed = PnpmLicensesSchema.parse(JSON.parse(raw));
  const out: PackageInfo[] = [];
  for (const [group, pkgs] of Object.entries(parsed)) {
    for (const p of pkgs) {
      p.versions.forEach((version, i) =>
        out.push({ name: p.name, version, license: p.license || group, path: p.paths?.[i] ?? null, author: p.author ?? null, homepage: p.homepage ?? null }),
      );
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

export function listProductionLicenses(cwd: string): PackageLicense[] {
  return listProductionPackages(cwd).map(({ name, version, license }) => ({ name, version, license }));
}

function main(): void {
  const packages = listProductionLicenses(process.cwd());
  if (packages.length === 0) {
    console.error('check-licenses: pnpm 没有列出任何生产依赖，这不正常');
    process.exit(1);
  }
  const violations = findViolations(packages);
  const summary = new Map<string, number>();
  for (const p of packages) summary.set(p.license, (summary.get(p.license) ?? 0) + 1);
  console.log(`check-licenses: ${packages.length} 个生产依赖；${[...summary].map(([l, n]) => `${l} ×${n}`).join('，')}`);
  if (violations.length > 0) {
    for (const v of violations) console.error(`  ✗ ${v.name}@${v.version}: ${v.reason}`);
    process.exit(1);
  }
  console.log('check-licenses: 全部在允许列表里');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
