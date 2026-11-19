# 基岩版加载与游戏内成就提示

## 证据范围

- `Get-AppxPackage -Name Microsoft.MinecraftUWP` 返回 Windows x64 包 `1.26.6301.0`，[Bedrock 26.63 条目](https://minecraft.wiki/w/Bedrock_Edition_26.63)列有同一 Windows 包版本，且链接到[官方热修说明](https://feedback.minecraft.net/hc/en-us/articles/50306516691853-Minecraft-Bedrock-Edition-26-63-Hotfix-Changelog)（本机访问官方页面返回 403）。本机只核对了目录和可读明文：`vanilla/texts/{en_US,zh_CN}.lang` 有本地进入、应用资源包、生成世界/地形及完成的键；`loading_messages.json` 有按使用场景分组的提示。`vanilla/textures/ui` 可见 `panoramahdr_*.hdr`，不是可直接走 PNG 接口的图。安装根列出了 `MCSplashScreen.png`，读取被拒绝，不能据文件名推断画面。没有打开 `__brarchive` 或市场包，也没有启动游戏采集画面。
- 布局参照 [Mojang 官方 vanilla sample 的固定提交](https://github.com/Mojang/bedrock-samples/tree/15701fa9c13923f12662984c32c124327e40e3d3/resource_pack)，其 `version.json` 对应 `1.26.60.5`。该快照没有 `ui/loading_screen.json`，相关布局位于 [`progress_screen.json`](https://github.com/Mojang/bedrock-samples/blob/15701fa9c13923f12662984c32c124327e40e3d3/resource_pack/ui/progress_screen.json)、`ui_art_assets_common.json`、`ui_common.json`、`achievement_screen.json` 和 [`toast_screen.json`](https://github.com/Mojang/bedrock-samples/blob/15701fa9c13923f12662984c32c124327e40e3d3/resource_pack/ui/toast_screen.json)。另交叉核对 Wiki 的[世界载入](https://minecraft.wiki/w/Loading_world_screen#Bedrock_Edition)、[启动](https://minecraft.wiki/w/Menu_screen)和[提示](https://minecraft.wiki/w/Toasts)，及[官方成就帮助](https://help.minecraft.net/hc/en-us/articles/4409244237325-Unlock-Minecraft-Bedrock-Edition-Achievements)。没有拷入原始素材或模板 JSON。
- 另核对了公开[世界载入静帧](https://minecraft.wiki/w/File:Bedrock_Loading_Screen.png)与[下界跨维度静帧](https://minecraft.wiki/w/File:Nether_loading_screen.png)：前者有标题、全景、面板内的左对齐提示和绿色分段条；后者仍有标题和面板，但没有可见进度条。这些静帧不等于 26.60 或 Windows 26.63 实录，不能据此测时。公开的[基岩提示截图](https://minecraft.wiki/w/File:Toast_Bedrock_Edition.png)是配方提示，不是成就或系统通知的证据。

## 范围与已知差异

| 场景 | 证实的构件 | 实现边界 |
| --- | --- | --- |
| 世界载入 / 世界资源包加载 | 16:9 参考中，顶部标题宽约屏宽 55%、顶边约 10%；居中面板 290×100 GUI 单位，经验条宽 `(290−12)×90% = 250.2`、高 5，分隔纹理在条两端各留 5 单位后平铺。`loading_bar` 是 640×8 横条上的 10 个 64×8 帧，样例以 10 fps 往返。 | 停留前段「启动世界 → 加载资源包」，后段推进到生成地形及独立的轮换提示，最后显示生存模式的「存活 / Survive」。结尾文字来自本机语言键和 Wiki 的模式说明；时点、分段和两条原创提示仅为模板设计。提示使用面板内部的位置，不与地形或用户副标题叠画。资源包模式只表示应用世界资源包，不表示联网下载或 Java 重载。 |
| 前往下界 / 末地 / 主世界 | 样例复用世界标题和面板，按目的地平铺 `textures/blocks/{netherrack,end_stone,dirt}.png`，加入各自的渐变；下界还带纹理染色。 | 标题和面板保留，加载条不显示，使用居中的生成地形文案。渐变颜色与权重据样例设置，但未校对基岩渲染器的混色空间和全部入口差异；不使用 Java 的传送门效果。 |
| Windows 26.63 灰底启动（待采样） | Wiki 支持灰底、标题图、加载条及百分比的组织 | 灰色、位置、进度和淡入淡出仅为参考。一个中间阶段，不仿画 Mojang 或 Minecraft 标志，不模拟系统启动窗、红色初始启动阶段、登录或之后的菜单。未绑定标题时仅显示普通文字。 |
| 26.60 样例游戏内成就（待设备采样） | `toast_screen` 有顶部居中线性位移、`greyBorder`、13×13 的第三方成就图槽和两行文字；Wiki 限定为不支持 Xbox 通知的设备 | 尺寸、停留、可选音频和文案是编辑参数，不代表系统定时或实际设备通知。官方样例在 UI 中引用图标但该快照不含对应 PNG；缺失时留空。没有复刻 Xbox 界面、音效、分数徽标或 PlayStation 系统奖杯，也不声称 Windows 会显示这个成就提示。 |

## 本机资源绑定

在现有资源栈导入并启用用户有权使用的普通未加密 `.mcpack`。基岩 UI 纹理经 `minecraft:ui/...` ID 使用：`title.png`、`bg32.png`、`panorama_0.png` 至 `panorama_5.png`、`dialog_background_hollow_3.png`、`loading_bar.png`、`experiencebarempty.png`、`experiencebarfull.png`、`experiencenub.png`、`greyBorder.png`（资源 ID 小写 `greyborder`）、`achievement_third_party.png`。九宫格边缘以逻辑尺寸映射；标准布局的高清图集可同比放大。PNG 六面要求完整、等尺寸且不能全是 1×1 占位；自选 PNG 背景优先并保持静止，缺全景才读 `bg32`。全景方向、俯角、转速仍是近似，不读取 HDR 或补齐缺面，也不对全景额外加全屏暗色。失效的图片绑定提示后回退同资源栈；没有可用素材再用中性替代。不自动打开本机游戏安装目录。

## 参数审计与交接

| 模式与字段 | 当前行为 / 建议 |
| --- | --- |
| 全部基岩加载：`bedrockBackground`、`bedrockTitle`、`title`、`subtitle`、`titleFont`、`subtitleFont`、`textScale`、`loadingLanguage` | 背景、标题图优先用绑定；正常情况下加载文字及字体生效，字号只影响字，不再改变面板、进度或平铺尺寸，超出面板区域会缩字。自编副标题（含空串）取代预设提示。现有通用默认标题/副标题文案兼作基岩预设标记，输入与默认相同的字面串无法区分。建议独立基岩文案或来源字段，区分预设、编辑值与显式清空。`bedrockTravelNether`、`bedrockTravelEnd`、`bedrockTravelOverworld` 建议也显示 `bedrockTitle`；运行时已支持，但目前通过别的模式保留的值才会用到。 |
| `bedrockPacks` / `bedrockWorld`：`animateBackground`；加载模式：`showBar`、`progressFont`、`seed` | `animateBackground` 只在六面齐全、未绑定静态背景时影响旋转，不影响进度；建议写明此前提。`showBar` 影响世界与资源包加载条以及启动条和百分比，跨维度无条。`bedrockStartup` 的 `progressFont` 只在 `showBar=true` 时有效，建议条件显示。`seed` 仅用于 `inStyle` 或 `outStyle` 为 `dissolve` 的背景像素图案；建议说明其条件及文字仍淡变。 |
| `bedrockAchievement`：`bedrockAchievementIcon`、`guiScale`、`margin`、`inDuration`、`hold`、`outDuration` | 绑定可覆盖 13×13 图槽，读不到时回退资源栈原 ID；边距使用设计单位，不再随 `guiScale` 成倍增长。`guiScale` 在画幅较窄时限幅，高宽与时序是模板可编辑量；线性滑动是普通样例参考，未验证设备端锚点或实际时长。 |
| `bedrockAchievement`：标题、颜色与音效来源 | 默认兼容旧项目：保留旧自定义标题、颜色和声音，否则使用本地化标题、白色、静音。旧项目整组保存的通用默认标题也保留原效果。另选「预设」可忽略旧标题；SDK 让自定义编辑框从旧 `header` 初始化，随后逐字显示，留空省略标题行。自选颜色和音效按所选值使用，包括黄色 `#FFFF55`、`minecraft:ui.toast.in` 和「无音效」。第二行仍沿用 `titleColor`。所有来源都只在基岩模式出现；用户选的声音只是剪辑音效，不代表实际通知。 |

## 验证

`T-FID.bedrock.test.ts` 用合成 `.mcpack` 验证原路径、大小写映射、九宫格及可选贴图缓存；同一组场景状态测试检查 GUI 尺寸、贴图优先级、1×1 全景筛除、提示切换、进度裁切、冻结、字体、边距、音效、透明首尾和乱序求值。该测试不生成真实游戏像素。本轮未运行 Electron 或打开游戏前台。仍需在注明语言、GUI 缩放、游戏模式和触发步骤的 Windows 26.63 实录中核对启动、世界和各维度，并在支持第三方游戏内提示的设备上验证实际成就通知。没有 OS 通知实录，也没有模拟 OS 通知。
