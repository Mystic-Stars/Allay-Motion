// 第三方许可清单（docs/09-compliance.md 9.7、9.8、9.9，docs/08-milestones.md M8）。
//
// 一份数据，两个去处：
// - apps/desktop/src/renderer/features/settings/third-party-licenses.json：提交进仓库，“关于 → 第三方许可”读它（惰性加载）；
//   单元测试（M8.third-party）重新生成一遍和提交的比对，依赖变了忘了更新就失败。
// - 安装目录的 THIRD_PARTY_NOTICES.txt：pnpm dist 时由同一份数据写成纯文本（scripts/dist-extras.ts），随安装包附带。
//
// 内容：
// - 生产依赖（pnpm -r licenses list --prod，和 check-licenses 同一个来源），带包里的许可文件原文；
// - 构建时编进 CSS 的两个开发依赖（tailwindcss 的基础样式、shadcn 的 tailwind.css）；
// - Electron（Chromium 的许可全文在安装目录的 LICENSES.chromium.html，太大，这里只指过去）；
// - FFmpeg（LGPLv3，独立进程；许可全文是 ffmpeg/<平台>/LICENSE.txt，写明构建来源、版本和取得源码的方式；
//   Windows 用 FFmpeg-Builds 的构建，macOS 用本项目从官方源码编译的，两份的来源都记在清单里）；
//
// 用法：tsx scripts/third-party.ts           重新生成提交的 JSON
//       tsx scripts/third-party.ts --check   只比对，不一致时退出码 1
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isLicenseAllowed, listProductionPackages } from './check-licenses';
import { FFMPEG_BUILD, FFMPEG_MACOS } from './ffmpeg-build';

export const ROOT = resolve(import.meta.dirname, '..');
export const THIRD_PARTY_JSON = join(ROOT, 'apps/desktop/src/renderer/features/settings/third-party-licenses.json');

export type ThirdPartyKind = 'npm' | 'build' | 'runtime' | 'binary';

export interface ThirdPartyEntry {
  name: string;
  version: string;
  /** SPDX 表达式 */
  license: string;
  kind: ThirdPartyKind;
  author: string | null;
  homepage: string | null;
  /** 许可全文；在别的文件里（FFmpeg、Chromium）时为 null，见 seeFile */
  text: string | null;
  /** 许可全文所在的文件（相对安装目录） */
  seeFile: string | null;
}

/** macOS 版随包的 FFmpeg：本项目从官方源码编译（scripts/ffmpeg-macos.ts），静态链接的 libvpx、libopus 也列出来 */
export interface FfmpegMacosInfo {
  version: string;
  license: string;
  buildScript: string;
  sources: { name: string; version: string; url: string; sha256: string; license: string }[];
}

export interface ThirdPartyFile {
  formatVersion: 1;
  ffmpeg: { version: string; commit: string; buildRepo: string; buildTag: string; asset: string; sha256: string };
  ffmpegMacos: FfmpegMacosInfo;
  entries: ThirdPartyEntry[];
}

/** 打包的目标平台（决定 THIRD_PARTY_NOTICES.txt 里写哪一份 FFmpeg） */
export type NoticesTarget = 'win32-x64' | 'darwin-arm64' | 'darwin-x64';

/** 构建时编进渲染进程 CSS 的开发依赖（它们的代码不进安装包，生成的样式进） */
const BUILD_PACKAGES: { name: string; from: string }[] = [
  { name: 'tailwindcss', from: 'apps/desktop' },
  { name: 'shadcn', from: 'packages/ui' },
];

const LICENSE_FILE = /^(licen[sc]e|copying)(\.(md|txt|markdown))?$/i;
const LICENSE_FILE_LOOSE = /^(licen[sc]e|copying)/i;

/** 包目录里的许可文件原文（换行统一成 \n）；没有时为 null */
export function readLicenseText(dir: string): string | null {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const name = names.filter((n) => LICENSE_FILE.test(n)).sort()[0] ?? names.filter((n) => LICENSE_FILE_LOOSE.test(n)).sort()[0];
  if (!name) return null;
  return readFileSync(join(dir, name), 'utf8').replace(/\r\n?/g, '\n').trim();
}

/** 某个 workspace 包能看到的依赖目录（pnpm 建的链接；有的包的 exports 不让 resolve package.json） */
function packageDir(name: string, from: string): string {
  return realpathSync(join(ROOT, from, 'node_modules', name));
}

function packageJson(dir: string): { version: string; license?: string; author?: string | { name?: string }; homepage?: string } {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string };
}

function authorOf(a: string | { name?: string } | undefined): string | null {
  if (!a) return null;
  return typeof a === 'string' ? a : (a.name ?? null);
}

