# 01 产品与架构

## 1.1 产品定义

Allay Motion（悦灵动画）是一个桌面应用，给 Minecraft 视频创作者做 YouTube 风格的转场和小动画。

用法：选一个模板，调参数，实时预览，导出一个带透明通道的短片，拖进剪辑软件，盖在两段素材的接缝上。

要达到的体验：

1. 从打开应用到导出第一个转场，不超过 30 秒，不需要读任何说明。
2. 每个参数的变化都立刻出现在预览里。
3. 导出的每一帧都和预览里看到的一样。
4. 没装游戏也能用；装了游戏、加了资源包，画面跟着变。

## 1.2 范围

**v1 做**

- 保留原六个内置模板（`04-templates.md` 4.10），另有工作台的玩家动作与镜头、素材对象模块。
- 由参数定义自动生成的属性面板；预设；派生模板；模板包的导入导出；脚本模板。
- 动画工作台：最长 5 分钟的多轨合成，可排列和裁切模板与本机素材片段、编辑片段变换关键帧。模板仍只用代码编写，预览和导出均走原引擎 Worker。
- 三层资源栈：自制内置素材、本机原版素材、用户资源包。
- 用户资源包支持本地普通、未加密的基岩版资源包子集；玩家皮肤可从本机导入 PNG，或逐次同意后按 Java 正版玩家名从官方服务获取公开皮肤（`09-compliance.md` 9.10）。
- 导出：透明 MOV、PNG 序列、透明 WebM、绿幕 MP4；运动模糊；音效。
- 悦灵的加载与反馈系统。
- 中文和英文；深色和浅色主题。
- Windows x64 安装包。
- 自动更新：从本仓库 GitHub / GitCode 的 Release 检查并下载新版本，可在设置里关闭（仓库所有者于 2026-11-14 要求加入，`docs/decisions.md`“自动更新”）。

**v1 不做**

| 不做 | 原因 |
|---|---|
| 可视化模板编辑器 | 工作台的多轨时间轴和片段变换关键帧不用于编写模板逻辑；模板仍为纯代码 |
| 导入用户的视频并对画面本身做变形 | 需要视频解码和合成。v1 只输出盖在上面的叠加层 |
| 账号、云同步、在线模板市场、遥测 | v1 默认离线；主进程的限定联网例外见 `09-compliance.md` 9.10 |
| Linux 安装包 | 代码保持可移植，但 v1 只在 Windows 和 macOS 上构建。macOS 的 dmg、zip 由仓库所有者于 2026-11-14 要求加入（`docs/decisions.md`“macOS 构建”），原来这一行写的是“macOS、Linux 安装包” |
| 加密基岩资源包、基岩在线查名与自定义皮肤模型；1.12 及更早的 Java 版资源包 | 仅适配本地普通基岩资源包的受支持素材；官方皮肤查名仅限 Java |
| 读取资源包自带的模型 JSON | v1 用应用自带的方块目录 |

## 1.3 技术栈

版本是 2026-11 查到的最新大版本。安装时取当时的最新稳定版并用 lockfile 锁定；如果大版本已经和下表不同，先读迁移说明。

| 层 | 选择 | 说明 |
|---|---|---|
| 应用壳 | Electron 45 | 自带固定版本的 Chromium，所有用户是同一个渲染内核 |
| 构建 | electron-vite 6、Vite 8、electron-builder 26 | |
| 语言 | TypeScript（严格模式） | 引擎、界面、模板同一门语言 |
| 界面框架 | React 19 | |
| 样式 | Tailwind CSS 4 | 设计变量见 `06-ui-design.md` |
| 组件 | shadcn/ui，`shadcn init -b base` | 底层用 Base UI（`@base-ui/react`），组件源码在仓库里 |
| 渲染 | Three.js r187，`WebGLRenderer`（WebGL2） | 场景很轻，不需要 WebGPU。如果届时 `WebGLRenderer` 已被标为弃用，改用新渲染器的 WebGL2 后端，帧管线的语义不变 |
| 状态 | Zustand 5，撤销用 zundo | |
| 校验 | Zod 4 | manifest、参数、IPC 入参 |
| 线程通信 | Comlink | 主线程与引擎 Worker |
| 压缩包读取 | yauzl | 主进程读 zip 和 jar |
| 视频编码 | FFmpeg，独立进程 | 见 `05-export.md` |
| 音频 | Web Audio | 预览实时播放，导出离线混音 |
| 多语言 | i18next、react-i18next | |
| 界面辅助库 | react-resizable-panels、cmdk、Sonner、react-colorful、TanStack Virtual、dnd-kit、Motion、Lucide | |
| 模板工具 | esbuild（打包内置模板）、es-module-lexer（检查导入） | |
| 测试 | Vitest 5、Playwright 1.65 | |
| 包管理 | pnpm workspace | |

