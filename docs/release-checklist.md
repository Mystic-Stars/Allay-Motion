# 发布前检查清单

`docs/08-milestones.md` M8 要求的清单：`docs/09-compliance.md` 9.11 里带 ★ 的事项，加上实现过程中在 `docs/decisions.md` 里累计的待人确认项。原先的规则是：任何一项不是“已确认”或“不适用”，就不对外发布。仓库所有者已决定直接公开发布，并于 2026-11-14 要求之后构建通过时直接正式发布；未确认事项仍按实际状态保留。

状态只有三种：**已确认**（人看过并给了明确答复，写明谁、何时、依据）、**待确认**、**不适用**（写明为什么）。这份清单不替人确认任何事；实现会话只负责把要看的东西准备好。

整理于 2026-11-14（M8）。安装包：`pnpm dist` 生成的 `Allay Motion-0.1.0-x64-setup.exe`，未签名；以后由 GitHub Actions 的发版工作流构建（见第四节）。2026-11-14 起发版工作流同时构建 macOS 的 dmg 和 zip（arm64、x64，ad-hoc 签名、未公证，`docs/decisions.md`“macOS 构建”）。

> **v0.1.0 的发布决定（2026-11-14）**：仓库所有者决定公开发布 v0.1.0（原话“直接公开发布”）。这是所有者对上面“不对外发布”规则的决定，**不代表下面各项已经确认**：发布时 ★ 项里 H-BRAND 的方案、H-NAME、H-LICENSE 的细节、商业授权与 Mojang 的内容、H-SIGN、H-DOWNLOAD、FFmpeg 的 LGPL 义务仍是待确认，状态照实保留。

## 一、阻塞发布的（★）

