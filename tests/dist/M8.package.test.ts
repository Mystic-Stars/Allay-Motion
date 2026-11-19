import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { brandMessages } from '../../packages/ui/src/brand/messages';
import { FFMPEG_MACOS } from '../../scripts/ffmpeg-build';
import { DMG_PATTERN, FFMPEG_TARGET, IS_MAC, IS_WIN, MAC_ZIP_PATTERN, RELEASE, ROOT, macApp, macInfoPlist, releaseFile } from './platform';

// M8（打包后）：安装包里有什么、没有什么；文件关联、快捷方式、欢迎页的声明写进了安装脚本。
// 由 pnpm dist 在 electron-builder 之后运行。Windows 的安装包用 electron-builder 缓存里的 7-Zip 列出内容（只读，不安装）；
// macOS 看 .app、zip 的文件列表、Info.plist 和签名（docs/decisions.md“macOS 构建”）。

const UNPACKED = join(RELEASE, 'win-unpacked');
const BUILD = join(ROOT, 'apps/desktop/build');

function installer(): string {
  const name = readdirSync(RELEASE).find((f) => /-x64-setup\.exe$/.test(f));
  if (!name) throw new Error(`${RELEASE} 里没有安装包（pnpm dist 没跑完）`);
  return join(RELEASE, name);
}

/** electron-builder 打 NSIS 包时下载并缓存的 7za（有缓存时打包不联网，decisions.md M0） */
function sevenZip(): string {
  const cache = join(process.env.LOCALAPPDATA ?? '', 'electron-builder', 'Cache');
  for (const dir of existsSync(cache) ? readdirSync(cache).filter((d) => d.startsWith('7zip')) : []) {
    for (const sub of readdirSync(join(cache, dir))) {
      const exe = join(cache, dir, sub, 'bin', '7za.exe');
      if (existsSync(exe)) return exe;
    }
  }
  throw new Error(`在 ${cache} 里找不到 electron-builder 的 7za.exe`);
}

/** 安装包里打包的应用文件（相对安装目录，/ 分隔） */
function installerFiles(): string[] {
  const r = spawnSync(sevenZip(), ['l', '-slt', installer()], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && r.status !== 1) throw new Error(`7za 失败：${r.stderr}`);
  // 第一条 Path 是安装包自己
  return [...r.stdout.matchAll(/^Path = (.+)$/gm)].slice(1).map((m) => m[1]!.trim().replace(/\\/g, '/'));
}

describe.runIf(IS_WIN)('M8 安装包的内容', () => {
  it('解包目录和安装包里都没有 Electron 自带的 default_app.asar', () => {
    expect(existsSync(join(UNPACKED, 'resources', 'app.asar'))).toBe(true);
    expect(existsSync(join(UNPACKED, 'resources', 'default_app.asar'))).toBe(false);
    const files = installerFiles();
    expect(files).toContain('resources/app.asar');
    expect(files.filter((f) => /default_app/i.test(f))).toEqual([]);
  });

  it('随包附带许可与声明：FFmpeg 的 LGPL 全文和构建来源、Chromium 与 Electron 的许可、第三方许可清单', () => {
    const files = installerFiles();
    for (const f of [
      'THIRD_PARTY_NOTICES.txt',
      'LICENSES.chromium.html',
      'LICENSE.electron.txt',
      'resources/ffmpeg/win32-x64/ffmpeg.exe',
      'resources/ffmpeg/win32-x64/LICENSE.txt',
      'resources/ffmpeg/win32-x64/build.json',
    ])
      expect(files, f).toContain(f);
    expect(files.filter((path) => /ark[- ]pixel|\.bdf(?:\.gz)?$/i.test(path))).toEqual([]);
    // ffprobe 只给测试用
    expect(files.some((f) => /ffprobe/i.test(f))).toBe(false);
    const notices = readFileSync(join(UNPACKED, 'THIRD_PARTY_NOTICES.txt'), 'utf8');
    expect(notices).toContain(brandMessages.en.disclaimer);
    expect(notices).toContain('LGPL-3.0-or-later');
    expect(readFileSync(join(UNPACKED, 'resources/ffmpeg/win32-x64/LICENSE.txt'), 'utf8')).toContain('GNU LESSER GENERAL PUBLIC LICENSE');
  });

  it('只带运行时需要的东西：没有源码映射、没有测试夹具、没有 node_modules', () => {
    const files = installerFiles();
    expect(files.filter((f) => /\.map$|node_modules|tests\/fixtures|\.ts$/.test(f))).toEqual([]);
  });

  it('安装包的大小记一笔（不设上限）', () => {
    const size = statSync(installer()).size;
    console.log(`安装包：${installer()}，${(size / 1024 / 1024).toFixed(1)} MiB（${size} 字节）`);
    expect(size).toBeGreaterThan(50 * 1024 * 1024);
  });
});

