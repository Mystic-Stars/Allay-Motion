// pnpm website:mc：从本机已安装的正版 Minecraft Java 版客户端 jar 里取出官网要用的原版贴图，
// 放进 apps/website/public/mc/（docs/decisions.md 官网 · 原版素材）。
//
// 这是硬性规则 1 的一处只对官网生效的放宽（用户 2026-11-14 批准）：桌面应用、packages/*、安装包、测试夹具不变。
// - 只从本机游戏目录读（复用应用的 detectMinecraft / openVanillaLayer，只读，不联网）；不从任何网站下载。
// - 只取方块目录、物品目录、界面贴图引用到的贴图（requiredTextures()）及其 .mcmeta，路径与 jar 里的原始路径相同；
//   另取 WEBSITE_EXTRA_FILES 里的三个文件：悦灵的实体贴图，只给官网首屏的体素悦灵取色（用户 2026-11-14 批准，原话「我允许」）；
//   下界传送门的动画贴图及其 .mcmeta，只给官网的“传送门穿越”模板用（维护者 khiqwq 2026-11-24 在 PR #16 评论中确认）。
//   其他实体贴图、模型、音效、字体都不取。
// - 写一份 index.json（游戏版本、每个文件的原始路径、SHA-256、字节数），check-provenance 据此核对文件没被改过。
// - 产物是确定的：同一个 jar 产出逐字节相同的文件。
// 用法：pnpm website:mc [游戏目录]
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { requiredTextures, textureMetaPath } from '../packages/assets/src/index';
import { detectMinecraft, openVanillaLayer } from '../apps/desktop/src/main/resources';

const ROOT = resolve(import.meta.dirname, '..');
export const WEBSITE_MC_DIR = join(ROOT, 'apps/website/public/mc');

/** 目录以外单独加的文件：悦灵的原版贴图（官网首屏的体素悦灵逐像素取色用，应用烘焙图集用的也是这一张）；下界传送门的动画贴图（官网的传送门模板用） */
export const WEBSITE_EXTRA_FILES: readonly string[] = [
  'assets/minecraft/textures/entity/allay/allay.png',
  'assets/minecraft/textures/block/nether_portal.png',
  'assets/minecraft/textures/block/nether_portal.png.mcmeta',
];

export interface McIndex {
  formatVersion: 1;
  gameVersion: string;
  releaseTime: string;
  /** 相对游戏目录的 jar 路径 */
  extractedFrom: string;
  files: { path: string; sha256: string; bytes: number }[];
}

const README = `# Minecraft 原版素材（仅用于官网展示）

这个目录里 \`assets/minecraft/\` 下的文件取自 Minecraft Java 版客户端 jar（版本见 \`index.json\`），
路径与 jar 里的原始路径相同，内容未做任何修改。

- 版权归 Mojang Studios / Microsoft 所有。
- **不在**本仓库 GPL-3.0 许可的范围内，不随本项目的代码一起授权。
- 只用于官网的仿真器和模板展示，以及首屏体素悦灵的取色（悦灵贴图）和传送门模板（下界传送门贴图）；桌面应用和安装包里**没有**这些文件。
- 由 \`pnpm website:mc\` 从本机已安装的正版游戏里提取，没有从任何网站下载。

NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.

本软件不是 Minecraft 官方产品，未经 Mojang 或 Microsoft 批准，也与它们无关。
`;

export async function extractWebsiteMc(outDir: string, gameDir: string | null): Promise<McIndex | null> {
  const install = await detectMinecraft({ platform: process.platform, appData: process.env.APPDATA, home: homedir() }, gameDir);
  if (!install) return null;
  const layer = await openVanillaLayer(install);
  try {
    const paths = new Set<string>();
    for (const r of requiredTextures()) {
      const p = r.anyOf.find((x) => layer.has(x));
      if (!p) continue;
      paths.add(p);
      const meta = textureMetaPath(p);
      if (layer.has(meta)) paths.add(meta);
    }
    for (const p of WEBSITE_EXTRA_FILES) if (layer.has(p)) paths.add(p);
    rmSync(join(outDir, 'assets'), { recursive: true, force: true });
    const files: McIndex['files'] = [];
    for (const p of [...paths].sort()) {
      const bytes = await layer.read(p);
      if (!bytes) continue;
      const dest = join(outDir, p);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, bytes);
      files.push({ path: p, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.byteLength });
    }
    const index: McIndex = {
      formatVersion: 1,
      gameVersion: install.versionId,
      releaseTime: install.releaseTime,
      extractedFrom: `versions/${install.versionId}/${install.versionId}.jar`,
      files,
    };
    writeFileSync(join(outDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
    writeFileSync(join(outDir, 'README.md'), README);
    return index;
  } finally {
    layer.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const index = await extractWebsiteMc(WEBSITE_MC_DIR, process.argv[2] ?? null);
  if (!index) {
    console.log('website:mc：本机没有找到带 jar 的 Minecraft Java 版正式版，没有提取任何文件（官网会用页面里生成的纯色色块）');
  } else {
    const total = index.files.reduce((n, f) => n + f.bytes, 0);
    console.log(`website:mc：${index.gameVersion}，${index.files.length} 个文件，${(total / 1024).toFixed(1)} KB → apps/website/public/mc/`);
  }
}