Three.js 的类名和选项以当时的文档为准。本规格用到的概念是：实例化网格、带多重采样的渲染目标、半浮点渲染目标、色彩管理、自定义着色器的全屏通道。

关键帧和缓动自己实现，不引入动画库（原因见 `09-compliance.md` 9.8）。

## 1.4 仓库结构

```
apps/desktop/
  src/main/            主进程：窗口、协议、IPC、资源层的 Node 实现、工程文件、导出任务
  src/preload/         用 contextBridge 暴露 window.allay
  src/renderer/        React 应用
    app/               布局与顶层组件
    features/          gallery、preview、params、transport、export、resources、settings
    stores/            Zustand
    engine-host/       创建 Worker、Comlink 封装、看门狗、资源回调
    audio/             cue 调度与离线混音
    i18n/
  src/splash/          启动画面（静态 HTML 和 CSS）
packages/
  engine/              渲染引擎（Worker 入口和库）
  template-sdk/        模板类型、manifest 与参数的 schema 和校验
  templates/           内置模板，每个一个目录
  assets/              资源栈的纯逻辑、方块与物品目录、名称表
  mascot/              悦灵的模型、烘焙、图集、组件
  ui/                  设计变量、shadcn 组件、编辑器控件、品牌
resources/
  builtin-pack/        自制内置素材（生成后提交）
  templates/           构建产物：内置模板包（不提交）
  ffmpeg/              构建时下载（不提交）
scripts/               生成、构建、检查脚本
tests/
  fixtures/            脚本生成的假资源包、假游戏目录、测试模板
  e2e/
docs/
```

**依赖方向**（用 lint 规则强制）：

| 包 | 可以依赖 | 不可以依赖 |
|---|---|---|
| `template-sdk` | zod；`three` 仅限类型 | 其他一切 |
| `assets` | zod | React、Electron、Node、`three` 的运行时 |
| `engine` | `three`、`template-sdk`、`assets` | React、Electron、Node、DOM |
| `templates/*` | `template-sdk`（仅类型） | 其他一切，包括 `three` 的运行时 |
| `ui` | React、Base UI 等界面库 | `engine`、Electron、Node |
| `mascot` | React、`ui`、`template-sdk`（仅类型） | `engine` 的内部、Electron、Node |
| 渲染进程 | 以上全部 | Electron、Node（只能通过 `window.allay`） |
| 主进程 | Node、Electron、`assets`、`template-sdk` | React、`engine` |

## 1.5 进程与线程

```
主进程 ───────── IPC（经 preload 的 window.allay）───────── 渲染进程主线程（React 界面）
 ├ 窗口、对话框、文件关联                                     ├ 预览引擎 Worker（常驻，画到预览画布）
 ├ 资源层：内置目录、zip、文件夹、游戏 jar                    ├ 导出引擎 Worker（导出时创建）
 ├ 工程、预设、模板、设置的读写                               ├ 杂务引擎 Worker（缩略图、模板试运行）
 └ FFmpeg 子进程（stdin 接收原始帧）                          └ Web Audio（预览播放、离线混音）
```

- 模板代码只在引擎 Worker 里运行。
- 贴图等资源由主线程向主进程要，再交给 Worker。Worker 自己不能读任何东西。
- 导出的像素从 Worker 零拷贝传到主线程，再经 IPC 到主进程，写进 FFmpeg 的 stdin。
- 窗口设 `backgroundThrottling: false`，保证最小化时导出照常进行。

## 1.6 安全基线

用户会导入别人写的模板脚本，所以下面每一条都是硬性要求，任何一条都不许为了方便而放宽。