describe.runIf(IS_WIN)('M8 安装脚本（electron-builder 生成的 NSIS 脚本，记在 builder-debug.yml）', () => {
  const debug = () => readFileSync(join(RELEASE, 'builder-debug.yml'), 'utf8');

  // 按用户安装、快捷方式这些开关以 -D 传给 makensis，不在脚本里；它们的来源是 electron-builder.yml
  it('.allay 和 .allaytpl 关联到应用，双击时把路径作为参数交给它', () => {
    const text = debug();
    expect(text).toContain('!macro registerFileAssociations');
    expect(text).toMatch(/APP_ASSOCIATE "allay" "AllayMotion\.Project" .* "\$appExe \$\\"%1\$\\""/);
    expect(text).toMatch(/APP_ASSOCIATE "allaytpl" "AllayMotion\.Template" .* "\$appExe \$\\"%1\$\\""/);
  });

  it('欢迎页来自 build/installer.nsh，带完整的非官方声明（中英文）', () => {
    expect(debug()).toMatch(/!include ".*[\\/]apps[\\/]desktop[\\/]build[\\/]installer\.nsh"/);
    const nsh = readFileSync(join(BUILD, 'installer.nsh'), 'utf8');
    expect(nsh).toContain('!macro customWelcomePage');
    // 临时空间不足时在卸载旧版本之前退出（docs/decisions.md“安装时临时空间不足”）
    expect(nsh).toContain('!macro customInit');
    expect(nsh).toMatch(/\$\{DriveSpace\} "\$R9\\" "\/D=F \/S=M" \$R8/);
    expect(nsh).toContain('NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.');
    expect(nsh).toContain('本软件不是 Minecraft 官方产品');
  });
});

// ---------------------------------------------------------------- macOS

