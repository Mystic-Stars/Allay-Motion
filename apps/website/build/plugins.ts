// 官网构建用的 Vite 插件。
//
// 1. virtual:allay-builtin-templates：用 pnpm templates:build 同一份打包函数（esbuild + 导入检查 + 确定性规则）
//    现场把 packages/templates/* 打成单文件 ESM，连同 manifest 一起交给页面。packages/templates 下多一个模板，
//    官网就多一个，不用改官网代码（tests/engine/vite.config.ts 用的是同一个办法）。
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import { GENERATED_FILES } from '../../../packages/mascot/src/atlas';
import { bundleTemplate, readTemplateManifest, templateDirs } from '../../../scripts/build-templates';

const VIRTUAL = 'virtual:allay-builtin-templates';
const ROOT = resolve(import.meta.dirname, '../../..');

export function builtinTemplates(): Plugin {
  return {
    name: 'allay-website-builtin-templates',
    resolveId: (id) => (id === VIRTUAL ? `\0${VIRTUAL}` : null),
    async load(id) {
      if (id !== `\0${VIRTUAL}`) return null;
      const out: { manifest: unknown; code: string }[] = [];
      for (const dir of templateDirs()) {
        const manifest = readTemplateManifest(dir);
        this.addWatchFile(resolve(dir, 'manifest.json'));
        this.addWatchFile(resolve(dir, 'src/index.ts'));
        out.push({ manifest, code: await bundleTemplate(dir) });
      }
      return `export default ${JSON.stringify(out)};`;
    },
  };
}

const MC_VIRTUAL = 'virtual:allay-website-mc';
const MC_INDEX = resolve(import.meta.dirname, '../public/mc/index.json');

/**
 * virtual:allay-website-mc：public/mc/ 里有哪些原版贴图（pnpm website:mc 提取的，docs/decisions.md 官网 · 原版素材）。
 * 页面据此决定读真实贴图还是用生成的色块，不用试探着请求（免得静态托管上出现 404）。没有提取时是 null。
 */
export function websiteMc(): Plugin {
  return {
    name: 'allay-website-mc',
    resolveId: (id) => (id === MC_VIRTUAL ? `\0${MC_VIRTUAL}` : null),
    load(id) {
      if (id !== `\0${MC_VIRTUAL}`) return null;
      if (!existsSync(MC_INDEX)) return 'export default null;';
      this.addWatchFile(MC_INDEX);
      const index = JSON.parse(readFileSync(MC_INDEX, 'utf8')) as { gameVersion: string; files: { path: string }[] };
      return `export default ${JSON.stringify({ gameVersion: index.gameVersion, files: index.files.map((f) => f.path) })};`;
    },
  };
}

/**
 * 应用里那只 3D 悦灵：用 pnpm mascot:bake 烘焙出的同一份图集和头像（packages/mascot/generated/，git 忽略，M5a）。
 * 和桌面版一样放在页面同源的 mascot/ 下（packages/mascot 的组件从 mascot/allay.atlas.json 读），
 * 构建时复制进产物，开发服务器上直接提供。产物是原版贴图的派生图像：官网可以用（docs/decisions.md 官网 · 原版素材）。
 * 缺产物时构建照常完成但打印醒目的警告（组件会退回 CSS 占位，官网上看得出来）。
 */
const MASCOT_GENERATED = resolve(ROOT, 'packages/mascot/generated');
/** 图集、atlas.json、头像，加两张应用图标（标签页图标和高分屏图标用；.ico 和其余尺寸不需要） */
export const MASCOT_FILES: readonly string[] = GENERATED_FILES.filter((f) => !f.startsWith('icon') || f === 'icon-32.png' || f === 'icon-256.png');

export function mascotAssets(): Plugin {
  return {
    name: 'allay-website-mascot',
    buildStart() {
      const missing = MASCOT_FILES.filter((f) => !existsSync(resolve(MASCOT_GENERATED, f)));
      if (missing.length > 0) {
        this.warn(`悦灵的烘焙产物缺 ${missing.length} 个文件（${missing.slice(0, 3).join('、')}…）：官网会退回 CSS 占位。先运行 pnpm mascot:bake（需要本机装有 Minecraft Java 版）。`);
      }
    },
    generateBundle() {
      for (const f of MASCOT_FILES) {
        const p = resolve(MASCOT_GENERATED, f);
        if (existsSync(p)) this.emitFile({ type: 'asset', fileName: `mascot/${f}`, source: readFileSync(p) });
      }
    },
    // 有应用图标就用它做标签页图标（页面里原来是空的 data: 图标，免得请求 favicon.ico 得到 404）
    transformIndexHtml(html) {
      if (!existsSync(resolve(MASCOT_GENERATED, 'icon-32.png'))) return html;
      return html.replace(
        '<link rel="icon" href="data:," />',
        ['<link rel="icon" type="image/png" href="./mascot/icon-32.png" />', '<link rel="apple-touch-icon" href="./mascot/icon-256.png" />'].join('\n    '),
      );
    },
    configureServer(server) {
      server.middlewares.use('/mascot/', (req, res, next) => {
        const name = decodeURIComponent((req.url ?? '').split('?')[0]!.replace(/^\//, ''));
        // 只认白名单里的文件名（扁平目录，没有路径）
        if (!MASCOT_FILES.includes(name) || !existsSync(resolve(MASCOT_GENERATED, name))) return next();
        res.setHeader('content-type', name.endsWith('.json') ? 'application/json' : 'image/png');
        res.end(readFileSync(resolve(MASCOT_GENERATED, name)));
      });
    },
  };
}

/**
 * 构建产物的每张页面带一条内容安全策略：只允许同源和页面自己生成的 blob:/data:。
 * 这保证官网不会向任何第三方发请求（字体、脚本、图片都自托管），模板的 blob: 装载照常可用。
 * 只在构建时加：开发服务器的热更新要连 WebSocket。
 */
export const SITE_CSP = [
  "default-src 'self'",
  "script-src 'self' blob:",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'self' blob: data:",
  "media-src 'self' blob:",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

/**
 * 首屏要用的西文字体（IBM Plex 的 latin 子集，每个十几 KB）在 index.html 里预加载，标题不用等 CSS 解析完才去取字体。
 * 文件名带哈希，只能在打包完以后从产物里找。
 */
const PRELOAD_FONTS = [/ibm-plex-sans-latin-400-normal-[\w-]+\.woff2$/, /ibm-plex-sans-latin-600-normal-[\w-]+\.woff2$/, /ibm-plex-mono-latin-500-normal-[\w-]+\.woff2$/];

export function preloadFonts(): Plugin {
  return {
    name: 'allay-website-preload-fonts',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        if (!ctx.bundle || !ctx.filename.endsWith('index.html')) return [];
        const files = Object.keys(ctx.bundle);
        return PRELOAD_FONTS.flatMap((re) => files.filter((f) => re.test(f)).slice(0, 1)).map((f) => ({
          tag: 'link',
          attrs: { rel: 'preload', as: 'font', type: 'font/woff2', crossorigin: '', href: `./${f}` },
          injectTo: 'head' as const,
        }));
      },
    },
  };
}

export function contentSecurityPolicy(): Plugin {
  return {
    name: 'allay-website-csp',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: SITE_CSP }, injectTo: 'head-prepend' }],
  };
}