1. 窗口的 `webPreferences`：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`、`nodeIntegrationInWorker: false`、`nodeIntegrationInSubFrames: false`、`webSecurity: true`。
2. 渲染进程的页面由自定义协议 `app://` 提供（注册为 standard、secure），每个响应都带同一份内容安全策略：
   `default-src 'none'; script-src 'self' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; font-src 'self'; connect-src 'self'`。
   开发模式额外放行本机的开发服务器。
3. **会话级网络拦截**：`session.webRequest.onBeforeRequest` 取消一切不是 `app:`、`blob:`、`data:`、`devtools:`（以及开发模式下本机开发服务器）的请求。这是模板脚本无法外传数据的真正保证。
4. 拒绝一切新窗口（`setWindowOpenHandler`）、一切页面跳转（`will-navigate`）、一切权限请求。
5. preload 只暴露一个有类型的 `window.allay`。主进程的每个 IPC 处理函数都用 zod 校验入参，并确认调用来自主窗口的主框架。
6. **渲染进程不能让主进程读写任意路径。** 路径只有三个来源：主进程自己弹出的文件对话框；拖放的文件（preload 里用 `webUtils.getPathForFile` 取路径，暴露给页面的函数只接收 `File` 对象）；应用数据目录下的固定位置。
7. 引擎 Worker 拿不到 `window.allay`，并在装载模板前删掉联网和存储相关的全局对象（`02-engine.md` 2.4）。
8. 打包时设置 Electron fuses：关闭 `RunAsNode` 和 `EnableNodeOptionsEnvironmentVariable`、`EnableNodeCliInspectArguments`，开启 `OnlyLoadAppFromAsar` 和 asar 完整性校验。
9. 解压任何 zip 都要防路径穿越和解压炸弹（`03-assets.md` 3.5、`04-templates.md` 4.8）。
10. 应用不在网页存储（IndexedDB、localStorage）里放任何重要数据；设置和工程都由主进程写成文件。

模板脚本在这套边界内最坏能做到的事：白白消耗 CPU 和显卡，或者画出一帧垃圾。看门狗会终止它。

## 1.7 状态与撤销

| Store | 内容 | 可撤销 |
|---|---|---|
| `projectStore` | 当前模板、参数、输出设置、工程名、是否有未保存改动 | 是 |
| `transportStore` | 当前时间、是否播放、是否循环、时长、剪辑点 | 否 |
| `resourceStore` | 资源栈各层、`resourceStamp` | 否 |
| `exportStore` | 导出任务的状态和进度 | 否 |
| `uiStore` | 面板宽度、折叠状态、主题、语言 | 否 |

- 撤销用 zundo，只记录 `projectStore` 里的模板和参数。
- 一次连续操作（拖滑块、拖数字、拖时间轴上的分界线）只算一步：指针按下时暂停记录，松开时提交一条。
- 参数变化的流向：控件 → `projectStore` →（每个动画帧最多一次）→ `engine.setParams` → 用返回的时长、剪辑点、音频 cue 更新 `transportStore` → 重画当前时间。

## 1.8 IPC 接口

`window.allay` 按命名空间组织，全部返回 Promise；事件用 `onXxx(callback)` 订阅，返回取消函数。

| 命名空间 | 方法 |
|---|---|
| `app` | `info`（版本、平台、数据目录）、`onOpenFile`（双击关联文件时） |
| `project` | `create`、`open`、`openRecent`、`save`、`saveAs`、`recents` |
| `templates` | `list`、`read`（manifest 和代码）、`readAsset`、`install`、`installDropped(file)`、`remove`、`exportPackage` |
| `presets` | `list`、`save`、`remove`、`importFile`、`exportFile` |
| `resources` | `layers`、`stamp`、`read(path)`、`list(prefix)`、`detectMinecraft`、`setVanilla`、`addPack`、`addDroppedPack(file)`、`removeLayer`、`reorder`、`setEnabled`、`onChanged` |
| `files` | `pickImage`、`read(ref)`（用户为 `texture` 参数选的图片） |
| `export` | `start`、`writeFrame`、`writeAudio`、`finish`、`cancel`、`probeEncoders`、`ffmpegInfo` |
| `cache` | `getThumb`、`putThumb`、`clear`、`usage` |
| `settings` | `get`、`set`、`onChanged` |
| `shell` | `showItemInFolder`、`openLink(key)`（只能打开应用内置白名单里的链接） |
| `window` | `setTitleBarColors` |
| `updates` | `state`、`check`、`download`、`cancel`、`install`、`onChanged`（自动更新，`docs/decisions.md`“自动更新”） |

