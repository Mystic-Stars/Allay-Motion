# 动画工作台交接

- 快速模板继续以 `.allay` v1 保存、按模板参数决定时长；打开旧档不自动转成合成，也不替换缺失的模板版本。「用当前模板新建」显式把当时的参数复制成一个新合成片段，不覆盖旧档。
- `.allay` v2 的 `composition` 使用 SDK `CompositionSchema`（内部格式版本 1）。`projectStore.composition === null` 时走原快速模板链路；非空时，预览和导出读取同一份合成文档，用 `revision` 判定快照是否过期。`composition.fps` 与 `output.fps` 一致；长度上限 300 秒，允许空轨和空白帧。
- 轨道与轨内片段数组的顺序从底到顶，后项盖在前项上。同轨允许重叠。`locked` 只限制编辑，`muted` 在预览与导出中都排除画面和音频。片段使用 `[startFrame, startFrame + durationFrames)`，源取样帧为 `sourceInFrame + frame - startFrame`；变换曲线的第 0 帧是片段头，`x/y` 为舞台单位、`rotation` 为度、`opacity` 为 0–1。曲线逐字段从基准值线性插值；尾裁不删除隐藏的关键帧，以保留区间最后一个可见帧之前的插值，并支持恢复尾长。
- 合成引擎、音频混音、导出由对应模块负责，工作台不执行脚本。素材快捷项写入安装模板的精确 ID/版本：图片、文字、方块和音效用 `allay.builtin.studio-object` 的对应类型，玩家用 `allay.builtin.player-motion` 和本地皮肤引用。音效对象加在独立轨道。资源档案是 ID，不是路径；片段覆盖工程档案。
- v2 文件只存模板/资源/皮肤引用，不存包或素材字节。图片文件令牌只在该电脑的应用数据目录解析为用户此前授权的路径；未知令牌、文件丢失或换机器时，片段保留 `unlinked-file:` 标记，须从属性面板点选图片重新授权。v1 顶层 `files` 仍兼容本机绝对图片路径。v2 不根据工程提供的新路径签发任何授权。
- `Workspace` 惰性发现 `features/authoring/CodeStudio.tsx` 的具名、无必传 props 的 `CodeStudio`。没有模块时不显示入口，普通时间轴与工作台不受影响。新建和保存走文件菜单；动画设置、重命名和删除空轨在时间轴的更多菜单里。选中片段后，检查器才显示内容、变换、时间与片段操作。「片段操作 → 片段设置」可覆写资源版本，并可切换内置素材对象类型；切换类型保留其它内容参数。

定向测试：`T-STUDIO.composition.test.ts` 校验帧语义、复制隔离、锁和撤销；`project-service.test.ts` 覆盖 v1/v2 往返和图片授权；`animation-studio.spec.ts` 覆盖工作台交互和重新打开。FFmpeg 透明度、真实剪辑软件验收仍走导出规格。

## 视觉减法的验证记录

- 参照 V4 和快速模板时间轴：同一列对齐帧刻度、轨道和播放头；点击或拖动标尺及空轨区域擦洗，也可在标尺上用方向键（Shift 十帧）、Home/End 或直接填帧。片段短到不足以显示名称或拖动边缘时，仍可用 Tab 选中并在「时间」页精确编辑。
- 定向 lint、渲染器类型检查、合成单测（4 项，`--pool=threads`）和桌面构建通过。完整 `pnpm build` 的模板构建及 Playwright worker 被本机 `spawn EPERM` 拦截；两条端到端用例只确认可发现，未跑到交互。
- 剩余验收：在 Windows CI 跑两条工作台用例及 `pnpm check`，并核看 1120×700 下中英文和两主题的实际视觉。未进行真实编码或剪辑软件回读。
