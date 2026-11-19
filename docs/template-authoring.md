# 模板编写指南

<!-- 由 pnpm templates:api 从 scripts/template-api/authoring.md 生成，不要直接改这份文件。 -->

这份指南写给用自己的编辑器写模板的人。规格的原文在 `docs/04-templates.md`（4.3–4.6）和 `docs/02-engine.md`（2.4–2.9）；这里讲怎么写，以及容易出错的地方。

## 1. 模板是什么

一个脚本模板是一个文件夹：

```
manifest.json        模板的身份和参数声明
template.js          模板代码：不含任何 import 的单文件 ES 模块
assets/              可选：模板自带的图片，代码里用 asset:文件名 引用
template-api.d.ts    可选：外部编辑器用的类型定义（应用会写进来）
jsconfig.json        可选：让编辑器用上面的类型检查 template.js（应用会写进来）
```

- 代码只能用 `ctx` 给的东西。`THREE` 也从 `ctx.THREE` 拿，不能 `import`，也不能自带依赖。
- 代码在一个与界面隔离的 Worker 里运行：没有 DOM、没有网络、不能读写文件。
- 代码不经过转译：你写的是什么，运行的就是什么，所以错误信息里的行号列号就是你文件里的行号列号。

## 2. 契约

`template.js` 默认导出一个带 `setup(ctx)` 的对象。`setup` 可以是 `async` 的，返回一个实例：

| 成员 | 说明 |
|---|---|
| `duration` | 时长，秒，0.1–30 |
| `cutTime` | 剪辑点，秒；转场类必填，其他类型可以是 `null` |
| `update(t)` | 把画面摆到时刻 `t`（秒）。引擎可能按任意顺序、在同一帧里多次调用它（运动模糊的子帧） |
| `dispose()` | 可选：释放 `setup` 里自己创建的几何体、材质、贴图 |

参数一变，引擎就销毁旧实例、用新参数重新 `setup`。不需要写增量更新。

在编辑器里给默认导出加上类型注解，就能对 `ctx` 补全：

```js
/** @type {import('./template-api').TemplateModule} */
export default {
  async setup(ctx) {
    // ctx. 后面会有补全
  },
};
```

## 3. ctx 的能力

