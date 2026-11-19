// T4 加载界面 allay.builtin.loading-screen（docs/04-templates.md 4.10）。
// 只用公开的模板接口：THREE 和所有辅助函数都从 ctx 拿，只从 template-sdk 做类型导入（4.9）。
//
// 背景是一组实例化的方块（正交相机、不加面明暗，只看得见朝向相机的那一面），以 tileSize 平铺并整体染成 dim 倍的亮度；
// 这样资源包换了贴图、方块的面用哪张贴图都由引擎的方块目录决定，模板不需要知道。
import type { ParamValue, SetupContext, TemplateInstance, TemplateModule, TextObject } from '@allay/template-sdk';
import { loadingProfile, setupVersionedLoading } from './versioned';
import { isBedrockLoading, setupBedrockLoading } from './bedrock';

const num = (v: ParamValue | undefined, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const str = (v: ParamValue | undefined, fallback: string): string => (typeof v === 'string' ? v : fallback);

type Style = 'fade' | 'slideUp' | 'dissolve';
const style = (v: ParamValue | undefined): Style => (v === 'slideUp' || v === 'dissolve' ? v : 'fade');

/** 文字行之间的间距、文字和进度条之间的间距（字体像素） */
const GAP = 6;
/** 进度条的高度和边框（字体像素） */
const BAR_HEIGHT = 3;
const BAR_BORDER = 1;
/** 阈值比较的余量：进度为 1 时阈值为 1 的格子也算过了 */
const EPS = 1e-3;

const template: TemplateModule = {
  async setup(ctx: SetupContext): Promise<TemplateInstance> {
    const { THREE, stage, scene, params } = ctx;
    if (isBedrockLoading(params.loadingStyle)) return setupBedrockLoading(ctx, params.loadingStyle);
    const profile = loadingProfile(params.loadingStyle);
    if (profile) return setupVersionedLoading(ctx, profile);
    const W = stage.width;
    const H = stage.height;
    const blockId = str(params.block, 'minecraft:dirt');
    const dim = Math.min(1, Math.max(0, num(params.dim, 0.25)));
    const tile = Math.max(1, num(params.tileSize, 128));
    const title = str(params.title, 'Loading world');
    const subtitle = str(params.subtitle, '');
    const textColor = str(params.textColor, '#FFFFFF');
    const u = num(params.textScale, 5);
    const showBar = params.showBar !== false;
    const barColor = str(params.barColor, '#55FF55');
    const inStyle = style(params.inStyle);
    const outStyle = style(params.outStyle);
    const inDuration = num(params.inDuration, 0.3);
    const hold = num(params.hold, 0.9);
    const outDuration = num(params.outDuration, 0.3);
    const cutAt = Math.min(1, Math.max(0, num(params.cutAt, 0.5)));

    const duration = inDuration + hold + outDuration;
    const cutTime = inDuration + hold * cutAt;

    // 背景：tileSize 的方块铺满舞台（行列数向上取整、居中），染成 dim（sRGB 里乘，和游戏一样）
    const nx = Math.ceil(W / tile);
    const ny = Math.ceil(H / tile);
    const count = nx * ny;
    const tx = new Float64Array(count);
    const ty = new Float64Array(count);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        tx[k] = (i - (nx - 1) / 2) * tile;
        ty[k] = ((ny - 1) / 2 - j) * tile;
      }
    }
    const tiles = (await ctx.resources.block(blockId, { shading: false })).instanced(count);
    const tint = new THREE.Color().setRGB(dim, dim, dim, THREE.SRGBColorSpace);
    for (let k = 0; k < count; k++) tiles.setTint(k, tint);
    scene.add(tiles.object);

    // 像素溶解：每格一个阈值 h ∈ [0, 1]（随机加噪声，再归一化），同 T5 的做法
    const thresholds = new Float64Array(count);
    if (inStyle === 'dissolve' || outStyle === 'dissolve') {
      const rng = ctx.random('dissolve');
      let lo = Infinity;
      let hi = -Infinity;
      for (let k = 0; k < count; k++) {
        const v = 0.5 * rng.next() + 0.25 * (ctx.noise2D(tx[k]! / 600, ty[k]! / 600, 'dissolve') + 1);
        thresholds[k] = v;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      for (let k = 0; k < count; k++) thresholds[k] = hi > lo ? (thresholds[k]! - lo) / (hi - lo) : 0;
    }

    // 前景：标题、副标题、进度条，竖直方向整体居中。都放在方块前面（方块的正面在 z = tile / 2）
    const front = new THREE.Object3D();
    front.position.z = tile;
    scene.add(front);
    const texts: TextObject[] = [];
    const maxWidth = W * 0.9;
    const titleObj = ctx.text.create({ text: title, font: str(params.titleFont, 'minecraft:default'), size: u, color: textColor, shadow: true, align: 'center', maxWidth });
    texts.push(titleObj);
    titleObj.object.position.z = 3;
    const subtitleObj = subtitle.trim() !== '' ? ctx.text.create({ text: subtitle, font: str(params.subtitleFont, 'minecraft:default'), size: u, color: textColor, shadow: true, align: 'center', maxWidth }) : null;
    if (subtitleObj) {
      texts.push(subtitleObj);
      subtitleObj.object.position.z = 3;
    }
    const barW = Math.min(W * 0.7, 100 * u);
    const barH = BAR_HEIGHT * u;
    const barOuterH = barH + 2 * BAR_BORDER * u;
    const stackH = titleObj.height + (subtitleObj ? GAP * u + subtitleObj.height : 0) + (showBar ? GAP * u + barOuterH : 0);
    let y = stackH / 2;
    titleObj.object.position.y = y - titleObj.height / 2;
    y -= titleObj.height;
    front.add(titleObj.object);
    if (subtitleObj) {
      y -= GAP * u;
      subtitleObj.object.position.y = y - subtitleObj.height / 2;
      y -= subtitleObj.height;
      front.add(subtitleObj.object);
    }

    // 进度条：外框（文字颜色）、底（黑）、填充（barColor），各一个四边形
    const quad = new THREE.PlaneGeometry(1, 1);
    const materials: InstanceType<typeof THREE.MeshBasicMaterial>[] = [];
    const rect = (color: string, w: number, h: number, cy: number, z: number) => {
      const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color.slice(0, 7)), transparent: true });
      materials.push(mat);
      const mesh = new THREE.Mesh(quad, mat);
      mesh.scale.set(w, h, 1);
      mesh.position.set(0, cy, z);
      front.add(mesh);
      return mesh;
    };
    let fill: InstanceType<typeof THREE.Mesh> | null = null;
    if (showBar) {
      y -= GAP * u;
      const cy = y - barOuterH / 2;
      rect(textColor, barW + 2 * BAR_BORDER * u, barOuterH, cy, 0);
      rect('#000000', barW, barH, cy, 1);
      fill = rect(barColor, barW, barH, cy, 2);
    }

    // 时间窗（同 T1，docs/decisions.md M3“T1 的时间余量”）：首尾各留一帧，剪辑点前后各一帧保持铺满。
    // 剪辑点可以在停留阶段的任意位置（cutAt），所以进入阶段在 min(inDuration, cutTime − 1/fps) 前结束，
    // 退出阶段在 max(inDuration + hold, cutTime + 1/fps) 后开始。
    const pad = 1 / stage.fps;
    const inStart = Math.min(pad, inDuration / 2);
    const inEnd = Math.max(inStart + 1e-4, Math.min(inDuration, cutTime - pad));
    const outEnd = duration - Math.min(pad, outDuration / 2);
    const outStart = Math.min(Math.max(inDuration + hold, cutTime + pad), outEnd - 1e-4);
    const inLen = inEnd - inStart;
    const outLen = outEnd - outStart;

    // slideUp 的位移：整屏（含超出画面的文字）完全移出画面
    const slide = H + tile + stackH;
    const slideIn = ctx.ease.cubicOut;
    const slideOut = ctx.ease.cubicIn;

    const m = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3(tile, tile, tile);
    const clamp01 = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x);

    return {
      duration,
      cutTime,
      update(t: number) {
        const entering = t <= cutTime;
        // 阶段进度：进入时 0 → 1 为出现，退出时 0 → 1 为消失
        const phase = entering ? clamp01((t - inStart) / inLen) : clamp01((t - outStart) / outLen);
        const st = entering ? inStyle : outStyle;
        // 出现的程度（1 = 完全出现）
        const shown = entering ? phase : 1 - phase;
        let offset = 0;
        let opacity = 1;
        if (st === 'fade') opacity = shown;
        else if (st === 'slideUp') {
          if (entering) offset = phase >= 1 ? 0 : -slide * (1 - slideIn(phase));
          else offset = phase <= 0 ? 0 : slide * slideOut(phase);
        } else opacity = shown; // dissolve：方块逐格出现，文字和进度条跟着淡入淡出

        for (let k = 0; k < count; k++) {
          let a = opacity;
          if (st === 'dissolve') {
            // 进入：h < 进度的格子可见；退出：h < 进度的格子消失
            const h = thresholds[k]!;
            a = entering ? (h < phase * (1 + EPS) ? 1 : 0) : h < phase * (1 + EPS) ? 0 : 1;
          }
          tiles.setOpacity(k, a);
          pos.set(tx[k]!, ty[k]! + offset, 0);
          m.compose(pos, quat, scl);
          tiles.setMatrix(k, m);
        }
        tiles.commit();

        front.position.y = offset;
        for (const text of texts) text.setOpacity(opacity);
        for (const mat of materials) mat.opacity = opacity;
        if (fill) {
          // 进度条在停留阶段从 0 走到 100%
          const progress = clamp01((t - inDuration) / hold);
          fill.visible = progress > 0;
          fill.scale.x = barW * progress;
          fill.position.x = (-barW + barW * progress) / 2;
        }
      },
      dispose() {
        quad.dispose();
        for (const mat of materials) mat.dispose();
      },
    };
  },
};

export default template;
