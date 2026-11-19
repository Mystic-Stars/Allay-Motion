# Java 26.3 原版进度提示：第 52 帧独立参考

本次在 Windows、官方缓存 Java 25.0.1 下执行 Java 26.3 原版类，和 [Java 1.21.1 独立参考](java-vanilla-reference.md) 配对。**原版绘制调用与文字四边形已实测；PNG 与字形位图只做源像素统计；没有最终客户端帧缓冲或实录。** 不用模板运行结果作为原版真值。

## 来源与复现

| 输入 | 校验及用途 |
|---|---|
| 已授权 `%LOCALAPPDATA%\AllayMotion-WorkspacePreview\animation-studio\vanilla-cache\versions\26.3\client.jar` | 41,483,720 字节；SHA-1 `e877b6a07acd633fb3bb475002175cec036e7b87`、SHA-256 `4508d006323f24fa02876310c192d739af56516eb259000ac50f0909a68c9a2d`；与[版本元数据所指的官方客户端对象](https://piston-data.mojang.com/v1/objects/e877b6a07acd633fb3bb475002175cec036e7b87/client.jar)一致 |
| [官方资产索引 34](https://piston-meta.mojang.com/v1/packages/4e950fe41d8ad13e66bde63f476afdbe0cb19f94/34.json) | SHA-1 `4e950fe41d8ad13e66bde63f476afdbe0cb19f94`；读取授权缓存副本，未写回 |
| `minecraft/lang/zh_cn.json` | SHA-1 `1b38ad31b231284468eaae0e693df50751186d2e` |
| `minecraft/font/include/unifont.json`、`minecraft/font/unifont.zip`、`minecraft/font/unifont_jp.zip` | SHA-1 分别为 `402ded0eebd448033ef415e861a17513075f80e7`、`ccd5ac4767ce0a9c71d1dd62f2dc25449789b5dd`、`590470ab0f17afb73a4e41d9cb56fdbe069d275a` |
| `minecraft/font/include/unifont_pua.json`、`minecraft/font/unifont_pua.zip` | SHA-1 分别为 `db5582c177aca966ba1a9b062cead233a262a939`、`d7caa0e3aa5eb656c51817ae4bfbf3c4d72cdaad` |

- 原创记录器及结果位于 `E:\Temp\allay-review-20261118\reference-263`。在该目录执行 `pwsh -NoProfile -File .\prepare.ps1` 和 `pwsh -NoProfile -File .\run.ps1`：前者只从已知缓存以只读方式取对象，或从固定官方 HTTPS 对象站和库站取缺项，使用索引/版本元数据逐项核对 SHA-1；后者用官方 Java 25 运行本地探针。未登录、未读存档、未开客户端窗口或抢前台。
- `Probe263.java` 通过原版 `ToastManager$ToastInstance.update/extractRenderState` 及 `AdvancementToast.extractRenderState`，输入第 0 槽、倍率 1、合成进度和受控单调毫秒。合成进度的文字、类别和钻石与原版同名条目一致；给钻石使用最小物品组件足以捕获 `fakeItem`，不启动物品模型渲染。
- 字体走原版 `FontManager.prepare`、提供器过滤/顺序、`FontSet`、`Font.split` 和 `GuiGraphicsExtractor.text → GuiTextRenderState.ensurePrepared → PreparedText.visit`。记录器只用 bitmap 的原版边界装配无 GPU 纹理的 `BakedSheetGlyph`，在文字四边形处截获结果。背景 `blitSprite` 和图标 `fakeItem` 截于调用入口。未运行最终图集、GUI renderer 或后处理。
- `draw.tsv` 排除不含制表符的运行日志，按 UTF-8 无 BOM、LF 并保留末尾 LF 规范化后，共 213 行，SHA-256 `aba70c1ba574944b4ad639f565e31400b64d7681233bb98572f8e2e9a46258c9`。一条 `label` 紧跟同文字 `line` 是一次组件调用转为序列调用，不是重复画字。官方文件、编译产物和日志均不进仓。

## 简中第 52 帧：原版调用与边界

第 52 帧按 **0 起算、60 fps** 定义，`t=52/60 s`。探针分别输入 866、867 ms，几何和颜色相同；若以 1 起算，等价测试点 850 ms 也已完全进场。默认简中、无强制 Unicode、无日文字形替换；GUI 视口宽 480，第 0 槽。

| 绘制内容 | 原版调用 | 原版测量 |
|---|---|---|
| 背景 | `minecraft:toast/advancement`，局部 `(0,0,160,32)` | 全显位移 `(320,0)` |
| 类别 | `进度已达成！`，局部 `(30,7)`，ARGB `FFFFFF00`，`shadow=false` | advance 合计 54 GUI 像素；字形四边形合并包围盒 `[30,83)×[7,15)` |
| 名称 | `钻石！`，局部 `(30,18)`，ARGB `FFFFFFFF`，`shadow=false` | advance 合计 27 GUI 像素；字形四边形合并包围盒 `[30,56)×[18,26)` |
| 图标 | `fakeItem(minecraft:diamond,8,8)` | 调用原点 `(8,8)`；没有捕获物品渲染后的像素 |

原版中文键：`advancements.toast.task` 为「进度已达成！」；JAR 内 `data/minecraft/advancement/story/mine_diamond.json` 的显示对象用 `advancements.story.mine_diamond.title`，中文为「钻石！」、图标 `minecraft:diamond`。`item.minecraft.diamond` 是不带感叹号的物品名称，不是进度标题。原版 `advancements.toast.goal` / `advancements.toast.challenge` 为「目标已达成！」/「挑战已完成！」；目标和普通类别色相同，挑战类别 `FF88FF`。

每字四边形是 **8×8 GUI 像素**，advance **9**。类别列起点是 `30,39,48,57,66,75`，名称是 `30,39,48`；四边形不等于墨迹外边界。若在 1920×1080 按 GUI 缩放 4 对照，背景全显左上 `(1280,0)`，文字原点为 `(1400,28)` 和 `(1400,72)`，位图覆盖投影 32×32 物理像素/字，字推进 36 物理像素。不能用 1× PNG 降采样得到的字形墨迹去反证 4× 原版。

运动也实际经过 26.3 的 `ToastInstance`：输入显式含第 600 ms 的序列，300/600/5600/5900/6200 ms 背景左边界为 `440/320/320/360/480`；6201 ms 不再提取。当时内容年龄 266/267 ms，提示只在原版定义的全显阶段计内容时龄。长标题同 1.21.1 的示例在 `(30,7)` 放第一行 13 字/117 GUI 像素，在 `(30,16)` 放余下 9 字/81 GUI 像素。两版不同的是：26.3 换段不 OR `0x04`，2099/2100 ms 原版调用 alpha 是 `00/00`，2399/2400 ms 是 `FB/FC`；`GuiGraphicsExtractor.text` 跳过 alpha 0，`text.fsh` 另有 `<0.1` 片元阈值。短标题第 52 帧不经过这段淡变。

## 字体来源与源像素

`minecraft:default` 顺序是 space → 位图组（`uniform:false`）→ Unihex 组；Unihex 组是日文补丁（`jp:true`）→ 通用字库。资产索引的通用字库是 GNU Unifont 17.0.01，1.21.1 则是 15.1.05。`FontManager` 从 `forceUnicodeFont` 和 `japaneseGlyphVariants` 获取独立的 `UNIFORM`、`JAPANESE_VARIANTS` 开关，不是 toast 改用特殊字体。实测本句所有中文和全角感叹号来自通用 Unihex，关闭 JP 补丁；打开 JP 后部分汉字有替代字形，不能仅凭 advance 都是 9 判断长相相同。字母 `I` 可作过滤哨兵：默认位图 advance 4、强制 Unicode 后 Unihex advance 3。

26.3 索引有独立的 PUA 引用与字库；它不在默认引用链。探针的默认字体 `U+E000` 返回缺字（advance 6），即使单独的 PUA 包确实含该点；这一分区不应被当成中文缺字后备。对照 1.21.1 已核对过 SHA-1 的普通 Unihex 包：**「进度已达成！钻石」八个不同码位的 16×16 位图逐字完全相同**。此结论只涉及这八个码位，不等于两版整套字体相同。

| 字符 | 16×16 源位图置位数 | 8×8 中至少覆盖一个置位的 2×2 格数（只作密度上界） |
|---|---:|---:|
| 进 | 66 | 35 |
| 度 | 76 | 38 |
| 已 | 47 | 24 |
| 达 | 52 | 32 |
| 成 | 66 | 40 |
| ！ | 18 | 8 |
| 钻 | 67 | 32 |
| 石 | 56 | 28 |

密度复算：从普通包 `unifont_all_no_pua-17.0.01.hex` 逐码位取 16 行，每行 16 位、高位在左，数置位；再把相邻 2×2 归格，只要任一位为 1 就为该格计一。第二列合计为类别 325、名称 141 个实心源字形像素；第三列不是原版真实采样，不是 8×8 截图金标准。

## PNG 样本与未验证边界

| 官方 PNG 源值 | 数值 |
|---|---|
| `textures/gui/sprites/toast/advancement.png` | SHA-256 `15a959d338d8ce98c1381f95d34f7143377669bcadae1198900bea88144d6634`，与 1.21.1 字节相同；160×32；全透明 18、黑色不透明 370、`#555555` 732、`#212121` 4000；中心 `(80,16)` 为 `#212121`，顶边 `(80,0)` 为黑 |
| `textures/item/diamond.png` | SHA-256 `fd11635ec666c3febb9e6dd6d3ec49cdfb4d16a2a1d595ebd10e56b302417d08`；16×16，120 个不透明像素，源包围盒 `[2,14)×[2,15)`；纹理 `(8,8)`/`(8,12)`/`(8,14)` 为 `#A1FBE8`/`#20C5B5`/`#145E53` |

钻石模型指向 `item/generated`（原版定义 `gui_light=front`）。这里的颜色只来自原 PNG，不能当作模型经过物品图集、前光、色彩转换后的最终屏幕值。没有生成并命名任何“原版完整帧”PNG；本地 `draw.tsv` 是真实原版调用证据，以上 PNG/位图数据是独立源像素参考，最终 framebuffer 尚无金标准。父级做模板对比时，可先核对背景平色、两行字进、无阴影和字形源；如只发现 1× 的字体粗细差异，优先在同倍率、同采样相位下重测，不把密度上界当判定阈值。