| 成员 | 签名 | 说明 |
|---|---|---|
| `ctx.THREE` | `THREE: typeof THREE` | three.js（r187）。只声明了常用的类和成员，见本文件末尾的 THREE 命名空间；没列出的成员运行时照样可用 |
| `ctx.locale` | `readonly locale: string` | 宿主在装载时提供的语言标签，例如 zh-CN；省略时为 en |
| `ctx.params` | `params: Readonly<ParamValues>` | 参数值（manifest 的 params 声明）。已经清洗过：类型不对的回到默认值，越界的钳制，缺的补默认值 |
| `ctx.stage` | `stage: Readonly<StageInfo>` | 舞台：设计单位下的宽高（短边恒为 1080，原点在中心，+y 向上）、宽高比、帧率、像素比例 |
| `ctx.scene` | `scene: THREE.Scene` | 往里加东西的场景。setup 结束后引擎回收场景里剩下的几何体和材质 |
| `ctx.camera` | `camera: THREE.Camera` | 当前相机。默认是正交相机，刚好覆盖整个舞台 |
| `ctx.setCamera` | `setCamera(camera: THREE.Camera): void` | 换相机（比如换成 createStageCamera 建的透视相机） |
| `ctx.createStageCamera` | `createStageCamera(opts: { fov: number }): THREE.PerspectiveCamera` | 建一台透视相机（fov 是垂直视角，度），位置已算好，z = 0 平面恰好填满舞台 |
| `ctx.resources` | 对象 | 贴图、方块、物品。都在 setup 里 await 完，update 里不要再取 |
| `ctx.resources.texture` | `texture(id: string): Promise<THREE.Texture>` | 已设好过滤和色彩空间的贴图；缺失时返回占位图并记一条警告。.mcmeta 动画由引擎按 t 自动播放 |
| `ctx.resources.optionalTexture` | `optionalTexture(id: string): Promise<THREE.Texture \| null>` | 同一已授权资源栈和原 ID；取不到时返回 null，不返回占位贴图。同一资源代内缓存探测结果 |
| `ctx.resources.block` | `block(id: string, opts?: { shading?: boolean }): Promise<BlockHandle>` | 方块目录里的方块；不认识的 ID 用占位贴图的立方体并记一条警告 |
| `ctx.resources.item` | `item(id: string): Promise<ItemHandle>` | 物品目录里的物品（方块 ID 按方块渲染）；不认识的 ID 用占位贴图并记一条警告 |
| `ctx.text` | 对象 | 用资源栈字体及本机系统字体排一段文字 |
| `ctx.text.prepare` | `prepare(font: string): Promise<void>` | 按 font 参数声明的字体自动预载；程序生成的字体 ID 可在 setup 里显式预载 |
| `ctx.text.measureGui` | `measureGui(text: string, font?: string): GuiTextMetrics` | 量一行 GUI 文字的笔宽和基线边界，与 create 选用相同字形，不创建文字贴图或场景对象。 |
| `ctx.text.create` | `create(opts: TextOptions): TextObject` | 同步创建文字；逐字使用已选资源栈字体、minecraft:default、本机系统字体 |
| `ctx.sprite` | 对象 | 贴图四边形，可带九宫格 |
| `ctx.sprite.create` | `create(texture: THREE.Texture, opts?: SpriteOptions): SpriteObject` | 用一张贴图建精灵；中心在原点 |
| `ctx.random` | `random(key?: string): Rng` | 带种子的随机数（种子取模板的 seed 参数）。同一个 key 总是给出同一串数，不同 key 互不影响。在 setup 里预先算好，update 里只查表 |
| `ctx.noise2D` | `noise2D(x: number, y: number, key?: string): number` | 带种子的连续二维噪声（simplex），值约在 [-1, 1]；同样的输入总是同样的输出 |
| `ctx.ease` | `ease: EaseLibrary` | 缓动函数：预设名（如 ease.cubicInOut）、bezier(x1, y1, x2, y2)、from(easing 参数的值) |
| `ctx.math` | `math: MathHelpers` | 常用的数学小工具 |
| `ctx.time` | 对象 | 时间工具 |
| `ctx.time.segment` | `segment(t: number, start: number, duration: number): number` | t 在 [start, start + duration] 里的进度，钳制到 [0, 1] |
| `ctx.audio` | 对象 | 音频提示 |
| `ctx.audio.cue` | `cue(sound: string \| null, at: number, opts?: { gain?: number; rate?: number; pan?: number; position?: readonly [x: number, y: number, z: number] }): void` | 在时刻 at（秒）播放音效事件；只能在 setup 里调用。sound 为 null 时什么也不做 |
| `ctx.warn` | `warn(message: string, code?: 'panorama-fallback'): void` | 记一条警告（一次装载最多 50 条）；实际回退时可在 setup 内附上资源提示码，宿主据此显示简短提示。 |

ctx 交出来的对象：

**Rng**

| 成员 | 签名 | 说明 |
|---|---|---|
| `next` | `next(): number` | [0, 1) |
| `range` | `range(a: number, b: number): number` | [a, b) |
| `int` | `int(a: number, b: number): number` | [a, b] 内的整数 |
| `pick` | `pick<T>(items: readonly T[]): T` | 从数组里等概率取一个 |
| `shuffle` | `shuffle<T>(items: T[]): T[]` | 原地打乱并返回同一个数组 |

**BlockHandle**

| 成员 | 签名 | 说明 |
|---|---|---|
| `single` | `single(): THREE.Object3D` | 边长为 1 的方块，中心在原点，模板自己缩放 |
| `instanced` | `instanced(count: number): BlockInstances` | 建 count 个实例（一次绘制）；用 setMatrix 等摆放，每帧改完调用一次 commit() |
| `faceTexture` | `faceTexture(face: BlockFace): THREE.Texture` | 方块某个面用的贴图（按方块目录；不含草方块侧面的叠加层，不带面明暗和着色），供着色器平铺等用途。 返回引擎缓存里的贴图：模板不要释放它，也不要改它的属性（例如 wrapS）。 |

**BlockInstances**

