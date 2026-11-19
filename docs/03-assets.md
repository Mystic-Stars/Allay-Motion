# 03 素材与资源栈

包：`packages/assets`（解析、目录数据）；读取在主进程，解码在渲染进程。

## 3.1 目标

- **开箱即用**：没装游戏、没有资源包，所有内置模板也能完整预览和导出。
- **可替换**：用户的资源包能改变方块、物品、界面贴图和音效的外观。
- **干净**：仓库和安装包里没有任何 Mojang 的文件（规则见 `09-compliance.md`）。

## 3.2 三层资源栈

从下到上：

| 层 | 来源 | 是否随安装包分发 | 说明 |
|---|---|---|---|
| `builtin` | `resources/builtin-pack/` | 是 | 本项目自制的素材，覆盖内置模板和目录用到的全部资源 ID |
| `vanilla` | 用户本机的 Minecraft Java 版客户端 jar 和资源索引 | 否 | 只读引用，不复制；找不到就没有这一层 |
| `pack`（可多个） | 用户添加的资源包（zip 或文件夹） | 否 | 用户可排序、可开关 |

解析规则与游戏一致：从最上层往下找，第一个启用且包含该文件的层胜出。`builtin` 永远在最底下且不能关闭。

```ts
interface ResourceLayer {
  id: string;
  kind: 'builtin' | 'vanilla' | 'pack';
  name: string;
  description?: string;
  icon?: Uint8Array;            // pack.png
  packFormat?: number;
  enabled: boolean;
  has(path: string): boolean;   // 例如 "assets/minecraft/textures/block/stone.png"
  read(path: string): Promise<Uint8Array | null>;
  list(prefix: string): string[];
}
```

- 资源 ID 写成 `命名空间:路径`。贴图 `minecraft:block/stone` 对应文件 `assets/minecraft/textures/block/stone.png`，可能伴随 `stone.png.mcmeta`。
- `resourceStamp` 是对（各层 id、文件修改时间、启用状态、顺序）的哈希。它变了，引擎缓存和所有缩略图缓存一起失效。
- 读取 zip 和 jar 用 `yauzl`（按中央目录随机读取，不整包解压）。
- 所有层都缺某个贴图时，用品红黑棋盘格占位，并在 `LoadResult.warnings` 里报告。不得崩溃。

## 3.3 内置层 `builtin`

- 命名与目录结构采用现代 Java 版资源包的约定（1.13 之后的路径和文件名），这样用户资源包可以直接覆盖。
- **第一阶段全部由脚本生成**：`scripts/gen-builtin-pack.ts` 用确定性的程序化算法画出 16×16 贴图。方块按配方生成（底色 + 噪声 + 图案：砖缝、木纹、矿点、金属块边框、羊毛纹理等），物品用代码里的 16×16 字符网格加调色板手绘。结果提交进仓库，脚本可重复运行且输出逐字节一致。
- 这些贴图是原创的，画风上“像 Minecraft 的方块”即可，不要照着原版贴图逐像素临摹。
- 界面贴图（提示框面板、进度条）同样自制。
- 音效用脚本合成（噪声脉冲加指数衰减、正弦短音等），覆盖 3.8 节列出的事件 ID。
- 可选升级：把一套开放许可的资源包并入内置层以提升画质。这一步**必须先由人确认许可证**，流程见 `09-compliance.md`。
- 覆盖率检查：`scripts/check-builtin-coverage.ts` 汇总方块目录、物品目录、内置模板默认值引用到的全部资源 ID，内置层缺任何一个就让 CI 失败。

## 3.4 原版层 `vanilla`

**探测**（主进程，启动后在后台做）：

1. 官方启动器的默认目录：Windows `%APPDATA%\.minecraft`，macOS `~/Library/Application Support/minecraft`，Linux `~/.minecraft`。
2. 用户上次手动选过的目录。
3. 其他常见启动器的默认位置作为候选表，由实现者调研后补充；探测不到就算了。

在候选目录里读 `versions/<id>/<id>.json`，只考虑同目录下存在 `<id>.jar` 的版本，取 `type` 为 `release` 且 `releaseTime` 最新的一个。再按它的 `assetIndex.id` 找 `assets/indexes/<id>.json`，音效文件在 `assets/objects/<哈希前两位>/<哈希>`。

**首次发现时询问一次**（对话框文案见 `06-ui-design.md`）。用户同意后把这一层加进资源栈。设置里可以随时关闭或重新选择目录。

**约束**：

- 只读，不把任何文件复制到应用数据目录。由它派生的缩略图缓存可以存在本机的缓存目录。
- jar 不见了（游戏被移动或卸载）就静默退回内置层，并在资源面板里提示一次。
- 只支持 Java 版。基岩版的资源格式不同，v1 不做。

## 3.5 用户资源包 `pack`

