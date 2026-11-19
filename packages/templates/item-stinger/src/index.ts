// T3 物品飞掠 allay.builtin.item-stinger（docs/04-templates.md 4.10）。
// 只用公开的模板接口：THREE 和所有辅助函数都从 ctx 拿，只从 template-sdk 做类型导入（4.9）。
//
// 色带、像素阶梯、条纹由一个铺满舞台的着色器四边形画出来：每个片元在“沿运动方向”的局部坐标里
// 判断自己在前沿和后沿之间（盖住）、在后沿之后的条纹里，还是露出来。着色器只读 uniform，不用时间和随机。
import type { ParamValue, SetupContext, TemplateInstance, TemplateModule } from '@allay/template-sdk';
import { blockFaceTexture, parseColor } from './util';

const num = (v: ParamValue | undefined, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const str = (v: ParamValue | undefined, fallback: string): string => (typeof v === 'string' ? v : fallback);

/** 前后沿的斜率：边界线是 x = e + y × SLOPE（局部坐标），阶梯就是这条斜线量化到格子上 */
const SLOPE = 0.4;

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform vec2 uStage;
uniform vec2 uDir;
uniform float uLead;
uniform float uTrail;
uniform float uPixel;
uniform float uSlope;
uniform float uStairs;
uniform float uUseTex;
uniform vec3 uColor;
uniform sampler2D uTex;
uniform float uTile;
uniform vec2 uTexRepeat;
uniform vec2 uTexOffset;
uniform vec4 uStripeA;
uniform vec4 uStripeB;
varying vec2 vUv;
void main() {
  // 舞台坐标（设计单位，原点在中心，+y 向上），再转到沿运动方向的局部坐标
  vec2 p = (vUv - 0.5) * uStage;
  float lx = dot(p, uDir);
  float ly = dot(p, vec2(-uDir.y, uDir.x));
  if (uStairs > 0.5) {
    lx = (floor(lx / uPixel) + 0.5) * uPixel;
    ly = (floor(ly / uPixel) + 0.5) * uPixel;
  }
  float e = lx - ly * uSlope;
  if (e < uLead && e > uTrail) {
    if (uUseTex > 0.5) {
      // 方块贴图按 tileSize 平铺（相对舞台固定）；用连续坐标的导数取 mipmap，避免 fract 接缝处跳级
      vec2 uv = p / uTile;
      gl_FragColor = vec4(textureGrad(uTex, fract(uv) * uTexRepeat + uTexOffset, dFdx(uv) * uTexRepeat, dFdy(uv) * uTexRepeat).rgb, 1.0);
    } else {
      gl_FragColor = vec4(uColor, 1.0);
    }
    return;
  }
  // 后沿之后的两条细条纹：A 在 [后沿 − 2 格, 后沿 − 1 格)，B 在 [后沿 − 4 格, 后沿 − 3 格)
  float d = uTrail - e;
  if (d >= uPixel && d < 2.0 * uPixel) { gl_FragColor = uStripeA; return; }
  if (d >= 3.0 * uPixel && d < 4.0 * uPixel) { gl_FragColor = uStripeB; return; }
  discard;
}
`;

const template: TemplateModule = {
  async setup(ctx: SetupContext): Promise<TemplateInstance> {
    const { THREE, stage, scene, params } = ctx;
    const W = stage.width;
    const H = stage.height;
    const itemId = str(params.item, 'minecraft:diamond_sword');
    const image = str(params.image, '');
    const angle = (num(params.angle, 0) * Math.PI) / 180;
    const fill = str(params.fill, 'color');
    const tileSize = Math.max(1, num(params.tileSize, 120));
    const stairs = str(params.edge, 'stairs') === 'stairs';
    const pixel = Math.max(1, num(params.pixelSize, 60));
    const itemScale = num(params.itemScale, 0.6);
    const itemLead = num(params.itemLead, 0.15);
    const spin = num(params.spin, 1);
    const inDuration = num(params.inDuration, 0.45);
    const hold = num(params.hold, 0.08);
    const outDuration = num(params.outDuration, 0.45);
    const volume = num(params.volume, 0.7);
    const ease = ctx.ease.from(params.easing);

    const duration = inDuration + hold + outDuration;
    const cutTime = inDuration + hold / 2;

    // 色带：铺满舞台的着色器四边形
    const dir = new THREE.Vector2(Math.cos(angle), Math.sin(angle));
    let fillTexture = null;
    if (fill === 'block') fillTexture = await blockFaceTexture(ctx, str(params.fillBlock, 'minecraft:lapis_block'));
    const stripe = (v: ParamValue | undefined, fallback: string) => {
      const c = parseColor(str(v, fallback));
      const col = new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
      return new THREE.Vector4(col.r, col.g, col.b, c[3]);
    };
    const uniforms = {
      uStage: { value: new THREE.Vector2(W, H) },
      uDir: { value: dir },
      uLead: { value: 0 },
      uTrail: { value: 0 },
      uPixel: { value: pixel },
      uSlope: { value: SLOPE },
      uStairs: { value: stairs ? 1 : 0 },
      uUseTex: { value: fillTexture ? 1 : 0 },
      uColor: { value: new THREE.Color(str(params.fillColor, '#2072D5').slice(0, 7)) },
      uTex: { value: fillTexture },
      uTexRepeat: { value: fillTexture?.repeat ?? new THREE.Vector2(1, 1) },
      uTexOffset: { value: fillTexture?.offset ?? new THREE.Vector2() },
      uTile: { value: tileSize },
      uStripeA: { value: stripe(params.stripeA, '#52CFF3') },
      uStripeB: { value: stripe(params.stripeB, '#F2F4F6') },
    };
    const bandGeometry = new THREE.PlaneGeometry(W, H);
    // transparent：走 Three 默认的 NormalBlending，画进缓冲的是预乘 alpha（02-engine.md 2.6）
    const bandMaterial = new THREE.ShaderMaterial({ uniforms, vertexShader: VERTEX, fragmentShader: FRAGMENT, transparent: true });
    const band = new THREE.Mesh(bandGeometry, bandMaterial);
    band.frustumCulled = false;
    scene.add(band);

    // 物品（或用户图片）：高 itemScale × 舞台高，放在色带前面
    const itemHeight = itemScale * H;
    const holder = new THREE.Object3D();
    let itemRadius: number;
    const tex = image === '' ? null : await ctx.resources.optionalTexture(image);
    if (tex) {
      const img = tex.image as { width?: number; height?: number } | null;
      const aspect = img?.width && img.height ? (img.width * tex.repeat.x) / (img.height * tex.repeat.y) : 1;
      const sprite = ctx.sprite.create(tex);
      sprite.setSize(itemHeight * aspect, itemHeight);
      holder.add(sprite.object);
      itemRadius = (itemHeight * Math.hypot(1, aspect)) / 2;
    } else {
      if (image !== '') ctx.warn(ctx.locale.startsWith('zh') ? '自定义图片不可用，仍使用原选物品。' : 'The custom image is unavailable. Using the previously selected item.');
      const item = (await ctx.resources.item(itemId)).single();
      item.scale.setScalar(itemHeight);
      holder.add(item);
      itemRadius = (itemHeight * Math.SQRT2) / 2;
    }
    holder.position.z = Math.max(W, H) * 0.5;
    scene.add(holder);

    // 前后沿的行程（局部坐标 e = lx − ly × SLOPE）。e 是线性函数，舞台上的极值在四个角上；阶梯量化让 e 最多再偏
    // (1 + SLOPE) / 2 格 < 1 格，留 1 格余量。所以 e ≥ E 时整块舞台都在前沿之后，e ≤ −E 时都在后沿之前。
    let eMax = 0;
    for (const [cx, cy] of [[W / 2, H / 2], [W / 2, -H / 2], [-W / 2, H / 2], [-W / 2, -H / 2]] as const) {
      eMax = Math.max(eMax, Math.abs(cx * dir.x + cy * dir.y - (-cx * dir.y + cy * dir.x) * SLOPE));
    }
    const E = eMax + pixel;
    // 舞台沿运动方向的半宽：物品中心的 |lx| ≥ S + 半径时整个在画外
    const S = (Math.abs(dir.x) * W + Math.abs(dir.y) * H) / 2;
    // 物品中心在前沿前方 itemLead × 高 + 半径处。前沿出发时色带和物品都在画外；前沿到终点时色带盖满、物品已出画
    const ahead = itemLead * H + itemRadius;
    const leadFrom = Math.min(-E, -S - itemRadius - ahead);
    const leadTo = Math.max(E, S + itemRadius - ahead);
    // 后沿走到终点时条纹（最远在后沿后 4 格）也要出画
    const trailFrom = -E;
    const trailTo = E + 4 * pixel;

    // 时间窗（同 T1，docs/decisions.md M3“T1 的时间余量”）：首尾各留一帧，剪辑点前后各一帧保持铺满
    const pad = 1 / stage.fps;
    const inStart = Math.min(pad, inDuration / 2);
    const inEnd = Math.max(inStart + 1e-4, Math.min(inDuration, cutTime - pad));
    const outEnd = duration - Math.min(pad, outDuration / 2);
    const outStart = Math.min(Math.max(inDuration + hold, cutTime + pad), outEnd - 1e-4);
    const inLen = inEnd - inStart;
    const outLen = outEnd - outStart;

    // 音效：t = 0 播放（4.10）
    if (typeof params.sound === 'string') ctx.audio.cue(params.sound, 0, { gain: volume });

    const clamp01 = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x);
    const eased = (p: number) => (p <= 0 ? 0 : p >= 1 ? 1 : ease(p));

    return {
      duration,
      cutTime,
      update(t: number) {
        const a = eased(clamp01((t - inStart) / inLen));
        const b = t <= cutTime ? 0 : eased(clamp01((t - outStart) / outLen));
        const lead = a >= 1 ? leadTo : leadFrom + (leadTo - leadFrom) * a;
        uniforms.uLead.value = lead;
        uniforms.uTrail.value = b <= 0 ? trailFrom : trailFrom + (trailTo - trailFrom) * b;
        // 物品走在前沿前方，以 spin 圈每秒自转（正值顺时针）
        const x = lead + ahead;
        holder.position.x = dir.x * x;
        holder.position.y = dir.y * x;
        holder.rotation.z = -2 * Math.PI * spin * t;
      },
      dispose() {
        bandGeometry.dispose();
        bandMaterial.dispose();
      },
    };
  },
};

export default template;