function run(cmd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** zip 里的文件（相对 .app 所在的目录，/ 分隔） */
function macZipFiles(): string[] {
  const r = run('unzip', ['-Z1', releaseFile(MAC_ZIP_PATTERN)]);
  if (r.status !== 0) throw new Error(`unzip 失败：${r.stderr}`);
  return r.stdout.split('\n').filter(Boolean);
}

describe.runIf(IS_MAC)('M8 macOS 应用包的内容', () => {
  const resources = () => join(macApp(), 'Contents', 'Resources');

  it('.app 和 zip 里都没有 Electron 自带的 default_app.asar', () => {
    expect(existsSync(join(resources(), 'app.asar'))).toBe(true);
    expect(existsSync(join(resources(), 'default_app.asar'))).toBe(false);
    const files = macZipFiles();
    expect(files.some((f) => f.endsWith('/Contents/Resources/app.asar'))).toBe(true);
    expect(files.filter((f) => /default_app/i.test(f))).toEqual([]);
  });

  it('随包附带许可与声明：FFmpeg（LGPL 全文、libvpx 和 libopus 的 BSD、构建来源）、Chromium 与 Electron 的许可、第三方许可清单', () => {
    const files = macZipFiles().map((f) => f.replace(/^[^/]+\.app\/Contents\/Resources\//, ''));
    for (const f of [
      'THIRD_PARTY_NOTICES.txt',
      'LICENSES.chromium.html',
      'LICENSE.electron.txt',
      `ffmpeg/${FFMPEG_TARGET}/ffmpeg`,
      `ffmpeg/${FFMPEG_TARGET}/LICENSE.txt`,
      `ffmpeg/${FFMPEG_TARGET}/build.json`,
    ])
      expect(files, f).toContain(f);
    expect(files.filter((path) => /ark[- ]pixel|\.bdf(?:\.gz)?$/i.test(path))).toEqual([]);
    // ffprobe 只给测试用
    expect(files.some((f) => /ffprobe/i.test(f))).toBe(false);
    const notices = readFileSync(join(resources(), 'THIRD_PARTY_NOTICES.txt'), 'utf8');
    expect(notices).toContain(brandMessages.en.disclaimer);
    expect(notices).toContain('LGPL-3.0-or-later');
    expect(notices).toContain(`Contents/Resources/ffmpeg/${FFMPEG_TARGET}/ffmpeg`);
    const license = readFileSync(join(resources(), 'ffmpeg', FFMPEG_TARGET, 'LICENSE.txt'), 'utf8');
    expect(license).toContain('GNU LESSER GENERAL PUBLIC LICENSE');
    expect(license).toContain('GNU GENERAL PUBLIC LICENSE');
    // libvpx 和 libopus 是 BSD：二进制分发时要附带许可原文
    expect(license.match(/Redistribution and use in source and binary forms/g)?.length).toBeGreaterThanOrEqual(2);
    const build = JSON.parse(readFileSync(join(resources(), 'ffmpeg', FFMPEG_TARGET, 'build.json'), 'utf8')) as { license: string; sources: { sha256: string }[] };
    expect(build.license).toBe('LGPL-3.0-or-later');
    expect(build.sources.map((s) => s.sha256)).toEqual(FFMPEG_MACOS.sources.map((s) => s.sha256));
  });

  it('随包的 FFmpeg 是 LGPL v3、没有 GPL 和 nonfree，只依赖系统库', () => {
    const ffmpeg = join(resources(), 'ffmpeg', FFMPEG_TARGET, 'ffmpeg');
    const version = run(ffmpeg, ['-hide_banner', '-version']).stdout;
    expect(version).not.toMatch(/--enable-(gpl|nonfree)/);
    expect(version).toContain('--enable-version3');
    const license = run(ffmpeg, ['-hide_banner', '-L']).stdout;
    expect(license).toMatch(/GNU Lesser General Public License/);
    expect(license).toMatch(/version 3/);
    const deps = run('otool', ['-L', ffmpeg])
      .stdout.split('\n')
      .slice(1)
      .map((l) => l.trim().split(' ')[0] ?? '')
      .filter(Boolean);
    expect(deps.length).toBeGreaterThan(0);
    expect(deps.filter((d) => !d.startsWith('/usr/lib/') && !d.startsWith('/System/Library/'))).toEqual([]);
  });

  it('只带运行时需要的东西：没有源码映射、没有测试夹具、没有 node_modules', () => {
    // Electron 框架自带的 .pak、.dylib 等不在此列；这里只看我们自己放进去的东西
    expect(macZipFiles().filter((f) => /\.map$|node_modules|tests\/fixtures|\.ts$/.test(f))).toEqual([]);
  });

  it('文件关联写进了 Info.plist；最低系统版本、asar 完整性都在', () => {
    const plist = macInfoPlist();
    const docs = plist.CFBundleDocumentTypes as { CFBundleTypeExtensions: string[]; CFBundleTypeName: string; CFBundleTypeRole: string }[];
    expect(docs.map((d) => [d.CFBundleTypeExtensions, d.CFBundleTypeName, d.CFBundleTypeRole])).toEqual([
      [['allay'], 'AllayMotion.Project', 'Editor'],
      [['allaytpl'], 'AllayMotion.Template', 'Editor'],
    ]);
    expect(plist.LSMinimumSystemVersion).toBe('12.0');
    expect(plist.ElectronAsarIntegrity).toHaveProperty(['Resources/app.asar']);
  });

  it('ad-hoc 签名完整有效（含随包的 FFmpeg），没有开 hardened runtime', () => {
    const app = macApp();
    const verify = run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
    expect(verify.status, verify.stderr).toBe(0);
    const info = run('codesign', ['-dv', '--verbose=4', app]);
    expect(info.stderr).toContain('Signature=adhoc');
    expect(info.stderr).not.toMatch(/flags=.*runtime/);
    const ff = run('codesign', ['--verify', '--strict', join(resources(), 'ffmpeg', FFMPEG_TARGET, 'ffmpeg')]);
    expect(ff.status, ff.stderr).toBe(0);
  });

  it('dmg 能通过校验；大小记一笔（不设上限）', () => {
    const dmg = releaseFile(DMG_PATTERN);
    const r = run('hdiutil', ['verify', dmg]);
    expect(r.status, r.stderr).toBe(0);
    const size = statSync(dmg).size;
    console.log(`dmg：${dmg}，${(size / 1024 / 1024).toFixed(1)} MiB（${size} 字节）；zip：${(statSync(releaseFile(MAC_ZIP_PATTERN)).size / 1024 / 1024).toFixed(1)} MiB`);
    expect(size).toBeGreaterThan(50 * 1024 * 1024);
  });
});