- 支持 zip 和文件夹。可以从文件对话框添加，也可以直接拖进窗口。
- zip 复制到 `userData/packs/<内容哈希>.zip`；文件夹只记路径，窗口重新获得焦点时重扫。
- 读 `pack.mcmeta` 只用于展示名称、描述和格式号。各版本的字段不一样，全部当可选字段处理，缺了也照常加载。
- 发现 `assets/minecraft/textures/blocks/`（复数，1.12 及更早的命名）时，把这个包标成“旧版格式，暂不支持”，仍然列出但提示大部分贴图不会生效。v1 不做旧命名的映射。
- 安全：拒绝包含 `..` 或绝对路径的条目；单个文件解压后超过 64 MB 的跳过。

## 3.6 动画贴图

读取 `<贴图>.png.mcmeta` 的 `animation` 字段：

- 帧在 PNG 里纵向排列；没写 `width`/`height` 时每帧是正方形，边长等于图片宽度。
- `frametime` 单位是游戏刻（1/20 秒），默认 1。`frames` 可以是帧序号数组，也可以是带 `time` 的对象。
- 当前帧是时间的函数（公式见 `02-engine.md` 2.8）。v1 忽略 `interpolate`。

## 3.7 方块目录与物品目录

Mojang 的模型和方块状态 JSON 不能随包分发，所以应用自带一份自己写的目录，只描述“哪个面用哪张贴图”。资源包替换的是贴图，这覆盖了绝大多数使用场景。读取资源包自带的模型 JSON 留给以后的版本。

```jsonc
// packages/assets/data/blocks.json
{
  "minecraft:stone":       { "shape": "cube_all", "tex": { "all": "block/stone" } },
  "minecraft:oak_log":     { "shape": "cube_column", "tex": { "end": "block/oak_log_top", "side": "block/oak_log" } },
  "minecraft:grass_block": { "shape": "cube_bottom_top",
                             "tex": { "top": "block/grass_block_top", "side": "block/grass_block_side", "bottom": "block/dirt",
                                      "sideOverlay": "block/grass_block_side_overlay" },
                             "tint": { "top": "grass", "sideOverlay": "grass" } },
  "minecraft:furnace":     { "shape": "orientable", "tex": { "front": "block/furnace_front", "side": "block/furnace_side", "top": "block/furnace_top" } },
  "minecraft:glass":       { "shape": "cube_all", "tex": { "all": "block/glass" }, "render": "cutout" },
  "minecraft:oak_leaves":  { "shape": "cube_all", "tex": { "all": "block/oak_leaves" }, "render": "cutout", "tint": { "all": "foliage" } }
}
```

- `shape`：`cube_all`、`cube_column`、`cube_bottom_top`、`orientable`、`cube`（六个面分别指定）。
- `render`：`opaque`（默认）、`cutout`、`translucent`。
- `tint`：`grass`、`foliage`、`foliage_spruce`、`foliage_birch`、`water`，取固定常量，存在 `packages/assets/data/tints.json`。已核对的值（平原生物群系的默认色）：草 `#91BD59`、树叶 `#77AB2F`、水 `#3F76E4`。云杉和白桦树叶在游戏里是固定色，具体数值由实现者查证后填入。
- `sideOverlay` 缺失时跳过叠加层。
- 物品目录 `items.json`：`{ "minecraft:diamond_sword": { "tex": "item/diamond_sword" } }`。方块类物品直接用方块目录渲染。
- 显示名 `names.json`：`{ "minecraft:stone": { "zh-CN": "石头", "en": "Stone" } }`，选择器按 ID 和两种语言的名字搜索。

**v1 方块清单（约 110 个）**

| 分组 | 方块 |
|---|---|
| 自然 | `stone` `cobblestone` `deepslate` `dirt` `grass_block` `sand` `gravel` `snow_block` `ice` `packed_ice` `netherrack` `end_stone` `bedrock` `obsidian` `crying_obsidian` `magma_block` |
| 木材 | `oak_planks` `spruce_planks` `birch_planks` `dark_oak_planks` `oak_log` `spruce_log` `birch_log` `oak_leaves` `spruce_leaves` `birch_leaves` |
| 建材 | `bricks` `stone_bricks` `deepslate_bricks` `nether_bricks` `quartz_block` `smooth_stone` `glass` `bookshelf` `hay_block` |
| 矿石 | `coal_ore` `iron_ore` `copper_ore` `gold_ore` `redstone_ore` `lapis_ore` `diamond_ore` `emerald_ore` |
| 矿物块 | `coal_block` `iron_block` `copper_block` `gold_block` `redstone_block` `lapis_block` `diamond_block` `emerald_block` `netherite_block` `amethyst_block` |
| 功能 | `crafting_table` `furnace` `tnt` `note_block` `jukebox` `glowstone` `sea_lantern` `pumpkin` `melon` `slime_block` `honey_block` |
| 羊毛（16 色） | `white_wool` `orange_wool` `magenta_wool` `light_blue_wool` `yellow_wool` `lime_wool` `pink_wool` `gray_wool` `light_gray_wool` `cyan_wool` `purple_wool` `blue_wool` `brown_wool` `green_wool` `red_wool` `black_wool` |
| 混凝土（16 色） | 同上 16 色的 `*_concrete` |
| 陶瓦（16 色） | 同上 16 色的 `*_terracotta` |

