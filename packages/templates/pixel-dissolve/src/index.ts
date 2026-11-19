// T5 像素溶解 allay.builtin.pixel-dissolve（docs/04-templates.md 4.10）。
// 只用公开的模板接口：THREE 和所有辅助函数都从 ctx 拿，只从 template-sdk 做类型导入（4.9）。
//
// 整个模板是一个铺满舞台的着色器四边形。每格的阈值 h 在 setup 里用 ctx.random / ctx.noise2D 算好
// （坐标和种子的函数，不用时间），存进一张浮点贴图；着色器只按格子取阈值、和 uniform 里的进度比较。
import type { ParamValue, SetupContext, TemplateInstance, TemplateModule } from '@allay/template-sdk';
import { blockFaceTexture } from './util';

const num = (v: ParamValue | undefined, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const str = (v: ParamValue | undefined, fallback: string): string => (typeof v === 'string' ? v : fallback);

/** 阈值比较的余量：进度为 1 时阈值为 1 的格子也算过了 */
const EPS = 1e-3;

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform vec2 uStage;
uniform vec2 uOrigin;
uniform float uCell;
uniform vec2 uGrid;
uniform sampler2D uThresh;
uniform float uA;
uniform float uB;
uniform float uLeaving;
uniform float uReverse;
uniform float uWidth;
uniform vec3 uColor;
uniform vec3 uAccent;
uniform float uUseTex;
uniform sampler2D uTex;
uniform vec2 uTexRepeat;
uniform vec2 uTexOffset;
varying vec2 vUv;
void main() {
  vec2 p = (vUv - 0.5) * uStage;
  vec2 g = (p - uOrigin) / uCell;
  vec2 c = clamp(floor(g), vec2(0.0), uGrid - 1.0);
  float h = texelFetch(uThresh, ivec2(c), 0).r;
  bool accent;
  if (uLeaving < 0.5) {
    // 进入：h < A 的格子可见；离 A 不到 accentWidth 的是刚出现的
    if (!(h < uA)) discard;
    accent = uA - h < uWidth;
  } else {
    // 退出：h < B 的格子已经消失；离 B 不到 accentWidth 的是即将消失的
    float k = uReverse > 0.5 ? 1.0 - h : h;
    if (k < uB) discard;
    accent = k - uB < uWidth;
  }
  vec3 col;
  if (accent) col = uAccent;
  else if (uUseTex > 0.5) col = textureGrad(uTex, fract(g) * uTexRepeat + uTexOffset, dFdx(g) * uTexRepeat, dFdy(g) * uTexRepeat).rgb;
  else col = uColor;
  gl_FragColor = vec4(col, 1.0);
}
`;

const template: TemplateModule = {
  async setup(ctx: SetupContext): Promise<TemplateInstance> {
    const { THREE, stage, scene, params } = ctx;
    const W = stage.width;
    const H = stage.height;
    const cell = Math.max(1, num(params.cellSize, 60));
    const pattern = str(params.pattern, 'noise');
    const angle = (num(params.angle, 0) * Math.PI) / 180;
    const spread = num(params.spread, 0.3);
    const fill = str(params.fill, 'color');
    const accentWidth = Math.max(0, num(params.accentWidth, 0.06));
    const outReverse = params.outReverse === true;
    const inDuration = num(params.inDuration, 0.4);
    const hold = num(params.hold, 0.1);
    const outDuration = num(params.outDuration, 0.4);
    const ease = ctx.ease.from(params.easing);

    const duration = inDuration + hold + outDuration;
    const cutTime = inDuration + hold / 2;

    // 格子：行列数向上取整，整体居中。第 j 行从下往上数（与贴图的行序一致）
    const cols = Math.ceil(W / cell);
    const rows = Math.ceil(H / cell);
    const originX = (-cols * cell) / 2;
    const originY = (-rows * cell) / 2;
    const thresholds = new Float32Array(cols * rows);
    const raw = new Float64Array(cols * rows);
    const rng = ctx.random('cells');
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const halfDiag = Math.hypot(W, H) / 2;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const cx = originX + (i + 0.5) * cell;
        const cy = originY + (j + 0.5) * cell;
        // 噪声的尺度按设计单位取，和格子大小无关：换格子大小时图案的大轮廓不变
        const n = ctx.noise2D(cx / 360, cy / 360, 'pattern');
        let v: number;
        switch (pattern) {
          case 'random':
            v = rng.next();
            break;
          case 'sweep':
            v = (cx * dx + cy * dy) / halfDiag + spread * ctx.noise2D(cx / 240, cy / 240, 'spread');
            break;
          case 'radial':
            v = Math.hypot(cx, cy) / halfDiag + spread * ctx.noise2D(cx / 240, cy / 240, 'spread');
            break;
          default:
            v = n;
        }
        raw[j * cols + i] = v;
      }
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of raw) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    for (let k = 0; k < raw.length; k++) thresholds[k] = hi > lo ? (raw[k]! - lo) / (hi - lo) : 0;
    const threshTex = new THREE.DataTexture(thresholds, cols, rows, THREE.RedFormat, THREE.FloatType);
    threshTex.magFilter = THREE.NearestFilter;
    threshTex.minFilter = THREE.NearestFilter;
    threshTex.generateMipmaps = false;
    threshTex.needsUpdate = true;

    const fillTexture = fill === 'block' ? await blockFaceTexture(ctx, str(params.block, 'minecraft:obsidian')) : null;
    const uniforms = {
      uStage: { value: new THREE.Vector2(W, H) },
      uOrigin: { value: new THREE.Vector2(originX, originY) },
      uCell: { value: cell },
      uGrid: { value: new THREE.Vector2(cols, rows) },
      uThresh: { value: threshTex },
      uA: { value: 0 },
      uB: { value: 0 },
      uLeaving: { value: 0 },
      uReverse: { value: outReverse ? 1 : 0 },
      uWidth: { value: accentWidth },
      uColor: { value: new THREE.Color(str(params.color, '#0B0F13').slice(0, 7)) },
      uAccent: { value: new THREE.Color(str(params.accentColor, '#52CFF3').slice(0, 7)) },
      uUseTex: { value: fillTexture ? 1 : 0 },
      uTex: { value: fillTexture },
      uTexRepeat: { value: fillTexture?.repeat ?? new THREE.Vector2(1, 1) },
      uTexOffset: { value: fillTexture?.offset ?? new THREE.Vector2() },
    };
    const geometry = new THREE.PlaneGeometry(W, H);
    // transparent：走 Three 默认的 NormalBlending，画进缓冲的是预乘 alpha（02-engine.md 2.6）
    const material = new THREE.ShaderMaterial({ uniforms, vertexShader: VERTEX, fragmentShader: FRAGMENT, transparent: true });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    scene.add(mesh);

    // 时间窗（同 T1，docs/decisions.md M3“T1 的时间余量”）：首尾各留一帧，剪辑点前后各一帧保持铺满
    const pad = 1 / stage.fps;
    const inStart = Math.min(pad, inDuration / 2);
    const inEnd = Math.max(inStart + 1e-4, Math.min(inDuration, cutTime - pad));
    const outEnd = duration - Math.min(pad, outDuration / 2);
    const outStart = Math.min(Math.max(inDuration + hold, cutTime + pad), outEnd - 1e-4);
    const inLen = inEnd - inStart;
    const outLen = outEnd - outStart;

    const clamp01 = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x);
    const eased = (p: number) => (p <= 0 ? 0 : p >= 1 ? 1 : ease(p));
    // 进度 a、b 映射到阈值上：A = a(1 + w + ε)，B = b(1 + w + ε) − w。
    // a = 0 时没有格子可见；a = 1 时全部可见且没有一格还在 accent 区里（停留阶段是纯填充）；
    // b = 0 时没有格子在 accent 区里（与停留阶段衔接），b = 1 时全部消失。
    const span = 1 + accentWidth + EPS;

    return {
      duration,
      cutTime,
      update(t: number) {
        const leaving = t > cutTime;
        uniforms.uLeaving.value = leaving ? 1 : 0;
        uniforms.uA.value = leaving ? span : eased(clamp01((t - inStart) / inLen)) * span;
        uniforms.uB.value = leaving ? eased(clamp01((t - outStart) / outLen)) * span - accentWidth : -accentWidth;
      },
      dispose() {
        geometry.dispose();
        material.dispose();
        threshTex.dispose();
      },
    };
  },
};

export default template;
