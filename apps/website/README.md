# 官网（@allay/website）

项目的落地页，以及一个在浏览器里运行的仿真编辑器。构建产物是纯静态文件，可以放在任何静态托管上。

> 官网源码随主仓库维护，目前没有配置网站部署。下面“部署”一节是静态托管的操作说明；提交代码和合并 PR 不会发布网站。

## 它是怎么搭起来的

| 部分 | 位置 | 说明 |
|---|---|---|
| 落地页 | `index.html`、`src/site/` | React + Tailwind CSS 4，样式直接用 `packages/ui` 的设计变量、字体和组件 |
| 仿真器 | `simulator.html`、`src/simulator/` | 在落地页的 iframe 里懒加载；里面跑的是**桌面版渲染进程的真实代码**（`apps/desktop/src/renderer`） |
| 浏览器宿主 | `src/host/browser-host.ts` | `window.allay` 的浏览器实现，代替 Electron 的 preload 和主进程 |
| 原版贴图 | `public/mc/`、`src/host/mc-pack.ts` | 官网专用：`pnpm website:mc` 从本机正版游戏的 jar 里提取的方块、物品、界面贴图（见下文） |
| 演示素材 | `src/host/demo-pack.ts` | 没有提取原版贴图时，页面里现场生成的纯色色块 |
| 内置模板 | `build/plugins.ts` | 构建时用 `scripts/build-templates.ts` 的同一组函数把 `packages/templates/*` 打包 |
| 动效 | `src/site/motion/` | 全页共享的帧循环；全页一块 3D 方块世界（three，`motion/world/`）：背景方块随各节的机位飞、给正文让位，能拖、能像磁铁一样贴成一组；上面一层体素雕塑——首屏的体素悦灵（从应用那只 3D 悦灵的同一份模型和原版贴图精确生成，`public/mc/` 里没有原版悦灵贴图时不拼）、剪辑点 ◆、时间线；页尾字标由方块拼成；带路的悦灵。全页唯一的转场在 `src/site/components/CutScene.tsx`（应用的方块擦除模板，引擎实时渲染） |

哪些是真实代码、哪些是仿写、为什么，见 `docs/decisions.md` 的“官网”一节；第三版的概念（这一页就是一段正在剪辑的片子）和取舍见其中“第三版”。

## 原版贴图（只在官网）

用户在 2026-11-14 允许官网使用 Minecraft 的资源（对硬性规则 1 只针对官网的放宽，详见 `docs/decisions.md` 官网 · 原版素材）。边界：

- 只放在 `public/mc/`；桌面应用、`packages/*`、安装包、测试夹具里仍然没有任何 Mojang 文件。
- 只从本机已安装的正版游戏提取，不从网站下载：

  ```bash
  pnpm website:mc
  ```

  它复用应用自己的游戏探测和 jar 读取，取出方块目录、物品目录、界面贴图用到的贴图，路径与 jar 里相同，并写 `public/mc/index.json`（游戏版本、每个文件的 SHA-256）。本机没有游戏时什么也不写，官网退回生成的色块。
- 版权归 Mojang / Microsoft，不在本仓库 GPL-3.0 范围内（`public/mc/README.md`）。每个文件都登记在 `ASSETS_PROVENANCE.json`，`pnpm check:provenance` 按 manifest 核对内容没被改过。
- 不用 Minecraft 的 logo、字标、宣传图；页脚的非官方声明照旧。

## 开发

在仓库根目录：

```bash
pnpm install
```

```bash
pnpm website:dev
```

打开 <http://localhost:5180/>。改动官网、桌面版渲染进程、`packages/*` 的源码都会热更新（整页刷新）；改 `packages/templates/*` 的 manifest 或源码，模板会重新打包。

等价的写法是 `pnpm --filter @allay/website dev`。

## 构建与本地预览

```bash
pnpm website:build
```

产物在 `apps/website/dist/`：

- `index.html`、`simulator.html`、`theme-init.js`
- `assets/`：脚本、样式、字体（`@fontsource` 的自托管文件）、引擎 Worker
- `mc/`：官网专用的原版贴图（见上）

