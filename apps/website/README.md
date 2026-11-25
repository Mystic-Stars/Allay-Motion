# `@allay/website`（项目官网）

纯静态双入口构建产物（落地页 `index.html` + 1:1 真实桌面编辑器试玩宿主 `simulator.html`），以**「整页就是一条正在剪辑的时间轴」**为核心叙事，同时把网页内置展示模板固定冻结为 8 个精选代表作（`SHOWCASE_TEMPLATE_IDS`），不再随主程序新增模板而持续膨胀。

## 核心设计架构

- **剪辑轨道时间轴顶栏 + View Transitions 光圈切换（`Nav.tsx`）**：按各节高度比例展示阶段色片段轨、琥珀色剪辑点 `◆`、阻尼弹簧播放头与 `60 fps` 实时时间码；点击主题按钮时通过 `document.startViewTransition` 从点击坐标展开圆形光圈擦除过渡。
- **全页共用的 3D 体素悦灵与磁吸方块世界（`src/site/motion/world/`）**：
  - 首屏由 11,640 颗体素精确拼出与应用一致的 3D 悦灵雕塑（指针拨动、空白处冲击波、按住旋转），并在剪辑点与开源节重组成 `◆` 和三轨时间线；
  - 背景悬浮方块支持单击敲碎，以及按住拖动靠近另一块时磁吸贴合成组；
  - 页尾巨幅 `Allay Motion` 字标由方块按列飞入拼成；
  - 检测到软件光栅化（CI WARP / SwiftShader）时自动切入 `software` 轻量档位并跳过离屏景深模糊，确保在无硬件加速环境下快速落定。
- **首屏一体式电影舞台 + 三步分镜（`Stage.tsx`）**：
  - 首屏带指针跟随的悦灵生物发光体积光晕（`.hero-aura`）与 3D 透视非编网格地平线（`.hero-horizon`）；
  - 右上方体素悦灵与右下方完整显露在首屏折线之上的 3D 斜躺实时监视器（配 `@property --beam-angle` 旋转流光边框与取景器四角准星）同屏辉映；
  - 滚入工作流时，同一个监视器由弹簧立起并演播选模板、调参数、导出（含 `AllayProgress` 捧块与跳舞编排）。
- **剪辑点整幅实时转场（`CutScene.tsx`）**：越过接缝时由引擎实时铺满整屏 3D 方块擦除转场，并在峰值时刻切换下方标题。
- **1:1 真实桌面应用试玩台（`SimulatorSection.tsx` + `simulator.html`）**：窗口内直接挂载桌面版渲染进程（`apps/desktop/src/renderer/main.tsx`），顶栏提供 8 个原版像素图标快捷胶囊，左选模板、底拖多段时间轴、右拧参数或点「导出」演练与桌面版完全一致；窄屏（`< 900px`）自动回退为紧凑实时预览台。
- **指针聚光 Bento 与 35mm 胶片技术跑马灯（`TemplatesSection.tsx`、`FeaturesSection.tsx`）**：卡片带指针跟随径向聚光细边框（`.card-spotlight`）与 3D 微倾视差，章节背景带 CSS Scroll-Driven Animations（`animation-timeline: view()`）视差场记水印。

## 常用命令

```bash
pnpm --filter @allay/website dev        # 本地开发预览（5180 端口）
pnpm --filter @allay/website build      # 构建静态产物到 apps/website/dist/
pnpm --filter @allay/website typecheck  # TypeScript 严格类型检查
pnpm test:website                       # 构建并在 Electron Chromium 中运行冒烟验收测试
```
