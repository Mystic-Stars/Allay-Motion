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

{{CTX_TABLE}}

缓动的预设名（`ctx.ease` 的成员，也是 `easing` 参数的取值）：

{{EASINGS}}

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

{{DIAGNOSTIC_KINDS}}

## 8. 外部编辑器

应用往模板文件夹写两个文件：`template-api.d.ts`（`ctx` 的完整类型）和下面这份 `jsconfig.json`。用 VS Code 打开这个文件夹，`template.js` 里就有补全和类型检查。

```json
{{JSCONFIG}}
```

`template-api.d.ts` 不依赖任何包。`ctx.THREE` 只声明了模板常用的类和成员（与真实的 three.js 兼容）；没列出的成员运行时照样可用，只是没有补全。

## 9. 最小示例

`manifest.json`：

```json
{{EXAMPLE_MANIFEST}}
```

`template.js`：

```js
{{EXAMPLE_TEMPLATE}}
```