| 成员 | 签名 | 说明 |
|---|---|---|
| `object` | `object: THREE.Object3D` | 加到场景里 |
| `count` | `count: number` | 实例个数 |
| `setMatrix` | `setMatrix(index: number, matrix: THREE.Matrix4): void` | 第 index 个实例的变换 |
| `setOpacity` | `setOpacity(index: number, opacity: number): void` | 0–1 |
| `setTint` | `setTint(index: number, color: THREE.ColorRepresentation): void` | 第 index 个实例的染色（与贴图相乘） |
| `commit` | `commit(): void` | 一帧里改完所有实例后调用一次 |

**ItemHandle**：物品：高度为 1，厚度为 1/16，中心在原点

| 成员 | 签名 | 说明 |
|---|---|---|
| `single` | `single(): THREE.Object3D` | 一个物品的 3D 模型（有厚度的贴图） |

**TextObject**：文字对象。默认纵向原点在整段文字中线；guiBaseline 模式用基线，左对齐以笔尖为横向原点。

| 成员 | 签名 | 说明 |
|---|---|---|
| `object` | `object: THREE.Object3D` | 加到场景里 |
| `width` | `width: number` | 设计单位 |
| `height` | `height: number` |  |
| `setOpacity` | `setOpacity(opacity: number): void` | 0–1 |

**SpriteObject**：精灵：中心在原点的贴图四边形

| 成员 | 签名 | 说明 |
|---|---|---|
| `object` | `object: THREE.Object3D` | 加到场景里 |
| `setSize` | `setSize(width: number, height: number): void` | 设计单位 |
| `setOpacity` | `setOpacity(opacity: number): void` | 0–1 |

**MathHelpers**

| 成员 | 签名 | 说明 |
|---|---|---|
| `clamp` | `clamp(x: number, min: number, max: number): number` | 把 x 钳制到 [min, max] |
| `lerp` | `lerp(a: number, b: number, t: number): number` | a + (b − a) × t |
| `invLerp` | `invLerp(a: number, b: number, x: number): number` | lerp 的反函数：(x − a) / (b − a) |
| `remap` | `remap(x: number, inMin: number, inMax: number, outMin: number, outMax: number): number` | 把 x 从 [inMin, inMax] 线性映射到 [outMin, outMax] |
| `smoothstep` | `smoothstep(edge0: number, edge1: number, x: number): number` | x 在 [edge0, edge1] 之间的平滑过渡（三次 Hermite），两端钳制到 0 和 1 |

缓动的预设名（`ctx.ease` 的成员，也是 `easing` 参数的取值）：

`linear`、`quadIn`、`quadOut`、`quadInOut`、`cubicIn`、`cubicOut`、`cubicInOut`、`quartIn`、`quartOut`、`quartInOut`、`quintIn`、`quintOut`、`quintInOut`、`expoIn`、`expoOut`、`expoInOut`、`circIn`、`circOut`、`circInOut`、`backIn`、`backOut`、`backInOut`、`elasticOut`、`bounceOut`

## 4. 确定性：画面只能是时间的函数

预览、导出、缩略图都用同一份代码，按任意顺序取帧。只要 `update(t)` 的结果只取决于 `t`，它们就一致。具体的规则：

1. `update(t)` 只能依赖 `t` 和 `setup` 时建立的状态。不读真实时间（`Date.now()`、`new Date()`、`performance.now()`），不用 `Math.random()`，不改跨帧保留的状态（比如每调用一次加一的计数器）。
2. 要随机就用 `ctx.random(key)`：同一个种子和 key 总是给出同一串数。在 `setup` 里把随机数预先算好存起来，`update` 里只查表。
3. 所有资源在 `setup` 里 `await` 完；`update` 里没有异步操作，不创建几何体、材质、贴图。
4. `ctx.audio.cue` 只在 `setup` 里调用。
5. 布局由 `ctx.stage` 推出（短边恒为 1080 个设计单位），16:9、9:16、1:1 三种画幅都要成立。

应用分三层抓不确定性：

| 时机 | 做什么 | 结果 |
|---|---|---|
| 写代码时 | 静态检查：代码里出现 `Math.random`、`Date.now`、`new Date()`、`performance.now`、`import` | 提示（rule），带位置；字符串和注释里的不算 |
| 开发构建预览时 | `update(t)` 期间调用上面几个函数会直接抛错 | 错误（determinism），指向调用的那一行 |
| 安装时 | 同一帧渲染两次，中间穿插渲染别的帧，比较像素 | 不一致时模板卡片标注“预览与导出可能不一致” |