| 编号 | 事项 | 状态 | 要人判断什么 | 材料 |
|---|---|---|---|---|
| ★ H-BRAND | 产品名与吉祥物走 9.4 的 A、B 还是 C。**比规格写的更重**：现在不是“自绘的悦灵”，而是安装包里带着由 Minecraft 原版悦灵贴图烘焙出的图集、头像和**应用图标**（用户决定并担责，decisions.md M5a）；而且公开仓库里有照原版悦灵做的模型代码和这些派生图像（decisions.md M8） | **用户已知悉并承担风险**（公开仓库含模型代码和原版贴图的派生图像，2026-11-13）；名称与吉祥物的方案（A/B/C）、是否向 Mojang 申请书面许可仍待确认 | ① 名称“Allay Motion / 悦灵动画”和以悦灵为吉祥物是否保留（A/B/C）；② 安装包分发原版贴图的派生图像是否可以接受，按 9.4 的建议是否先向 Mojang 申请书面许可；③ 选 B 或 C 时，品牌资产只在 `packages/mascot`、`packages/ui/src/brand/`，另有 `electron-builder.yml` 的 `productName` 和文件关联的 `description` 要一起改 | `docs/09-compliance.md` 9.3、9.4；`docs/decisions.md` M5a“来源规则变更”；关于页的 `brand.licenseScope` |
| ★ H-NAME | “Allay Motion”的重名与商标检索 | 待确认 | 检索结果是否允许用这个名字（检索要把名字发给外部服务，实现会话没有做） | 9.4 末段 |
| ★ H-LICENSE | 项目自己的许可证 | **用户已定：GPL-3.0 + 商业授权（2026-11-14）**；`-only` 还是 `-or-later` 待确认 | 用户原话“先用GPL-3.0 + 商业授权，防止下游闭源”。现在写的是更保守的 `GPL-3.0-only`（`LICENSE` 是 GitHub 建仓时那份 GPL-3.0 全文，原文未改；各 `package.json` 的 `license` 字段、README、关于页、`THIRD_PARTY_NOTICES.txt` 一致）。要人确认：① `-only` 还是 `-or-later`；② 商业授权的条款和联系方式（现在只写“通过仓库的 Issues 联系”）；③ 外部贡献的贡献者许可协议文本（`CONTRIBUTING.md` 只写了规则，没有协议正文、没有 CLA 机器人）。**许可范围**：GPL-3.0 和商业授权都不包含 Minecraft 的内容——名称与商标、运行时下载或从本机游戏读取的原版资源、用户添加的资源包，以及由它们派生的内容（含仓库里的悦灵模型数据和烘焙图像）；见 README“许可”一节 | 9.8；`pnpm check:licenses`；`apps/desktop/src/renderer/features/settings/third-party-licenses.json` |
| ★ 商业授权与 Mojang 的内容 | 商业授权一旦收费，应用里照原版悦灵做的模型、由原版贴图派生的图像和图标、以 Minecraft 生物命名的产品名，风险都比免费分发高（9.4 末条：打算收费时要回到 9.4 重新评估） | 待确认 | 收费版本是否排除或替换悦灵相关的模型、图像、图标和名称（建议排除或换成原创），以及在那之前是否先向 Mojang 申请书面许可。许可文本里已写明两种授权都不包含这些内容，但安装包里实际带着它们 | `docs/09-compliance.md` 9.4；README“许可”一节 |
| ★ H-SIGN | 代码签名证书（Windows）与 Apple 开发者账号（macOS 的签名和公证） | 待确认 | 是否购买证书、注册 Apple 开发者计划（要花钱、要账号，实现会话不做）。**现在的 Windows 安装包和 exe 都没有签名**：Windows SmartScreen 会拦下并显示“未知发布者”，用户要点“更多信息 → 仍要运行”。**macOS 版只做了 ad-hoc 签名、没有公证**：Gatekeeper 会拦下，用户要右键“打开”（macOS 15 起到“系统设置 → 隐私与安全性”点“仍要打开”）。不签名的话只适合内部测试 | `electron-builder.yml`（`win.signAndEditExecutable` 不带证书，打包日志里是 “signing is skipped”；`mac.identity: "-"`、`hardenedRuntime: false`）；`docs/decisions.md`“macOS 构建” |
| ★ H-DOWNLOAD | 运行时替用户从 Mojang 官方服务器下载客户端 jar 和音效对象是否符合 Minecraft 最终用户许可协议和使用准则 | 待确认 | 条款是否允许第三方工具这样做。“要这么做”是用户的决定（见下方已确认项），这里确认的是条款核对。下载只发生在用户机器上、用户点按钮之后，仓库和安装包里没有任何 Mojang 文件（悦灵的派生图像见 H-BRAND） | `docs/decisions.md` M2a“对‘应用不联网’的例外”、M6b“音效从哪里来”；`apps/desktop/src/main/resources/download.ts` |
| ★ FFmpeg 的 LGPL 义务 | 随包附带 LGPLv3 全文、`ffmpeg.exe` / `ffmpeg` 是可替换的独立文件、关于页写明构建来源和源码去处 | 待确认 | Windows 的“取得源码的方式”是指向上游（FFmpeg 官方仓库的提交 `d838f9f9ae`、FFmpeg-Builds 的发布标签）。macOS 版由本项目自己编译：源码是官方发布的 tarball（地址和 SHA-256 写在关于页、`THIRD_PARTY_NOTICES.txt` 和应用包 `Contents/Resources/ffmpeg/darwin-<架构>/build.json` 里），构建脚本在公开仓库（`scripts/ffmpeg-macos.ts`），静态链进去的 libvpx、libopus（BSD）的许可原文附在同目录的 `LICENSE.txt` 里；自己分发自己编译的二进制，对应源码的义务落在本项目身上。是否足够，还是要像 LGPLv3 第 4 条的常见做法那样自己托管一份对应的源码或附书面提供承诺 | 9.9；关于页“FFmpeg 构建”；安装目录 `resources/ffmpeg/win32-x64/LICENSE.txt`、`build.json`、`THIRD_PARTY_NOTICES.txt`；macOS 应用包 `Contents/Resources/` 下的同名文件；`docs/decisions.md`“macOS 构建” |

## 二、功能与质量上要人看的

