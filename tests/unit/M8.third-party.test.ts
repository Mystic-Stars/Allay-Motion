import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { brandMessages } from '../../packages/ui/src/brand/messages';
import { installerScript, noticesText, nsisString } from '../../scripts/dist-extras';
import { FFMPEG_BUILD, FFMPEG_MACOS } from '../../scripts/ffmpeg-build';
import { collectThirdParty, entryAllowed, serialize, THIRD_PARTY_JSON, type ThirdPartyFile } from '../../scripts/third-party';

// M8 第三方许可清单（09-compliance.md 9.7–9.9）与安装程序欢迎页的声明（9.5）。

const committed = readFileSync(THIRD_PARTY_JSON, 'utf8').replace(/\r\n/g, '\n');
const file = JSON.parse(committed) as ThirdPartyFile;

describe('M8 第三方许可清单', () => {
  it('提交的清单与依赖一致（依赖变了要运行 pnpm licenses:gen）', () => {
    expect(serialize(collectThirdParty())).toBe(committed);
  }, 60_000);

  it('每一项的许可都在允许列表里；LGPL 只有以独立进程调用的 FFmpeg', () => {
    expect(file.entries.length).toBeGreaterThan(50);
    expect(file.entries.filter((e) => !entryAllowed(e)).map((e) => `${e.name} ${e.license}`)).toEqual([]);
    const lgpl = file.entries.filter((e) => /LGPL/.test(e.license));
    expect(lgpl.map((e) => e.name)).toEqual(['FFmpeg']);
  });

  it('许可原文都在，或者指向随包附带的文件', () => {
    expect(file.entries.some((entry) => entry.name === 'Ark Pixel Font')).toBe(false);
    const noText = file.entries.filter((e) => !e.text && !e.seeFile).map((e) => e.name);
    // 少数包里没有许可文件（package.json 声明了 MIT）；清单里照实写“包里没有许可文件”
    expect(noText.length).toBeLessThan(5);
    for (const name of ['FFmpeg', 'electron', 'three', 'react', 'tailwindcss']) expect(file.entries.some((e) => e.name === name)).toBe(true);
  });

  it('FFmpeg 的来源与 pnpm ffmpeg:fetch 固定的构建一致', () => {
    expect(file.ffmpeg).toEqual({ version: FFMPEG_BUILD.version, commit: FFMPEG_BUILD.commit, buildRepo: FFMPEG_BUILD.repo, buildTag: FFMPEG_BUILD.tag, asset: FFMPEG_BUILD.asset, sha256: FFMPEG_BUILD.sha256 });
    expect(FFMPEG_BUILD.asset).toContain(FFMPEG_BUILD.version);
    expect(FFMPEG_BUILD.version.endsWith(`g${FFMPEG_BUILD.commit}`)).toBe(true);
  });

  it('macOS 的 FFmpeg 来源与 scripts/ffmpeg-build.ts 的 FFMPEG_MACOS 一致', () => {
    expect(file.ffmpegMacos.version).toBe(FFMPEG_MACOS.version);
    expect(file.ffmpegMacos.license).toBe('LGPL-3.0-or-later');
    expect(file.ffmpegMacos.sources).toEqual(FFMPEG_MACOS.sources.map(({ name, version, url, sha256, license }) => ({ name, version, url, sha256, license })));
  });

  it('纯文本版带声明、FFmpeg 的源码去处和每一项', () => {
    const text = noticesText(file);
    expect(text).toContain(brandMessages.en.disclaimer);
    expect(text).toContain(`commit ${FFMPEG_BUILD.commit}`);
    expect(text).toContain('resources/ffmpeg/win32-x64/ffmpeg.exe');
    for (const e of file.entries) expect(text).toContain(`${e.name} ${e.version} — ${e.license}`);
  });

  it('macOS 的纯文本版写的是本项目编译的那一份：每个源码包的地址和 SHA-256、许可全文的位置', () => {
    for (const target of ['darwin-arm64', 'darwin-x64'] as const) {
      const text = noticesText(file, target);
      expect(text).toContain(brandMessages.en.disclaimer);
      expect(text).not.toContain('win32-x64');
      expect(text).toContain(`Contents/Resources/ffmpeg/${target}/LICENSE.txt`);
      for (const s of FFMPEG_MACOS.sources) expect(text).toContain(`${s.url} (SHA-256 ${s.sha256})`);
      for (const e of file.entries) expect(text).toContain(`${e.name} ${e.version} — ${e.license}`);
    }
  });
});

describe('M8 安装程序欢迎页（9.5）', () => {
  it('NSIS 字符串转义', () => {
    expect(nsisString('a$b"c\nd')).toBe('a$$b$\\"c$\\r$\\nd');
  });
  it('欢迎页带完整的非官方声明（中英文），产品名来自品牌目录', () => {
    const nsh = installerScript();
    expect(nsh.charCodeAt(0)).toBe(0xfeff);
    expect(nsh).toContain('!macro customWelcomePage');
    expect(nsh).toContain('!insertmacro MUI_PAGE_WELCOME');
    expect(nsh).toContain(nsisString(brandMessages['zh-CN'].disclaimer));
    expect(nsh).toContain(brandMessages.en.name);
    // 转义之后不该再有裸的双引号（只有包住两个字符串的那几对）
    const body = nsh.split('\r\n').filter((l) => l.includes('!define'));
    for (const l of body) expect(l.replace(/\$\\"/g, '').match(/"/g)).toHaveLength(2);
  });
});