## 5. 时间余量：首末帧全透明，剪辑点完全不透明

- **首帧和末帧必须全透明**（`t = 0` 和 `t = duration`），片段盖到素材上时才不会突然出现或消失。
- **转场类模板在 `cutTime` 必须完全不透明**，剪辑软件里在这一帧切换素材。

开了运动模糊时，一帧由几个子帧平均而成，子帧最多偏离帧时刻半帧（快门角 360° 时）；剪辑点那一帧离 `cutTime` 也最多半帧。所以动画要留出一帧的余量，记 `pad = 1 / ctx.stage.fps`：

- 进入阶段从 `pad` 开始，最晚在 `cutTime − pad` 结束；
- 退出阶段最早从 `cutTime + pad` 开始，在 `duration − pad` 结束。

这样 `[0, pad]` 和 `[duration − pad, duration]` 里画面全空，`[cutTime − pad, cutTime + pad]` 里画面全满，任何画质、任何快门角下首末帧和剪辑点都满足要求。帧率极低、一帧比半个阶段还长时余量做不到，安装时会给出警告。下面的示例就是这样做的。

## 6. 参数声明

参数在 `manifest.json` 的 `params` 里声明，代码从 `ctx.params` 读。应用按声明生成属性面板，并在交给代码之前清洗参数值：类型不对的回到默认值，越界的钳制，多余的键丢弃，缺的补默认值。所以 `ctx.params` 总是完整的一组，但代码里仍应按类型取值（`typeof v === 'number' ? v : 默认值`），类型检查器才知道它是什么。

| `type` | 值 | 专有字段 |
|---|---|---|
| `number` | 数字 | `default` `min` `max` `step?` `unit?` `ui?` |
| `integer` | 整数 | `default` `min` `max` `ui?` |
| `boolean` | 布尔 | `default` |
| `enum` | 字符串 | `default` `options: { value, label }[]` |
| `color` | `#RRGGBB` 或 `#RRGGBBAA` | `default` `alpha?` `palette?` |
| `text` | 字符串 | `default`（可以是多语言） `maxLength?` `multiline?` |
| `block` / `item` | 方块、物品 ID | `default` |
| `blockList` | `{ id, weight }[]` | `default` `max?` |
| `texture` | 资源 ID、`asset:路径` 或用户选的图片 | `default` `allowFile?` |
| `sound` | 音效事件 ID 或 `null` | `default` |
| `easing` | 预设名或 `[x1, y1, x2, y2]` | `default` |
| `duration` | 秒 | `default` `min` `max` |
| `angle` | 度 | `default` `snap?` |
| `seed` | 整数 | `default` |

- 每个参数都有 `key`（`^[a-z][a-zA-Z0-9]*$`，模板内唯一）和 `label`；可选 `hint`、`group`、`visibleWhen`。
- 模板有 `seed` 参数时，`ctx.random` 以它为种子。
- `texture` 参数的值可以原样交给 `ctx.resources.texture()`；`easing` 参数的值交给 `ctx.ease.from()`。
- 在 `setup` 里用 `await ctx.resources.optionalTexture(id)` 检查可选素材，例如 `minecraft:ui/loading_bar`。它接受和 `texture()` 相同的资源 ID、已授权本机图片或模板资产引用；取不到返回 `null`，不出现品红占位。探测按资源代缓存；需要贴图时仍可用 `texture()`，照常报告缺失。不要修改或释放两者返回的共享贴图。
- `ctx.locale` 是装载时的宿主语言（例如 `zh-CN`；未提供时 `en`）。用于选择模板内的默认文案，不替换用户输入。
- 用 `timeline.segments` 把几个 `duration` 参数声明成首尾相接的时间段，播放条上可以拖分界线。

## 7. 出错时看到什么

装载、渲染出错时，应用给出结构化的诊断，能定位的带行号列号：

| 种类 | 什么时候 |
|---|---|
| `compile` | 装载前的预检：语法错误、出现 `import`、源码超过 1 MB。带位置 |
| `load` | 模块求值时抛错（带位置），或默认导出不是带 `setup` 的对象 |
| `setup` | `setup` 抛错（带位置），或返回值不合契约（`duration` 越界等） |
| `update` | `update(t)` 抛错，带出错的时刻 `t` 和位置 |
| `watchdog` | 在时限内没有返回（比如死循环），Worker 已被终止。没有位置 |
| `determinism` | 开发构建在 `update(t)` 里拦到 `Math.random` 等（带位置）；或同一帧穿插渲染后结果不同（没有位置） |
| `rule` | 静态检查的提示：代码里出现了会破坏确定性的调用。带位置 |

