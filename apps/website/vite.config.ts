import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { builtinTemplates, contentSecurityPolicy, mascotAssets, preloadFonts, websiteMc } from './build/plugins';

const here = import.meta.dirname;

// 官网：两张页面。index.html 是落地页；simulator.html 是仿真器，在落地页的 iframe 里懒加载，
// 里面挂的是桌面版渲染进程的真实代码（apps/desktop/src/renderer），只把 window.allay 换成浏览器实现。
// base 用相对路径，产物可以放在任何子路径下静态托管（GitHub Pages 的 /<仓库名>/ 也行）。
export default defineConfig({
  root: here,
  base: './',
  plugins: [tailwindcss(), builtinTemplates(), websiteMc(), mascotAssets(), preloadFonts(), contentSecurityPolicy()],
  // 引擎 Worker 是 module worker（docs/02-engine.md 2.2）
  worker: { format: 'es' },
  // 渲染进程的源码在 apps/desktop 下，它的依赖从那边的 node_modules 解析；这些包必须全页面只有一份
  resolve: {
    dedupe: ['react', 'react-dom', 'i18next', 'react-i18next', 'zustand', 'zod', 'comlink', 'three', '@base-ui/react', 'motion', '@phosphor-icons/react', 'sonner'],
  },
  build: {
    outDir: resolve(here, 'dist'),
    emptyOutDir: true,
    target: 'es2023',
    // 字体等资源保持独立文件，不内联成 data:
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      input: { index: resolve(here, 'index.html'), simulator: resolve(here, 'simulator.html') },
      // Base UI 的 'use client' 指令对纯客户端页面没有意义
      onwarn(warning, warn) {
        if (warning.code === 'MODULE_LEVEL_DIRECTIVE') return;
        warn(warning);
      },
    },
  },
  server: { port: 5180, strictPort: true, host: 'localhost', fs: { allow: [resolve(here, '../..')] } },
  preview: { port: 4180, strictPort: true, host: 'localhost' },
});