| 编号 | 事项 | 状态 | 要人判断什么 | 材料 |
|---|---|---|---|---|
| M8 安装（人工） | 在一台**干净的** Windows 上安装、运行、导出、卸载（M8 的验收项） | 待确认 | 欢迎页的声明（中英文）显示完整；开始菜单和桌面有快捷方式；双击 `.allay`、`.allaytpl` 用应用打开（应用开着时交给已开的窗口）；应用图标在资源管理器、任务栏、文件关联里显示正常；导出一个文件；卸载后快捷方式和文件关联都没了（用户数据 `%APPDATA%\AllayMotion` 按设计保留）。**实现会话没有在任何机器上实际安装过**：只核对了安装包内容和生成的安装脚本 | `docs/review/M8/README.md`；`tests/dist/M8.package.test.ts` |
| macOS 安装（人工） | 在真实的 Mac（Apple 芯片和 Intel 各一台）上打开 dmg、拖进“应用程序”、首次打开、导出、双击关联文件 | 待确认 | 首次打开时 Gatekeeper 的提示和放行步骤与 Release 说明一致；窗口左上的红绿灯和顶栏不重叠、在顶栏里竖直居中，拖动顶栏能移动窗口；程序坞和访达里的图标正常；菜单栏的复制、粘贴、⌘Q 能用；四种格式都能导出（绿幕 MP4 走 VideoToolbox）；双击 `.allay`、`.allaytpl` 用应用打开（应用开着时交给已开的窗口）。**实现会话没有 Mac**：只在 GitHub 的 macOS 虚拟机上打包、核对包内容和签名、直接启动过可执行文件（不经访达和 Gatekeeper） | `docs/decisions.md`“macOS 构建”；CI 上传的首次启动截图（`screenshots-mac-*`、`macos-arm64` 产物） |
| H-M1 | ProRes 4444 MOV 在真实剪辑软件里的边缘、颜色、首末帧 | 待确认 | 半透明边缘不发黑、颜色和预览一致、首末帧全透明、剪辑点那一帧完全盖住接缝 | `docs/review/M1/README.md`；`docs/05-export.md` 5.4 |
| M7 四种格式 | 透明 MOV、PNG 序列、透明 WebM、绿幕 MP4 在真实剪辑软件里能否导入、透明通道是否被认出 | 待确认 | 填 `docs/review/M7/README.md` 的表；之后按结果改各格式的“适用于”文案（两种语言） | `docs/review/M7/README.md` |
| 带音轨导出的听感 | ProRes、WebM、MP4 带音轨时的音画同步、音量（含峰值压低）、AAC/Opus 开头的编码延迟 | 待确认 | 在播放器和剪辑软件里听：音效和画面对得上、没有爆音和明显延迟。自动测试只按 ffprobe 的包时长核对过 | `docs/decisions.md` “四路合并的对接 · 没验证的”、M6b |
| H-H264 | 是否保留 `libopenh264` 作为 H.264 的最后兜底 | 待确认 | 保留（现状：排在硬件和系统编码器之后）还是去掉（没有可用硬件或系统编码器的机器上“绿幕 MP4”会被禁用）。自行编译进 FFmpeg 的 openh264 不在 Cisco 二进制的专利许可覆盖范围内 | 9.9；`docs/decisions.md` M7“编码器探测” |
| T-ARC-7 冷启动 | 打包后的应用：启动画面 0.5 秒内出现，3 秒内主界面可交互 | 待确认 | 规格没定义“参考机器”。本机实测（见 `docs/decisions.md` M8“冷启动”）：主界面可交互约 1.1 秒；启动画面从进程启动算中位数约 0.46 秒、从双击算约 0.5 秒，在预算边上，安装后第一次启动约 1.1–1.2 秒。CI 上只记数字不判定。请确认参考机器，以及这个结果是否可以接受 | `docs/decisions.md` M8；`tests/dist/T-ARC-7.cold-start.test.ts` |
| CI 和安装包验证 | `ci.yml`、`release.yml` 在 GitHub 上的运行结果 | 待确认 | 查看最终提交的 CI 和发版工作流结果，在干净的 Windows 上确认生成的安装包能否安装 | `docs/decisions.md` M8“上 GitHub 与 Actions 发版” |
| 原版层开关（M2） | 装了游戏的机器上同意使用原版素材后，开关原版层，预览在原版钻石块和品红黑占位之间切换；资源包盖在原版之上 | 待确认 | 照做一遍看结果 | `docs/review/M2b/README.md` |
| 悦灵在导出对话框里的位置 | 位置、大小与设计稿是否一致 | 待确认 | 看一眼 | `docs/decisions.md` “四路合并的对接 · 没验证的” |
| 启动画面与主窗口的衔接 | 可见窗口里的淡出、最大化时机 | 待确认 | 正常启动应用看一次（自动测试的窗口都不显示） | `docs/decisions.md` M5b“没做的、没验证的” |

## 三、已确认或不适用的

