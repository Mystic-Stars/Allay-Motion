// T6 进度提示 allay.builtin.advancement-toast（docs/04-templates.md 4.10）。叠加层：没有剪辑点，cutTime 为 null。
// 只用公开的模板接口：THREE 和所有辅助函数都从 ctx 拿，只从 template-sdk 做类型导入（4.9）。
//
// 布局以“界面像素”计（面板原生 160×32），一个界面像素 = g 个设计单位。
import type { ParamValue, SetupContext, TemplateInstance, TemplateModule } from '@allay/template-sdk';
import { setupVersionedToast, toastProfile } from './versioned';
import { setupBedrockAchievement } from './bedrock';

const num = (v: ParamValue | undefined, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const str = (v: ParamValue | undefined, fallback: string): string => (typeof v === 'string' ? v : fallback);

const PANEL_TEXTURE = 'minecraft:gui/sprites/toast/advancement';
const PANEL_W = 160;
const PANEL_H = 32;
/** 图标：左上角 (8, 8)，16×16 */
const ICON_X = 8;
const ICON_Y = 8;
const ICON_SIZE = 16;
/** 文字左边界和右侧留白 */
const TEXT_X = 30;
const TEXT_RIGHT = 8;
/** 原版字体（约 8 像素高）时两行文字的上边界 */
const HEADER_Y = 7;
const TITLE_Y = 18;
const HEADER_DEFAULT = '#FFFF55';
/** frame 决定的标题行默认颜色：挑战是粉色，其余黄色（与游戏一致） */
const FRAME_COLOR: Record<string, string> = { task: '#FFFF55', goal: '#FFFF55', challenge: '#FF88FF' };

const template: TemplateModule = {
  async setup(ctx: SetupContext): Promise<TemplateInstance> {
    const { THREE, stage, scene, params } = ctx;
    if (params.toastStyle === 'bedrockAchievement') return setupBedrockAchievement(ctx);
    const profile = toastProfile(params.toastStyle);
    if (profile) return setupVersionedToast(ctx, profile);
    const W = stage.width;
    const H = stage.height;
    const frame = str(params.frame, 'task');
    const headerColorParam = str(params.headerColor, HEADER_DEFAULT);
    const headerColor = headerColorParam === HEADER_DEFAULT ? (FRAME_COLOR[frame] ?? HEADER_DEFAULT) : headerColorParam;
    const anchor = str(params.anchor, 'topRight');
    const guiScale = Math.max(1, Math.round(num(params.guiScale, 4)));
    const margin = Math.max(0, num(params.margin, 0));
    const inDuration = num(params.inDuration, 0.25);
    const hold = num(params.hold, 2.5);
    const outDuration = num(params.outDuration, 0.25);
    const volume = num(params.volume, 0.8);
    const duration = inDuration + hold + outDuration;

    // 文字先按 guiScale 建好，量出以界面像素计的尺寸（文字的宽高与字号成正比）
    const header = ctx.text.create({ text: str(params.header, ''), font: str(params.headerFont, 'minecraft:default'), size: guiScale, color: headerColor, align: 'left' });
    const title = ctx.text.create({ text: str(params.title, ''), font: str(params.titleFont, 'minecraft:default'), size: guiScale, color: str(params.titleColor, '#FFFFFF'), align: 'left' });
    const hw = header.width / guiScale;
    const hh = header.height / guiScale;
    const tw = title.width / guiScale;
    const th = title.height / guiScale;

    // 面板：文字太长时向右加宽（九宫格拉伸）；文字比原版字体高（兜底的像素字体）时两行重新均分、必要时加高
    const panelW = Math.max(PANEL_W, Math.ceil(TEXT_X + Math.max(hw, tw) + TEXT_RIGHT));
    let headerTop = HEADER_Y;
    let titleTop = TITLE_Y;
    let panelH = PANEL_H;
    if (headerTop + hh > titleTop || titleTop + th > PANEL_H - 3) {
      panelH = Math.max(PANEL_H, Math.ceil(hh + th + 9));
      const gap = (panelH - hh - th) / 3;
      headerTop = gap;
      titleTop = 2 * gap + hh;
    }

    // 实际缩放：面板放不进舞台（扣掉边距）时按比例缩小，三种画幅都成立
    const g = Math.max(0.1, Math.min(guiScale, (W - 2 * margin) / panelW, (H - 2 * margin) / panelH));
    const k = g / guiScale;
    const pw = panelW * g;
    const ph = panelH * g;

    const toast = new THREE.Object3D();
    scene.add(toast);
    const panel = ctx.sprite.create(await ctx.resources.texture(PANEL_TEXTURE), { pixelSize: g });
    panel.setSize(pw, ph);
    toast.add(panel.object);
    // 子物体的坐标以面板左上角为原点（+y 向上，所以界面像素的 y 取负）
    const at = (obj: InstanceType<typeof THREE.Object3D>, x: number, y: number, z: number) => {
      obj.position.set(-pw / 2 + x * g, ph / 2 - y * g, z);
      toast.add(obj);
    };
    const icon = (await ctx.resources.item(str(params.icon, 'minecraft:diamond'))).single();
    icon.scale.setScalar(ICON_SIZE * g);
    at(icon, ICON_X + ICON_SIZE / 2, ICON_Y + ICON_SIZE / 2, 2);
    // 文字的原点：水平在左边，垂直在中线
    header.object.scale.setScalar(k);
    title.object.scale.setScalar(k);
    at(header.object, TEXT_X, headerTop + hh / 2, 3);
    at(title.object, TEXT_X, titleTop + th / 2, 3);

    // 停靠位置；滑入滑出沿水平方向，画外的位置让面板整个在舞台边缘之外
    const right = anchor === 'topRight' || anchor === 'bottomRight';
    const top = anchor === 'topRight' || anchor === 'topLeft';
    const restX = right ? W / 2 - margin - pw / 2 : -W / 2 + margin + pw / 2;
    const awayX = right ? W / 2 + pw / 2 + 1 : -W / 2 - pw / 2 - 1;
    toast.position.y = top ? H / 2 - margin - ph / 2 : -H / 2 + margin + ph / 2;

    // 时间窗：首尾各留一帧（同 T1 的理由：子帧最多偏离帧时刻 ±0.5/fps），所以首末帧面板整个在画外
    const pad = 1 / stage.fps;
    const inStart = Math.min(pad, inDuration / 2);
    const inLen = inDuration - inStart;
    const outStart = inDuration + hold;
    const outLen = duration - Math.min(pad, outDuration / 2) - outStart;

    if (typeof params.sound === 'string') ctx.audio.cue(params.sound, 0, { gain: volume });

    const clamp01 = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x);
    const easeIn = ctx.ease.quadOut;
    const easeOut = ctx.ease.quadIn;

    return {
      duration,
      cutTime: null,
      update(t: number) {
        const a = clamp01((t - inStart) / inLen);
        const b = clamp01((t - outStart) / outLen);
        // 在画面上的程度：1 = 停在停靠位置，0 = 整个在画外
        const shown = b > 0 ? (b >= 1 ? 0 : 1 - easeOut(b)) : a >= 1 ? 1 : a <= 0 ? 0 : easeIn(a);
        toast.position.x = shown >= 1 ? restX : awayX + (restX - awayX) * shown;
      },
    };
  },
};

export default template;
