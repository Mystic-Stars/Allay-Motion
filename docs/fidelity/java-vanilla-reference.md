# Java 1.21.1 原版进度提示：独立绘制参考

2026-11-18，Windows、JDK 21.0.12。**这是实际执行原版 `AdvancementToast.render` 和 `ToastComponent$ToastInstance.render` 捕获的绘制调用，不是游戏录屏，也不是模板截图。** 表内背景像素覆盖由原版调用坐标和原版 PNG 复算，未读取 GPU 帧缓冲。

## 来源与复现

| 输入 | 锁定值 |
|---|---|
| 本机 `%APPDATA%\.minecraft\versions\1.21.1\1.21.1.jar`，26,836,906 字节 | SHA-1 `30c73b1c5da787909b2f73340419fdf13b9def88`，与[官方客户端对象](https://piston-data.mojang.com/v1/objects/30c73b1c5da787909b2f73340419fdf13b9def88/client.jar)一致；SHA-256 `499f6897d1837516680f3114072d8106e11c9adcd933fe5cf051b551089b0c99` |
| [官方 client mappings](https://piston-data.mojang.com/v1/objects/2244b6f072256667bcd9a73df124d6c58de77992/client.txt) | SHA-1 `2244b6f072256667bcd9a73df124d6c58de77992`；SHA-256 `140c47931cccc8fc9e4c22d7603e2d714d1a953a146f51ea7397d95c955536ec` |
| [1.21.1 官方资产索引 17](https://piston-meta.mojang.com/v1/packages/4ca8e1a1edd37a703c5d1594f71d409852cd9770/17.json) | SHA-1 `4ca8e1a1edd37a703c5d1594f71d409852cd9770`；不能只凭启动器缓存同名 `17.json` 判定版本 |
| 索引 `minecraft/lang/zh_cn.json` | SHA-1 `bd3b3df108c1eaf78b6b8904c9f0842a7b110d5c`；英语来自客户端 JAR |
| 索引 `minecraft/font/include/unifont.json`、`minecraft/font/unifont.zip`、`minecraft/font/unifont_jp.zip` | SHA-1 分别为 `f40266672fa6cd5c678cbfd5a7fdcfe06e30c629`、`666999116c467f10622db1527a06ddc0a6efad2a`、`92ab1f42958051008cf66c9f551adf12139f89ab`；客户端 JAR 内 Unihex 引用文件为空，不能单用 JAR 测中文宽度 |
| JAR `assets/minecraft/textures/gui/sprites/toast/advancement.png` | SHA-256 `15a959d338d8ce98c1381f95d34f7143377669bcadae1198900bea88144d6634` |

1. 本机证据目录 `E:\Temp\allay-review-20261118\vanilla-reference`。在该目录运行 `pwsh -NoProfile -File .\Run-ToastProbe.ps1`（可传 `-Minecraft` 与 `-JdkBin`）。原创探针是 `ToastProbe.java`、`ProbeLauncher.java`、`Run-ToastProbe.ps1`。中文翻译放在与脚本同级的 `zh_cn.json`。字体对象按索引路径放到 `official-assets/assets/` 下；缺对象时可从 `https://resources.download.minecraft.net/<SHA-1 前两位>/<SHA-1>` 取，下载后核对上表。
2. 探针从校验过的本机 JAR 加载未经改写的原版类。按映射，`fks` 是 `AdvancementToast`，`fkw$a` 是 `ToastComponent$ToastInstance`，`fhz` 是 `GuiGraphics`，`fhx` 是 `Font`，`fam` 是 `Window`。以原版 builder 建立带钻石图标、单个 `impossible` criterion 和显示信息的合成进度；使用第 0 槽、通知时长倍率 1。注入单调毫秒时钟和原版 `PoseStack`，仅用记录器替代 `GuiGraphics` 的末端精灵、两种文字与物品绘制及声音投递；不替换这两个 `render` 方法。
3. 用原版 `FontManager.prepare`、准备列表的原版应用顺序和 `FontSet` 提供器选择，跳过 GPU 纹理上传。调用原版 `Font.split` 和原版字宽；默认字体、未开启强制 Unicode 或日文字形。运行时验证 `I` 来自位图，advance 为 4；`石`、`村`、`！` 来自 Unihex，advance 为 9。**先前只带 JAR 或未反转提供器列表的宽度结果无效**，会把中文误测成缺字宽 6。
4. 输出 `draw.tsv`。筛掉无制表符的运行日志，保留行顺序，用 UTF-8 无 BOM、LF 分隔并加末尾 LF，得到 2,881 行，SHA-256 `ff92f2e693f486cb5ba2c239b74ff9668519cb6e5afa59157b21829fa73e2f66`。`sprite` 末三列是原版姿态平移 x/y/z；`state` 是内容年龄和实例是否移除；`label`/`title` 的颜色是输入 ARGB，末列是另行执行原版 `Font.adjustColor` 的结果。未读取用户存档或凭据，未启动游戏客户端窗口、音频设备或模板渲染。

## 运动、缩放和覆盖

坐标均为左上原点 GUI 单位。第 0 槽背景绘制为 `minecraft:toast/advancement`、局部 `(0,0,160,32)`，位姿 y=0、z=800；图标调用为 `renderFakeItem(diamond, 8, 8)`。原版物品 GUI 调用用 16×16 名义范围；非透明占位不等于整个范围，本探针不测物品光照或实际边缘。

GUI 宽 480 时，以下为原版 x。像素列是用背景 PNG 单独推算的**不透明像素数**，不是游戏帧的统计。固定 GUI 480×270，缩放 1、4 分别对应 480×270、1920×1080 帧缓冲。

| 自首绘起 ms | 左边界 x | s=1 背景覆盖 | s=4 背景覆盖 |
|---:|---:|---:|---:|
| 0 | 480 | 0 | 0 |
| 47 | 479.018219 | 27 | 432 |
| 150 | 470 | 311 | 4,976 |
| 300 | 440 | 1,271 | 20,336 |
| 450 | 390 | 2,871 | 45,936 |
| 599 | 320.532898 | 5,075 | 81,416 |
| 600、5600 | 320 | 5,102 | 81,632 |
| 5750 | 330 | 4,791 | 76,656 |
| 5900 | 360 | 3,831 | 61,296 |
| 6050 | 410 | 2,231 | 35,696 |
| 6199 | 479.467102 | 27 | 216 |
| 6200、6201 | 480 | 0 | 0 |

- 进入 600 ms：`x = W - 160*p²`；退出 600 ms：`x = W - 160*(1 - p²)`；`p` 是按当前阶段的毫秒/600 钳到 `[0,1]`。原版用 float，表中的分数 x 不应先转整数。以采样包含恰好 600 ms 为例，停留从 600 ms 计，5600 ms 先绘制再切退出，6200 ms 绘制已完全出界但实例尚在，6201 ms 返回移除。
- 声音调用（并未播放）：含 600 ms 的采样为 0 ms `ui.toast.in`、601 ms `ui.toast.challenge_complete`、5600 ms `ui.toast.out`。固定 16 ms 采样的独立实例，最后一个入场采样为 592 ms，608 ms 内容年龄已是 16 ms；挑战音 608 ms，标题换段首次出现在 2096 ms（年龄 1504），5584 ms 年龄 4992、5600 ms 才触发退出，6208 ms 移除。不能把 601 或 2100 ms 当成与游戏帧节奏无关的恒定触发时刻。
- 背景 160×32 的 alpha 直方图只有 A=0 的 18 像素及 A=255 的 5,102 像素。最左 4 列各有 27、29、31、32 个不透明像素。用最近邻和像素中心取样复算表：遍历帧缓冲整数 `(u,v)`，纹理坐标为 `(floor((u+0.5)/s-x), floor((v+0.5)/s))`；纹理和帧缓冲都在界内且 PNG alpha 非零则计一。表只统计 sprite；不混入文字、不把推算当 GPU 实测。
- 原版 `Window.calculateScale`/`setGuiScale` 实际运行值：1920×1080 自动→4、480×270；1921×1081 自动→4、481×271；1280×720 自动→3、427×240；854×480 自动→2、427×240；640×360 自动→1、640×360。普通模式增加整数比例，保持下一档按整数除法至少 320×240，并遵守显式上限（0 代表自动）；Unicode 标志为真时把奇数档加 1，例如 1280×720 自动→4、320×180。GUI 尺寸分别向上取整，但投影用帧缓冲宽高除以比例的未取整值；奇数尺寸不能把 GUI 画布视为完全填满 `ceil(宽/s) × s`。

## 英文、中文与换段颜色

以下 `(x,y)` 是交给原版 `GuiGraphics.drawString` 的局部原点，不是像素墨迹边界；均 `shadow=false`。

| 输入 | 类别行 | 名称行 |
|---|---|---|
| 英语短标题：`advancements.story.mine_stone.title` | `Advancement Made!` `(30,7)`，宽 94，`FFFFFF00` | `Stone Age` `(30,18)`，宽 50，`FFFFFFFF` |
| 简中同一短标题 | `进度已达成！` `(30,7)`，宽 54，`FFFFFF00` | `石器时代` `(30,18)`，宽 36，`FFFFFFFF` |
| 英语挑战：`Bring a diamond home before the sun rises again` | `Challenge Complete!` `(30,11)`，宽 97 | `Bring a diamond home` 宽 106、`before the sun rises` 宽 107、`again` 宽 26，y=`3/12/21` |
| 简中挑战：`在遥远的山脉寻找失落的矿石并把它安全带回村庄` | `挑战已完成！` `(30,11)`，宽 54 | `在遥远的山脉寻找失落的矿石` 宽 117、`并把它安全带回村庄` 宽 81，y=`7/16` |
| 目标：`I` 重复 42 次 | `Goal Reached!` 宽 69 / `目标已达成！` 宽 54，`(30,11)`，RGB `FFFF00` | 31 个 `I`（124）+ 11 个 `I`（44），y=`7/16` |

名称用原版 `Font.split`，宽限 125。多行名称 x 恒为 30，首行 `16-floor(行数*9/2)`，行进为 9；单行两行原点固定，不交替。普通/目标类别 RGB `FFFF00`；挑战 RGB `FF88FF`；名称 RGB `FFFFFF`。多行首段只画类别，后段只画名称，不交叉叠画。

| 内容年龄 ms | 文字 | alpha 字节（十六进制） |
|---:|---|---:|
| 1200 | 类别 | `FF` |
| 1275 / 1350 / 1425 | 类别 | `BF` / `7F` / `3F` |
| 1499 | 类别 | `04` |
| 1500 / 1501 | 名称 | `04` / `04` |
| 1575 / 1650 / 1725 | 名称 | `3F` / `7E` / `BD` |
| 1799 / 1800 及其后 | 名称 | `FF` / `FC` |

可复算：类别阶段用 `floor(255 * clamp((1500-age)/300))`，名称阶段用 `floor(252 * clamp((age-1500)/300))`，两者都对 **alpha 字节按位 OR `0x04`（十进制 4）**。这不是 `0x40`，也不是 `max(4,a)`；1799 到 1800 的 `FF → FC` 是这条运算的结果。原版 `Font.adjustColor` 对这些值不改 alpha。另独立检查 JAR 内 `rendertype_text.fsh`：普通文字把纹理、顶点和颜色调制后的 alpha 小于 0.1 的片元丢弃；对全不透明字形像素、无额外调制时，字节 ≤25 不可见，≥26 才可能显示。由此推算换段中有短暂的空白，不能把 `04` 解释成肉眼应见的文字，也不能把这一推算写成 GPU 读取结果。

## 交接与未验证事项

- 审计期间看到的模板 `javaTextAlpha` 对 1.21.1 路径曾使用 `alpha | 64` 且未应用原版文字阈值。内容年龄 1500 ms 的原版名称调用是 `04FFFFFF`，随后会被文字着色器丢弃；该模板表达式则产生 `40FFFFFF`（约 25% alpha）。这是具体数值差异，非截图观感判断。本任务不改模板。
- 产品的 Java 进度样式现在有两种缩放：匹配 1.21.1 / 26.3 资源库的新建提示默认选「原版自动」，按逻辑输出像素选档（1280×720 → 3，背景名义上 480×96）；不读取游戏强制 Unicode 或显式 GUI 档位。旧工程和手动模式仍保存原 `guiScale`，它是**设计单位/GUI 像素**，不是输出像素/GUI 像素，例如同一 1280×720 工程的手动 `4` 投影为 `4×720/1080` 输出像素/GUI 像素。编辑画布缩放及静帧、封面的降采样不重新选档：1920×1080 工程缩为 480×270 静帧时仍选 4，再按四分之一投影。
- 没有能确认版本的公开实录帧加入本证据。未验证原版游戏最终帧、GPU 合成/混色、物品模型实际像素、现场声音、多提示排队及不同资源包。用父级独立渲染对照时，应选同语言、同资产、同缩放、同采样时序；不可用模板自身产物反推参考。所有本机原版内容和诊断产物仅留在临时目录，仓库只放本说明的测量结果与出处。