**v1 物品清单（约 40 个）**

`diamond_sword` `iron_sword` `netherite_sword` `golden_sword` `diamond_pickaxe` `iron_pickaxe` `netherite_pickaxe` `diamond_axe` `diamond_shovel` `bow` `arrow` `diamond` `emerald` `gold_ingot` `iron_ingot` `netherite_ingot` `copper_ingot` `redstone` `lapis_lazuli` `coal` `amethyst_shard` `apple` `golden_apple` `bread` `cooked_beef` `ender_pearl` `ender_eye` `blaze_rod` `nether_star` `totem_of_undying` `firework_rocket` `book` `enchanted_book` `compass` `clock` `bucket` `water_bucket` `lava_bucket` `experience_bottle` `snowball` `stick` `music_disc_13`

## 3.8 音效

- 音效事件 ID 与游戏一致，例如 `minecraft:block.stone.place`。有原版层或资源包时，按 `sounds.json` 解析到具体文件，多个变体的选择规则见 `02-engine.md` 2.10。
- 内置层为下列事件提供合成音效，保证没有原版层时模板也有声音：

| 事件 ID | 用途 |
|---|---|
| `minecraft:block.stone.place` | 放置方块 |
| `minecraft:block.stone.break` | 破坏方块 |
| `minecraft:block.wood.place` | 放置木质方块 |
| `minecraft:ui.button.click` | 点击 |
| `minecraft:entity.experience_orb.pickup` | 清脆提示音 |
| `minecraft:entity.player.levelup` | 升级提示音 |
| `minecraft:ui.toast.in` | 提示框滑入 |
| `minecraft:ui.toast.out` | 提示框滑出 |
| `minecraft:ui.toast.challenge_complete` | 挑战完成 |
| `minecraft:entity.generic.explode` | 爆炸 |
| `allay:whoosh` | 飞掠（本项目自有的 ID） |

- 支持 `.ogg` 和 `.wav`。解码在渲染进程用 `decodeAudioData`。

## 3.9 字体

- 引擎的文字是位图字。字形来源按资源栈解析：
  - 有原版层或资源包提供 `assets/minecraft/font/default.json` 时，解析其中的 `bitmap`、`space`、`reference` 三种提供器。字形宽度按该字形最右侧的不透明像素列计算，字间距 1 像素，空格宽 4 像素。
  - Java 字体也支持 `unihex`（主进程有界读取嵌套 ZIP）和 `ttf`（Chromium 在引擎 Worker 中解码本机字节）。按资源层及提供器顺序查找；未启用强制 Unicode 和日文字形变体。
  - 每段作品文字可选当前档案已授权且启用的资源字体。预览与导出逐字查找：所选字体 → 同一资源栈的 `minecraft:default` → 本机系统字体。「自动」从 `minecraft:default` 开始；没有可用资源时直接用系统字体，不下载字体。
  - 不单独导入字体文件。旧工程和预设中的 `allay:fallback`、合法的 `user-font:<64 位小写十六进制摘要>` 按「自动」解释；不读取或清理用户旧字体库的文件。
- 游戏字形只用于作品内容或明确展示字形的样张，不用于品牌或界面；不新增样张界面。桌面安装包和官网均不附带文字字体。

## 3.10 缩略图

- 方块图标：正交相机，绕 X 轴 30°、绕 Y 轴 225°，带面明暗，64×64 和 128×128 两档。
- 物品图标：正面平视。
- 由杂务 Worker 批量生成，按 `resourceStamp` 缓存到 `userData/cache/thumbs/`。资源栈一变就后台重建，重建期间界面显示骨架和悦灵（见 `07-allay-mascot.md`）。

## 3.11 验收测试

| 编号 | 内容 | 判定 |
|---|---|---|
| T-AST-1 | 用三个夹具资源包（各自覆盖不同贴图）测试叠加顺序、开关、重排 | 解析结果与预期表一致 |
| T-AST-2 | 资源栈为空（只有内置层）时加载每个内置模板 | `warnings` 为空 |
| T-AST-3 | 引用一个不存在的贴图 ID | 得到占位图和一条警告，不抛错 |
| T-AST-4 | 带 `.mcmeta` 的 4 帧动画贴图，`frametime = 2` | `t = 0, 0.1, 0.2, 0.3, 0.4` 时的帧序号为 `0, 1, 2, 3, 0` |
| T-AST-5 | 含 `../` 条目的恶意 zip | 被拒绝，应用数据目录外没有新文件 |
| T-AST-6 | 夹具 `.minecraft` 目录（含两个版本，其中一个没有 jar） | 选中有 jar 且最新的正式版 |
| T-AST-7 | 运行两次 `gen-builtin-pack` | 输出目录逐字节相同 |
