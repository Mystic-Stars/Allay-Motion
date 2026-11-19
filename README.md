# Allay Motion（悦灵动画）

**所有创作者都必备的 Minecraft 动画创作工具**

想要制作 YouTube 风格的高级 Minecraft 转场动画，却不会用复杂昂贵的 After Effects？
网上下载的现成模板千篇一律，想改贴图、调参数却无从下手？

试试 **Allay Motion** —— 专为 Minecraft 视频创作者打造的桌面转场动画工具：选模板、调参数、实时预览，一键导出带透明通道的短片，直接拖进剪辑软件盖在两段素材的接缝上。

## 为什么选择 Allay Motion？

- **界面美观，简易现代化**
- **开源免费，拒绝订阅制**
- **模板丰富，一键应用与深度自定义**
- **开发者积极维护，使用不降智的前沿AI**

## 从源码构建

构建前请确保本机已安装 **Node 24+** 和 **pnpm 12**。支持 Windows（x64）和 macOS 12 及更新（Apple 芯片与 Intel）；macOS 上 `pnpm ffmpeg:fetch` 会从官方源码编译 FFmpeg，需要 Xcode 命令行工具和 `pkg-config`，Intel 机器另需 `nasm`，耗时约十几分钟。

```bash
pnpm install
```

```bash
pnpm ffmpeg:fetch
```

```bash
pnpm dev
```

常用命令（完整列表见 [`docs/01-product-architecture.md`](docs/01-product-architecture.md) 1.10）：

| 命令 | 作用 |
|---|---|
| `pnpm check` | 类型检查、lint、单元测试、引擎测试、导出测试、来源登记检查、许可检查、端到端测试 |
| `pnpm check:removable` | 可选模块目录不存在时 `pnpm check` 照常通过 |
| `pnpm dist` | 按当前机器打包（`apps/desktop/release/`）：Windows 上生成 x64 安装包，macOS 上生成本机架构（arm64 或 x64）的 dmg 和 zip；并跑打包后的检查 |
| `pnpm licenses:gen` | 依赖变了之后重新生成第三方许可清单 |


## 第三方软件与许可

- FFmpeg（LGPLv3）以独立进程调用，随安装包附带许可全文；构建来源和源码去处写在应用的“关于”页。Windows 版用 FFmpeg-Builds 的 LGPL 构建，macOS 版由本项目从官方源码按 LGPL 配置编译（静态链接 BSD 许可的 libvpx、libopus）。
- macOS 版只做了 ad-hoc 签名、没有经过 Apple 公证：首次打开时在“访达”里右键选“打开”，macOS 15 起到“系统设置 → 隐私与安全性”里点“仍要打开”。
- 品牌和应用界面使用系统 UI 字体，代码使用系统等宽字体。桌面和官网均不分发文字字体；作品使用已授权资源层的游戏字形，缺字逐字回退到本机系统字体。
- 其余依赖使用 MIT、BSD、ISC、Apache-2.0 等许可；完整清单在“关于 → 第三方许可”和安装目录的 `THIRD_PARTY_NOTICES.txt`。

## 许可 / License

**中文**

- 本项目以 [GNU 通用公共许可证第 3 版](LICENSE)（**GPL-3.0-only**）授权。
- **商业授权**：需要以 GPL 不允许的方式使用（例如用在闭源产品里），请通过本仓库的 [Issues](https://github.com/Mystic-Stars/Allay-Motion/issues) 联系版权人，另行取得商业授权。
- 用本软件导出的视频归使用者所有，不受本许可约束。
- **许可范围**：GPL-3.0 和商业授权只覆盖本项目自己的代码和原创素材，都**不包含** Minecraft 的任何内容：Minecraft 的名称与商标；应用在运行时从 Mojang 下载或从本机游戏读取的原版资源（贴图、模型、音效、字体、语言文件等）；用户自己添加的第三方资源包；以及由它们派生的内容，包括照原版悦灵制作的模型数据（`packages/mascot/model/` 里与 Mojang 设计对应的部分）和由原版贴图渲染的悦灵图像（`packages/mascot/generated/`）。这些内容的权利属于 Mojang 或各资源包的作者，本项目未获授权、不分发原版资源包，也不对它们授予任何权利；使用者需自行遵守 Minecraft 最终用户许可协议和各资源包的许可。

**English**

- This project is licensed under the [GNU General Public License v3.0](LICENSE) (**GPL-3.0-only**).
- **Commercial license**: to use it in ways the GPL does not allow (for example in closed-source products), contact the copyright holder through this repository's [Issues](https://github.com/Mystic-Stars/Allay-Motion/issues).
- Videos you export with this software belong to you and are not covered by this license.
- **Scope**: the GPL-3.0 license and the commercial license cover only this project's own code and original assets. **Neither includes** any Minecraft content: the Minecraft name and trademarks; the vanilla resources the app downloads from Mojang at runtime or reads from your installed game (textures, models, sounds, fonts, language files and so on); third-party resource packs you add; and anything derived from them, including the Allay model data made after the original (the parts of `packages/mascot/model/` that correspond to Mojang's design) and the Allay images rendered from the original texture (`packages/mascot/generated/`). Those rights belong to Mojang or to the resource pack authors. This project is not licensed by them, does not distribute vanilla resource packs and grants no rights to them; follow the Minecraft EULA and each resource pack's license yourself.