## 8. 外部编辑器

应用往模板文件夹写两个文件：`template-api.d.ts`（`ctx` 的完整类型）和下面这份 `jsconfig.json`。用 VS Code 打开这个文件夹，`template.js` 里就有补全和类型检查。

```json
{
  "compilerOptions": {
    "checkJs": true,
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": [
      "ES2023"
    ],
    "types": [],
    "strict": false,
    "noEmit": true
  },
  "include": [
    "template.js",
    "template-api.d.ts"
  ]
}
```

`template-api.d.ts` 不依赖任何包。`ctx.THREE` 只声明了模板常用的类和成员（与真实的 three.js 兼容）；没列出的成员运行时照样可用，只是没有补全。

## 9. 最小示例

`manifest.json`：

```json
{
  "formatVersion": 1,
  "id": "user.example.solid-push",
  "version": "1.0.0",
  "name": { "zh-CN": "纯色推入推出", "en": "Solid push" },
  "category": "transition",
  "params": [
    { "key": "color", "type": "color", "label": { "zh-CN": "颜色", "en": "Color" }, "default": "#2072D5" },
    { "key": "inDuration", "type": "duration", "label": { "zh-CN": "进入", "en": "In" }, "default": 0.4, "min": 0.1, "max": 3 },
    { "key": "hold", "type": "duration", "label": { "zh-CN": "停留", "en": "Hold" }, "default": 0.2, "min": 0, "max": 3 },
    { "key": "outDuration", "type": "duration", "label": { "zh-CN": "退出", "en": "Out" }, "default": 0.4, "min": 0.1, "max": 3 },
    { "key": "easing", "type": "easing", "label": { "zh-CN": "缓动", "en": "Easing" }, "default": "cubicInOut" }
  ],
  "timeline": { "segments": [{ "param": "inDuration" }, { "param": "hold" }, { "param": "outDuration" }] }
}
```

`template.js`：

```js
// 最小示例：纯色从左推入、停留、向右推出的转场。docs/template-authoring.md 原样引用这份文件，
// T-DEV-3 用生成的 template-api.d.ts 对它做 checkJs 类型检查。

/** @type {import('./template-api').TemplateModule} */
export default {
  async setup(ctx) {
    const { THREE, params, stage, scene } = ctx;
    /** @param {string} key @param {number} fallback */
    const num = (key, fallback) => {
      const v = params[key];
      return typeof v === 'number' ? v : fallback;
    };
    const inDuration = num('inDuration', 0.4);
    const hold = num('hold', 0.2);
    const outDuration = num('outDuration', 0.4);
    const duration = inDuration + hold + outDuration;
    const cutTime = inDuration + hold / 2;

    // 时间余量：首末帧全透明、剪辑点完全不透明，在开了运动模糊时也要成立（规则 7、8）
    const pad = 1 / stage.fps;
    const inStart = pad;
    const inEnd = Math.max(inStart + 1e-6, Math.min(inDuration, cutTime - pad));
    const outStart = Math.max(inDuration + hold, cutTime + pad);
    const outEnd = Math.max(outStart + 1e-6, duration - pad);

    const material = new THREE.MeshBasicMaterial({ color: new THREE.Color(String(params.color ?? '#2072D5')) });
    const geometry = new THREE.PlaneGeometry(stage.width, stage.height);
    const quad = new THREE.Mesh(geometry, material);
    scene.add(quad);
    const ease = ctx.ease.from(params.easing);

    return {
      duration,
      cutTime,
      update(t) {
        // 只依赖 t：不读真实时间、不用 Math.random、不改跨帧的状态
        const a = ease(ctx.math.clamp((t - inStart) / (inEnd - inStart), 0, 1));
        const b = ease(ctx.math.clamp((t - outStart) / (outEnd - outStart), 0, 1));
        quad.position.x = -stage.width * (1 - a) + stage.width * b;
      },
      dispose() {
        geometry.dispose();
        material.dispose();
      },
    };
  },
};
```