| 编号 | 事项 | 状态 | 依据 |
|---|---|---|---|
| H-ALY | 悦灵的样子和动作 | **已确认**（用户，2026-11-13） | 用户看过 `docs/review/M5a/out/` 后答复“还不错，要”（decisions.md“人工确认记录”）。只确认了形象本身，不等于 H-BRAND |
| 素材来源的做法 | 不自制贴图和音效；悦灵用原版贴图烘焙；原版素材在运行时由用户触发从 Mojang 下载并提取 | **已确认**（用户决定，经主控转达，2026-11-13） | decisions.md M2a、M5a、M6b。这是“要这么做”的决定；它带来的条款问题在 H-DOWNLOAD、H-BRAND，仍待确认 |
| 公开仓库与 Actions 构建（做法） | 代码放在公开仓库 `Mystic-Stars/Allay-Motion`，安装包由 Actions 构建；悦灵的模型代码和运行时用的烘焙产物随仓库公开 | **已确认**（用户，2026-11-13）；2026-11-14 用户决定构建成功后自动正式发布 | decisions.md“人工确认记录”和“GitCode 镜像与自动发布” |
| 提交作者邮箱 | 公开后历史里的作者邮箱 | **已确认**（用户，2026-11-13：保留，不改写历史） | decisions.md“人工确认记录” |
| H-PACK | 是否并入开放许可的资源包 | 不适用 | 范围变更后不内置任何贴图（decisions.md M2a），没有并入任何资源包 |
| H-ART | 自制贴图的质量 | 不适用 | 同上，没有自制贴图 |
| H-UPDATE | 自动更新与发布渠道 | **已确认**（仓库所有者，2026-11-14） | 原话“请你为这个程序加上自动更新……通过github和gitcode的release做为更新源”。0.1.2 起应用内检查、下载并校验 Release 里的安装包；未签名的问题仍在 H-SIGN（decisions.md“自动更新”） |
| H-MCP | 纯代码编辑与 MCP 可选模块 | 不适用（未做，仅记录） | 用户决定目前不做（`docs/code-editing-and-mcp-plan.md`）；`packages/optional/` 为空，`pnpm check:removable` 证明删掉它不影响主程序。以后要做时再评估它带来的安全和许可问题 |
| `default_app.asar` | 安装包里带着 Electron 自带的示例应用（M0 起的遗留项） | 已处理 | M8 的 afterPack 钩子删掉它；`tests/dist/M8.package.test.ts` 核对解包目录和安装包里都没有 |

## 四、安装包从哪里来、怎么发布

用户决定（2026-11-13）：代码放在公开仓库 `Mystic-Stars/Allay-Motion`，安装包由 GitHub Actions 构建（`.github/workflows/release.yml`）。

- 只有具备现有 GitHub 标签权限的维护者推送 `v*` 标签才会公开 Release，分支推送和标签删除都不会。发版同时构建 Windows 的 NSIS 安装包（x64）和 macOS 的 dmg、zip（arm64、x64 各一份）；三份都成功后创建临时草稿，挂上全部安装包和一份合并的 `SHA256SUMS.txt`，随后自动公开。任何一份构建、检查或上传失败时不会公开。
- 手动触发只构建并上传工作流产物，不发布 Release。Release 公开后，另一个工作流把发行版和全部附件同步到 GitCode，详见 `docs/gitcode-mirror.md`。
- v0.1.0 的公开发布和此后的自动发布由仓库所有者决定；★ 项是否确认仍以本表为准，自动发布不代表它们已确认。
- 安装包没有代码签名（macOS 只有 ad-hoc 签名、没有公证），工作流里也没有任何证书或密钥。
- 0.1.2 起应用内有自动更新。**附件的文件名格式和 `SHA256SUMS.txt` 不能随意改**（`apps/desktop/src/shared/updates.ts` 按文件名挑安装包）。GitCode 的附件同步完之前，国内用户会退回从 GitHub 下载。
- 分支推送和 PR 上的 CI（`.github/workflows/ci.yml`）默认跑一遍 `pnpm check`；`pnpm check:removable` 在手动运行 CI 时按需勾选。macOS 不在日常 CI 里：发版工作流的两个 macOS 构建编译 FFmpeg、跑 `pnpm test:export` 和 `pnpm dist`。发版工作流里的 `pnpm dist` 跑打包后的检查；T-ARC-7 在 CI 的共享机器上只记数字、不按预算判定（不是参考机器）。

更新渠道由标签决定，与分支名无关：

| 渠道 | 标签 | Release |
|---|---|---|
| Codex | `vX.Y.Z-codex.N` | 预发布，不设为 latest |
| main | `vX.Y.Z` | 正式版，可成为 latest |
| dev | `vX.Y.Z-dev.N` | 预发布，不设为 latest |

`beta`、`rc` 等其他 SemVer 预发布仍可公开，但不设为 latest，也不属于这三个渠道。

发版操作：

1. 确认待打标签的提交上 CI 全绿，发版工作流跑通。
2. 按 H-SIGN 的决定签名（或明确以“未签名”发布并在 Release 页说明；macOS 的“未公证、首次打开怎么放行”工作流写的 Release 说明里已经有）。
3. Release 页带 9.5 的非官方声明（中英文；工作流写的草稿说明里已经有）。
4. 先更新 `apps/desktop/package.json` 的 `version`（标签去掉开头的 `v`，保留完整的预发布后缀）和 `CHANGELOG.md` 的版本与日期。由已有权限的维护者在包含这些改动的提交上打标签并推送，查看 Actions 的发布及 GitCode 同步结果。版本不一致时，标签构建会在打包前失败，而不是改写版本。