## 1.9 数据目录与工程文件

应用数据目录（`app.getPath('userData')`）：

```
settings.json          设置，包括资源栈的配置和上次选的游戏目录
presets/               预设
templates/<id>/<版本>/  用户安装的模板
packs/                 用户添加的资源包（zip 按内容哈希命名）
cache/thumbs/          缩略图和模板封面，可随时清空
logs/
```

- 资源栈是**应用级**的设置，不随工程保存。
- 所有 JSON 文件都带 `formatVersion`，写入采用“先写临时文件再改名”。

工程文件 `.allay`（JSON）：

```json
{
  "formatVersion": 1,
  "appVersion": "0.1.0",
  "name": "未命名工程",
  "template": { "id": "allay.builtin.block-wipe", "version": "1.0.0" },
  "params": { "cols": 16, "inPattern": "centerOut" },
  "output": { "width": 1920, "height": 1080, "fps": 60 },
  "export": { "preset": "prores4444", "quality": "standard", "shutterAngle": 180 },
  "preview": { "background": "checker" },
  "files": { "logo": "D:/Videos/logo.png" },
  "resourceHint": ["vanilla", "pack:Faithful 32x"]
}
```

- `params` 只存与默认值不同的项。
- `files` 记录 `texture` 参数里 `file:` 引用对应的本机路径；文件丢失时该参数回到默认值并提示。
- `resourceHint` 只是记一笔保存时启用了哪些层。打开工程时如果当前资源栈不同，提示一次，不自动改动资源栈。
- 引用的模板没有安装时，工程打不开，并说明缺哪个模板。

## 1.10 工具链与命令

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 启动开发模式的应用 |
| `pnpm typecheck` / `pnpm lint` | 类型检查 / 代码与依赖方向检查 |
| `pnpm test` | 单元测试（Vitest） |
| `pnpm test:engine` | 引擎和模板的渲染测试（在真实 Chromium 里跑 WebGL） |
| `pnpm test:export` | 导出的编码与回读测试（需要 FFmpeg） |
| `pnpm test:e2e` | Playwright 驱动 Electron 的端到端测试 |
| `pnpm check` | 以上全部，加来源登记检查和许可检查 |
| `pnpm assets:gen` | 重新生成内置素材 |
| `pnpm templates:build` | 打包内置模板 |
| `pnpm mascot:bake` | 烘焙悦灵图集和图标 |
| `pnpm ffmpeg:fetch` | 下载并校验固定版本的 FFmpeg |
| `pnpm dist` | 生成 Windows 安装包 |

- TypeScript 严格模式，不用 `any`；跨进程和跨线程的边界都有 schema。
- CI（Windows）跑 `pnpm check` 和 `pnpm dist`。CI 上的 WebGL 是软件渲染，基准图比较按 `04-templates.md` 4.11 放宽。
- 找不到 WebGL2 时，应用显示一个说明页（显卡或驱动不支持）并附诊断信息，不白屏。

## 1.11 验收测试

| 编号 | 内容 | 判定 |
|---|---|---|
| T-ARC-1 | 依赖方向：正常代码通过 lint；一个故意违规的夹具文件（引擎里导入 React） | 前者通过，后者被拦下 |
| T-ARC-2 | 渲染进程里检查 `require`、`process`；打包后检查 fuses | 都不存在；fuses 与 1.6 一致 |
| T-ARC-3 | 从渲染进程主线程和引擎 Worker 各发起一次对外部地址的请求 | 都失败；主进程日志里有拦截记录 |
| T-ARC-4 | 一个测试模板尝试访问 `window`、`self.allay`、`fetch`、`indexedDB`、动态 `import()` | 全部不可用或被拒绝 |
| T-ARC-5 | 一个在 `update` 里死循环的测试模板 | 看门狗在时限内终止并重建 Worker；期间界面主线程没有超过 100 ms 的卡顿；界面给出“模板无响应” |
| T-ARC-6 | 向每个 IPC 方法发畸形参数；请求读取对话框没有授权过的路径 | 全部被拒绝，主进程不崩溃 |
| T-ARC-7 | 打包后的应用在参考机器上冷启动 | 启动画面 0.5 秒内出现；3 秒内主界面可交互 |