落地页的中文用系统黑体（苹方、微软雅黑……），Noto Sans SC 只在系统没有中文字体时才下载；仿真器里是应用自己的字体设置。原因和首屏下载量的对比见 `docs/decisions.md` 官网 · 验收返工。

```bash
pnpm website:preview
```

打开 <http://localhost:4180/>。

构建产物的每张页面都带一条内容安全策略：只允许同源资源和页面自己生成的 `blob:` / `data:`，所以页面不会向任何第三方发请求。所有资源地址都是相对路径（`base: './'`），放在子路径下也能用。

## 测试

```bash
pnpm test:website
```

先构建，再用 `vite preview` 起 4180 端口，在 Electron 自带的 Chromium 里跑冒烟测试 `tests/website/website.spec.ts`（T-WEB-1 至 T-WEB-19；T-WEB-18 是单元测试）。已包含在 `pnpm check` 里。

仿真器的地址带 `?e2e` 时会装上桌面版同一套测试钩子（`window.__allayTest`），测试用它读预览画布的像素。

## 官网怎么随应用自动更新

官网不复制应用的任何东西，而是在构建时直接引用当前提交里的源码：

- **界面**：仿真器启动的就是 `apps/desktop/src/renderer/main.tsx`。应用的界面、命令、导出对话框改了，下次构建的仿真器就是改过的样子。
- **模板**：首屏面板的模板按钮、仿真器的模板库都从 `packages/templates/*/manifest.json` 推出来；模板一节按 `showcaseEntries()` 的顺序精选展示前几个。加新模板，官网不改代码。
- **设计变量与组件**：`src/site/site.css` 导入 `@allay/ui/styles.css`；按钮、悦灵都是 `packages/ui`、`packages/mascot` 的组件。
- **文案**：产品名、字标、非官方声明只从 `packages/ui/src/brand` 取；导出格式的名字和说明用应用自己的 `export.*` 文案，格式清单来自 `EXPORT_PRESETS`。
- **引擎**：首屏预览和模板卡片用的是应用的 `EngineHost` 和封面服务。

所以只要在主程序更新后重新构建（或让 CI 在 `main` 更新时构建），官网就跟着变。桌面版通过 `window.allay` 新增或修改了宿主接口时，TypeScript 会在 `src/host/browser-host.ts` 报错，提醒补上浏览器实现。

## 部署（静态托管说明）

产物是纯静态文件，任何静态托管都行。下面两种只是做法说明；实际部署渠道和域名另行确定，目前未启用自动发布工作流。

### GitHub Pages

1. 仓库设置 → Pages → Source 选 “GitHub Actions”。
2. 加一个工作流：检出代码（不需要子模块）→ 安装 Node 24 和 pnpm → `pnpm install --frozen-lockfile` → `pnpm website:build` → 用 `actions/upload-pages-artifact` 上传 `apps/website/dist` → `actions/deploy-pages` 发布。
3. 站点地址是 `https://<用户名>.github.io/<仓库名>/`。产物用相对路径，不需要改 `base`。
4. 触发条件建议用 `push` 到 `main` 且路径包含 `apps/website/**`、`apps/desktop/src/renderer/**`、`apps/desktop/src/shared/**`、`packages/**`，这样应用改了官网也跟着重建。

### Cloudflare Pages

1. 新建 Pages 项目，连接仓库。
2. 构建命令：`pnpm install --frozen-lockfile && pnpm website:build`；输出目录：`apps/website/dist`；环境变量 `NODE_VERSION=24`。
3. 根目录保持仓库根（官网依赖整个工作区的源码）。

两种托管都只是把 `dist/` 原样发出去，不需要服务端逻辑。可以在托管的响应头里再加一遍与页面里相同的内容安全策略，以及 `X-Content-Type-Options: nosniff`。

## 约定

- Mojang 的文件只能放在 `public/mc/`，只能由 `pnpm website:mc` 从本机正版游戏提取；别处一律不放。新增二进制素材要登记 `ASSETS_PROVENANCE.json`。
- 不加统计、埋点和任何第三方在线资源。
- 不写死产品名和“悦灵”，用 `brand.*` 文案键和 `packages/mascot` 的组件。
- 界面文字两种语言都要有（`src/site/locales/`），T-WEB-4 会检查缺失的文案键。
