import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'electron-vite';
import { splashPages } from './src/splash/vite-plugin';

// 主进程和 preload 把依赖全部打进包里（externalizeDeps: false），
// 安装包里因此不需要 node_modules；sandbox 下的 preload 也必须是单文件 CJS。
export default defineConfig({
  main: {
    build: {
      externalizeDeps: false,
      outDir: 'out/main',
      rollupOptions: { input: { index: resolve(import.meta.dirname, 'src/main/index.ts') } },
    },
  },
  preload: {
    build: {
      externalizeDeps: false,
      isolatedEntries: true,
      outDir: 'out/preload',
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/preload/index.ts'),
          'code-inspector': resolve(import.meta.dirname, 'src/preload/code-inspector.ts'),
        },
        output: { format: 'cjs' },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/renderer'),
    // 启动画面的静态页面（docs/07-allay-mascot.md 7.6 C）随渲染进程一起构建
    plugins: [tailwindcss(), splashPages(resolve(import.meta.dirname, '../..'))],
    // 引擎 Worker 是 module worker（02-engine.md 2.2），three 体积大，需要 ES 格式才能分块
    worker: { format: 'es' },
    // 不用 @vitejs/plugin-react：它的 Fast Refresh 需要内联脚本，而 1.6 第 2 条的 CSP 不允许。
    // JSX 由 Vite 内置的转换按 tsconfig 的 react-jsx 处理；开发时改动走整页刷新。
    build: {
      outDir: 'out/renderer',
      // CSP 的 font-src 只允许 'self'，不要把字体等资源内联成 data: URI
      assetsInlineLimit: 0,
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/renderer/index.html'),
          'code-inspector': resolve(import.meta.dirname, 'src/renderer/code-inspector.html'),
        },
      },
    },
    server: { port: 5173, strictPort: true, host: 'localhost' },
  },
});