export function collectThirdParty(root: string = ROOT): ThirdPartyFile {
  const entries: ThirdPartyEntry[] = [];
  const seen = new Set<string>();
  for (const p of listProductionPackages(root)) {
    // workspace 自己的包不算第三方
    if (p.name.startsWith('@allay/')) continue;
    const key = `${p.name}@${p.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      name: p.name,
      version: p.version,
      license: p.license,
      kind: 'npm',
      author: p.author,
      homepage: p.homepage,
      text: p.path ? readLicenseText(p.path) : null,
      seeFile: null,
    });
  }
  for (const b of BUILD_PACKAGES) {
    const dir = packageDir(b.name, b.from);
    const pj = packageJson(dir);
    entries.push({ name: b.name, version: pj.version, license: pj.license ?? 'UNKNOWN', kind: 'build', author: authorOf(pj.author), homepage: pj.homepage ?? null, text: readLicenseText(dir), seeFile: null });
  }
  const electronDir = packageDir('electron', 'apps/desktop');
  const electron = packageJson(electronDir);
  entries.push({
    name: 'electron',
    version: electron.version,
    license: 'MIT',
    kind: 'runtime',
    author: 'Electron contributors',
    homepage: 'https://www.electronjs.org',
    text: readLicenseText(electronDir),
    seeFile: 'LICENSES.chromium.html',
  });
  entries.push({
    name: 'FFmpeg',
    version: FFMPEG_BUILD.version,
    license: 'LGPL-3.0-or-later',
    kind: 'binary',
    author: 'the FFmpeg developers',
    homepage: 'https://ffmpeg.org',
    text: null,
    seeFile: `resources/ffmpeg/${FFMPEG_BUILD.platform}/LICENSE.txt`,
  });
  return {
    formatVersion: 1,
    ffmpeg: { version: FFMPEG_BUILD.version, commit: FFMPEG_BUILD.commit, buildRepo: FFMPEG_BUILD.repo, buildTag: FFMPEG_BUILD.tag, asset: FFMPEG_BUILD.asset, sha256: FFMPEG_BUILD.sha256 },
    ffmpegMacos: {
      version: FFMPEG_MACOS.version,
      license: 'LGPL-3.0-or-later',
      buildScript: 'scripts/ffmpeg-macos.ts',
      sources: FFMPEG_MACOS.sources.map(({ name, version, url, sha256, license }) => ({ name, version, url, sha256, license })),
    },
    entries,
  };
}

/** THIRD_PARTY_NOTICES.txt 开头关于 FFmpeg 的几行：按打包的平台写对应的那一份构建 */
export function ffmpegNoticeLines(file: ThirdPartyFile, target: NoticesTarget): string[] {
  if (target === 'win32-x64') {
    return [
      `FFmpeg ${file.ffmpeg.version} (LGPL-3.0-or-later) is called as a separate process (resources/ffmpeg/win32-x64/ffmpeg.exe) and may be replaced by the user.`,
      `Build: ${file.ffmpeg.buildRepo}, release ${file.ffmpeg.buildTag}, ${file.ffmpeg.asset} (SHA-256 ${file.ffmpeg.sha256}).`,
      `Source: https://git.ffmpeg.org/ffmpeg.git at commit ${file.ffmpeg.commit}; build scripts: https://github.com/${file.ffmpeg.buildRepo}/tree/${file.ffmpeg.buildTag}.`,
    ];
  }
  const m = file.ffmpegMacos;
  return [
    `FFmpeg ${m.version} (${m.license}) is called as a separate process (Contents/Resources/ffmpeg/${target}/ffmpeg) and may be replaced by the user.`,
    `Build: compiled by this project from the official source release with an LGPL-only configuration (${m.buildScript} in the source repository), statically linking libvpx and libopus (BSD-3-Clause).`,
    ...m.sources.map((s) => `Source: ${s.name} ${s.version}, ${s.url} (SHA-256 ${s.sha256}), ${s.license}.`),
    `Full license texts of FFmpeg, libvpx and libopus: Contents/Resources/ffmpeg/${target}/LICENSE.txt.`,
  ];
}

/** 许可是否合规：FFmpeg 是唯一允许的 LGPL（独立进程，9.8）；其余按 check-licenses 的允许列表 */
export function entryAllowed(e: ThirdPartyEntry): boolean {
  if (e.kind === 'binary') return e.name === 'FFmpeg' && e.license === 'LGPL-3.0-or-later';
  return isLicenseAllowed(e.license, e.name);
}

export function serialize(file: ThirdPartyFile): string {
  return `${JSON.stringify(file, null, 1)}\n`;
}

/** 安装目录里的纯文本版本 */
export function renderNotices(file: ThirdPartyFile, header: string, target: NoticesTarget = 'win32-x64'): string {
  const lines: string[] = [header, '', 'Third-party software included in this application / 本应用包含的第三方软件', ''];
  lines.push(...ffmpegNoticeLines(file, target), '');
  for (const e of file.entries) {
    lines.push('='.repeat(78), `${e.name} ${e.version} — ${e.license}`);
    if (e.author) lines.push(`Author: ${e.author}`);
    if (e.homepage) lines.push(`Homepage: ${e.homepage}`);
    // FFmpeg 的许可全文随平台的构建放在不同位置（清单里记的是 Windows 的）
    const seeFile = e.kind === 'binary' && e.name === 'FFmpeg' && target !== 'win32-x64' ? `Contents/Resources/ffmpeg/${target}/LICENSE.txt` : e.seeFile;
    if (seeFile) lines.push(`Full license text: ${seeFile}`);
    lines.push('');
    if (e.text) lines.push(e.text, '');
    else if (!e.seeFile) lines.push(`(No license file in the package; licensed under ${e.license}.)`, '');
  }
  return `${lines.join('\n').replace(/\n/g, '\r\n')}\r\n`;
}

function main(): void {
  const file = collectThirdParty();
  const bad = file.entries.filter((e) => !entryAllowed(e));
  if (bad.length > 0) {
    for (const e of bad) console.error(`  ✗ ${e.name}@${e.version}: ${e.license}`);
    process.exit(1);
  }
  const text = serialize(file);
  if (process.argv.includes('--check')) {
    const current = existsSync(THIRD_PARTY_JSON) ? readFileSync(THIRD_PARTY_JSON, 'utf8').replace(/\r\n/g, '\n') : '';
    if (current !== text) {
      console.error('third-party: 第三方许可清单过期了，运行 pnpm licenses:gen 重新生成');
      process.exit(1);
    }
    console.log(`third-party: 清单是最新的（${file.entries.length} 项）`);
    return;
  }
  writeFileSync(THIRD_PARTY_JSON, text);
  console.log(`third-party: 写入 ${THIRD_PARTY_JSON}（${file.entries.length} 项，${(text.length / 1024).toFixed(0)} KB）`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
