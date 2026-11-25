// 体素雕塑（docs/decisions.md 官网 · 体素悦灵）：首屏方块拼成的体素悦灵、剪辑点的 ◆、开源一节的时间线。
// 它和背景的方块世界共用一个渲染器、一个场景、一部相机（world-scene.ts），画在清晰的那一层（层 1），
// 自己是一次实例化绘制（下摆半透明另一遍）：每块在每个形里的位置放进数据纹理，按进度在两个形之间飞，
// 重组一次触发、按时间播完（由中心长出、像素溶解、方块掉落、方块擦除）。形放进各节 data-voxel-slot 留的空白，
// 每帧按当前相机把框对到世界里。体素悦灵从应用那只 3D 悦灵的同一份模型和原版贴图精确生成（forms.ts）。
// 指针划过拨开方块、按下放出冲击波、在雕塑的框里按住拖动转它。不在任何形里的方块藏在相机周围的画面外一圈。
import { BLOCKS, resolveBlockFaces } from '@allay/assets';
import { ALLAY_PALETTE, ALLAY_PARTS, ALLAY_TEXTURE_SIZE } from '@allay/mascot/model';
import { BODY_VIEW, LIGHT_DIR, clipPose, partMatrices } from '@allay/mascot/rig';
import * as THREE from 'three';
import { mcGameVersion, mcTexture } from '../../../host/mc-pack';
import { ALLAY_BITS, FORM_INDEX, FORM_NAMES, TILES, allayVoxelCount, allayVoxels, cutForm, restForm, timelineForm, type AllayVoxels, type Form, type FormName } from './forms';

export type { FormName };

/**
 * 设备档位：决定体素悦灵最多切多细（每模型像素几格）和细尘有多少。实际的格数按首屏给它留的框有多高来定，
 * 让一格在屏幕上约 5.5 px（看得出是一块一块的方块），再按档位封顶：1440×900 上高档约 1.3 万块，2560×1440 约 2.8 万块
 */
export type Tier = 'high' | 'mid' | 'narrow' | 'software';
export const TIERS: Record<Tier, { kMax: number }> = {
  high: { kMax: 10 },
  mid: { kMax: 6 },
  narrow: { kMax: 4 },
  software: { kMax: 2 },
};

/**
 * 每模型像素（= 原版贴图的一个像素）切几格：悦灵约 11 个模型像素高，一格约 5.5 CSS px。
 * 取偶数：手臂侧面那种被拉伸的面上，贴图像素的边界也落在格子边界上（逐像素对得上）
 */
export function voxelsPerPixel(tier: Tier, slotHeight: number): number {
  return Math.max(2, Math.min(TIERS[tier].kMax, 2 * Math.round(slotHeight / 120)));
}

const PARTS = ALLAY_PARTS.length;
const ALLAY = FORM_INDEX.allay;

const F = FORM_NAMES.length;
const TEX_W = 256;
const TRAIL = 16;

/** 各形的重组方式（0 像素溶解、1 方块擦除、2 方块掉落、3 由中心长出）和时长 */
const STYLE: Record<FormName, { style: number; ms: number }> = {
  rest: { style: 0, ms: 1300 },
  allay: { style: 3, ms: 1800 },
  cut: { style: 2, ms: 1700 },
  timeline: { style: 1, ms: 1500 },
};

const VERT = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uPos;
uniform sampler2D uCol;
uniform sampler2D uMask;
uniform int uRows;
uniform int uFrom;
uniform int uTo;
uniform float uP;
uniform int uStyle;
uniform vec3 uOrigin[${F}];
uniform float uScale[${F}];
uniform vec2 uRot[${F}];
uniform vec4 uBounds[${F}];
uniform float uTime;
uniform float uDrift;
uniform float uAspect;
uniform vec4 uTrail[${TRAIL}];
uniform vec4 uShock[2];
uniform float uStirR;
uniform float uMaskOn;
uniform float uGemSpin;
uniform float uPlayX;
uniform float uFogNear;
uniform float uFogFar;
// 体素悦灵：每块 6 个面的贴图像素和标记、应用的骨架矩阵（全身取景，模型像素）、包围盒中心
uniform sampler2D uFaces;
uniform mat4 uParts[${PARTS}];
uniform vec2 uAllayCenter;
uniform float uOnlyAllay;
// 当前相机（不在任何形里的方块藏在它周围的画面外一圈）
uniform vec3 uCamPos;
uniform float uTanHalf;

attribute float aIndex;

varying vec3 vNormal;
varying vec2 vUv;
varying vec3 vColor;
flat varying float vTile;
varying float vFog;
varying float vGlow;
flat varying vec4 vFaces;
flat varying float vAllay;
flat varying float vAssembled;
varying vec3 vLocalN;
varying vec3 vPartPos;

const float PI = 3.14159265;

float hash(float n) { return fract(sin(n * 12.9898 + 4.1414) * 43758.5453); }

mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
mat3 axisAngle(vec3 n, float a) {
  float c = cos(a), s = sin(a), t = 1.0 - c;
  return mat3(t * n.x * n.x + c, t * n.x * n.y + s * n.z, t * n.x * n.z - s * n.y,
              t * n.x * n.y - s * n.z, t * n.y * n.y + c, t * n.y * n.z + s * n.x,
              t * n.x * n.z + s * n.y, t * n.y * n.z - s * n.x, t * n.z * n.z + c);
}

// 取实例 i 在形 f 里的那一块；不属于这个形（大小记为 −1）时取它在 rest 里的位置
void fetchForm(int f, int i, out vec4 p, out vec4 c, out bool obj) {
  p = vec4(0.0);
  c = vec4(0.0);
  ivec2 at = ivec2(i % ${TEX_W}, f * uRows + i / ${TEX_W});
  p = texelFetch(uPos, at, 0);
  c = texelFetch(uCol, at, 0);
  obj = f > 0 && p.w >= 0.0;
  if (!obj) {
    at.y = i / ${TEX_W};
    p = texelFetch(uPos, at, 0);
    c = texelFetch(uCol, at, 0);
  }
}

// 一块在世界里的位置、朝向和大小
vec3 place(int f, int i, bool obj, vec4 p, float code, float seed, vec3 axis, out mat3 R, out float s) {
  R = mat3(1.0);
  s = 0.0;
  vec3 w = vec3(0.0);
  if (!obj) {
    // rest：x、y 是视口的归一化坐标，按深度换算；看得见的细尘随（阻尼过的）滚动缓缓上漂，出了画面从另一头回来
    float dist = 16.0 - p.z;
    float hh = dist * uTanHalf;
    float v = p.y;
    if (p.w > 0.0) v = mod(v + uDrift * (9.0 / dist) + 1.25, 2.5) - 1.25;
    w = vec3(uCamPos.x + p.x * hh * uAspect, uCamPos.y + v * hh, uCamPos.z - dist);
    w.xy += vec2(sin(uTime * 0.13 + seed * 40.0), cos(uTime * 0.11 + seed * 31.0)) * 0.22;
    R = axisAngle(axis, seed * 6.2832 + uTime * (0.15 + seed * 0.35));
    s = p.w;
  } else if (f == ${ALLAY}) {
    // 体素悦灵：用应用的骨架矩阵摆姿态（部件坐标 → 全身取景坐标），再按指针、拖动转，放进首屏的框里
    vec4 fd = texelFetch(uFaces, ivec2(i % ${TEX_W}, i / ${TEX_W}), 0);
    int part = int(mod(floor(fd.x / 512.0), 8.0));
    mat4 M = uParts[part];
    vec3 posed = (M * vec4(p.xyz, 1.0)).xyz - vec3(uAllayCenter, 0.0);
    mat3 Rf = rotY(uRot[f].x) * rotX(uRot[f].y);
    R = Rf * mat3(M);
    s = p.w * uScale[f];
    w = uOrigin[f] + Rf * posed * uScale[f];
  } else {
    float part = floor(code / 32.0);
    vec3 l = p.xyz;
    mat3 Rp = mat3(1.0);
    if (part == 8.0) { Rp = rotY(uGemSpin); l = Rp * l; }
    else if (part == 9.0) { l.x += uPlayX; }
    mat3 Rf = rotY(uRot[f].x) * rotX(uRot[f].y);
    R = Rf * Rp;
    s = p.w * uScale[f];
    w = uOrigin[f] + Rf * l * uScale[f];
  }
  return w;
}

void main() {
  int i = int(aIndex + 0.5);
  float seed = hash(aIndex * 0.6180339 + 1.0);
  float seed2 = hash(aIndex * 1.3247 + 7.0);
  vec3 axis = normalize(vec3(hash(aIndex + 3.1), hash(aIndex + 5.7), hash(aIndex + 9.2)) - 0.5 + 1e-3);

  vec4 pb = vec4(0.0), cb = vec4(0.0);
  bool ob = false;
  fetchForm(uTo, i, pb, cb, ob);
  mat3 Rb = mat3(1.0);
  float sb = 0.0;
  vec3 b = place(uTo, i, ob, pb, cb.w, seed, axis, Rb, sb);

  bool allayA = false;
  vec3 a = vec3(0.0);
  mat3 Ra = mat3(1.0);
  float sa = 0.0;
  vec4 ca = vec4(0.0);
  vec4 pa = vec4(0.0);
  if (uFrom < 0) {
    // 种子：所有方块从目标形的中心、大小为 0 开始
    a = uOrigin[uTo]; Ra = Rb; sa = 0.0; ca = cb;
  } else {
    bool oa = false;
    fetchForm(uFrom, i, pa, ca, oa);
    a = place(uFrom, i, oa, pa, ca.w, seed, axis, Ra, sa);
    allayA = uFrom == ${ALLAY} && oa;
  }
  bool allayB = uTo == ${ALLAY} && ob;
  if (uFrom < 0) allayA = allayB;
  if (max(sa, sb) <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

  // 各块的先后（按目标形的局部坐标和重组方式）
  float d;
  if (!ob) d = seed * 0.85;
  else {
    vec4 bd = uBounds[uTo];
    float xn = clamp((pb.x - bd.x) / max(1e-3, bd.y - bd.x), 0.0, 1.0);
    float yn = clamp((pb.y - bd.z) / max(1e-3, bd.w - bd.z), 0.0, 1.0);
    if (uStyle == 1) d = xn * 0.88 + seed * 0.12;
    else if (uStyle == 2) d = xn * 0.5 + yn * 0.38 + seed * 0.12;
    else if (uStyle == 3) d = clamp(distance(b, uOrigin[uTo]) / max(1e-3, uScale[uTo] * 0.5 * max(bd.y - bd.x, bd.w - bd.z)), 0.0, 1.0) * 0.8 + seed * 0.2;
    else d = seed;
  }
  const float S = 0.55;
  float p = clamp((uP - d * S) / (1.0 - S), 0.0, 1.0);
  float e = p < 0.5 ? 4.0 * p * p * p : 1.0 - pow(-2.0 * p + 2.0, 3.0) / 2.0;
  float arc = sin(PI * e) * step(1e-3, distance(a, b));
  vec3 pos;
  if (uStyle == 2 && ob) {
    // 方块掉落：先飞到目标正上方，再带重力落下（最后一点有个小回弹）
    vec3 above = b + vec3(0.0, 5.0 + seed * 3.0, 1.0);
    if (p < 0.5) {
      float q = smoothstep(0.0, 1.0, p / 0.5);
      pos = mix(a, above, q);
      pos.z += sin(PI * q) * 2.0;
    } else {
      float q = (p - 0.5) / 0.5;
      pos = mix(above, b, q * q);
      pos.y += sin(clamp((q - 0.82) / 0.18, 0.0, 1.0) * PI) * 0.25 * (1.0 - q);
    }
    arc = p < 0.5 ? sin(PI * p) : 0.0;
  } else {
    vec3 side = normalize(cross(b - a, vec3(0.0, 0.0, 1.0)) + 1e-4);
    pos = mix(a, b, e) + (side * (seed2 - 0.5) * 3.2 + vec3(0.0, 0.0, 2.4 * seed)) * arc;
  }
  float s = mix(sa, sb, e) * (1.0 + 0.3 * arc);
  mat3 R = Ra * (1.0 - e) + Rb * e;
  R = axisAngle(axis, arc * 2.6 * (0.4 + seed)) * R;
  vec3 col = e < 0.5 ? ca.rgb : cb.rgb;
  vTile = mod(e < 0.5 ? ca.w : cb.w, 32.0);
  // 此刻显示的是不是体素悦灵的一块（飞到一半以前算出发的形，以后算目标形）
  bool showAllay = e < 0.5 ? allayA : allayB;
  vAllay = showAllay ? 1.0 : 0.0;
  vFaces = showAllay ? texelFetch(uFaces, ivec2(i % ${TEX_W}, i / ${TEX_W}), 0) : vec4(0.0);
  bool translucentNow = showAllay && mod(floor(vFaces.x / 4096.0), 2.0) > 0.5;
  bool thinNow = showAllay && mod(floor(vFaces.x / 8192.0), 2.0) > 0.5;
#ifdef TRANSLUCENT_PASS
  if (!translucentNow) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
#else
  if (translucentNow) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
#endif
  if (uOnlyAllay > 0.5 && !showAllay) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

  // 指针：在“视线角”空间里推开（与深度无关，屏幕上看起来一样大），往镜头这边抬一点、转一下
  vec4 vp = viewMatrix * vec4(pos, 1.0);
  float depth = -vp.z;
  vec2 q = vp.xy / depth;
  vec2 push = vec2(0.0);
  float glow = 0.0;
  for (int k = 0; k < ${TRAIL}; k++) {
    vec4 tr = uTrail[k];
    if (tr.z <= 0.0) continue;
    vec2 dd = q - tr.xy;
    float r2 = dot(dd, dd);
    float f = exp(-r2 / (uStirR * uStirR)) * tr.z;
    push += dd * inversesqrt(r2 + 1e-7) * f;
    glow += f * tr.w;
  }
  for (int k = 0; k < 2; k++) {
    vec4 sh = uShock[k];
    if (sh.w <= 0.0) continue;
    vec2 dd = q - sh.xy;
    float r = length(dd);
    float ring = (r - sh.z) / (uStirR * 0.8);
    float f = exp(-ring * ring) * sh.w;
    push += dd / max(r, 1e-4) * f * 1.6;
    glow += f * 0.7;
  }
  float amt = length(push);
  if (amt > 1.0) { push *= 1.0 / amt; amt = 1.0; }
  q += push * uStirR * 0.6;
  vp.xy = q * depth;
  vp.z += amt * 1.4;
  R = axisAngle(axis, amt * 1.6) * R;
  s *= 1.0 - amt * 0.3;
  // 拼到位、没被拨动：只画盒子表面上的面（和应用里那只一样，透过透明像素看到的是对面那一面）
  vAssembled = showAllay && e > 0.9999 && amt < 1e-4 ? 1.0 : 0.0;

  // 正文后面不放方块
  vec4 cc = projectionMatrix * vp;
  vec2 suv = cc.xy / cc.w * 0.5 + 0.5;
  float m = uMaskOn * textureLod(uMask, suv, 0.0).r;
  s *= 1.0 - smoothstep(0.08, 0.7, m);

  vec3 lp = position;
  if (thinNow) lp.x *= 0.002;
  vec4 mv = vp + vec4(mat3(viewMatrix) * (R * (lp * s)), 0.0);
  gl_Position = projectionMatrix * mv;
  vNormal = R * normal;
  vLocalN = normal;
  // 片元在部件坐标里的位置（体素的轴就是部件的轴）：片元着色器按应用那一面的映射算贴图坐标
  vec4 pAl = (e < 0.5 && uFrom >= 0) ? pa : pb;
  vPartPos = pAl.xyz + lp * pAl.w;
  vUv = uv;
  vColor = col;
  vGlow = clamp(glow, 0.0, 1.0);
  vFog = smoothstep(uFogNear, uFogFar, -mv.z) * 0.88;
}`;

const FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uAtlas;
uniform vec3 uFogColor;
uniform vec3 uKeyDir;
uniform vec3 uKeyCol;
uniform vec3 uSky;
uniform vec3 uGround;
uniform vec3 uGlowCol;
uniform sampler2D uAllayTex;
uniform sampler2D uFaceParams;
uniform vec3 uLightDir;

varying vec3 vNormal;
varying vec2 vUv;
varying vec3 vColor;
flat varying float vTile;
varying float vFog;
varying float vGlow;
flat varying vec4 vFaces;
flat varying float vAllay;
flat varying float vAssembled;
varying vec3 vLocalN;
varying vec3 vPartPos;

bool bit(float v, float b) { return mod(floor(v / b), 2.0) > 0.5; }

// 应用那一面的仿射映射（部件坐标 → 贴图坐标）取一个像素；这个方向没有面时 ok = false
vec4 sampleFace(int box, int d, vec3 X, out bool ok) {
  ivec2 at = ivec2(d * 4, box);
  vec4 t0 = texelFetch(uFaceParams, at, 0);
  vec4 t1 = texelFetch(uFaceParams, at + ivec2(1, 0), 0);
  vec4 t2 = texelFetch(uFaceParams, at + ivec2(2, 0), 0);
  vec4 t3 = texelFetch(uFaceParams, at + ivec2(3, 0), 0);
  ok = t2.w > 0.5;
  vec3 dd = X - t0.xyz;
  float sp = clamp(dot(dd, t1.xyz), 0.0, 1.0);
  float tp = clamp(dot(dd, t2.xyz), 0.0, 1.0);
  vec2 uv = t3.xy + sp * t3.zw + tp * vec2(t0.w, t1.w);
  ivec2 tx = clamp(ivec2(floor(uv)), ivec2(0), ivec2(${ALLAY_TEXTURE_SIZE - 1}));
  return ok ? texelFetch(uAllayTex, tx, 0) : vec4(0.0);
}

void main() {
  vec3 n = normalize(vNormal);
  if (vAllay > 0.5) {
    // 与应用里那只 3D 悦灵同样的着色：原版贴图的颜色 × 面的明暗（0.58 的环境光 + 0.42 的方向光，薄片两面都算）
    float flags = vFaces.x;
    int box = int(mod(floor(flags / 64.0), 8.0));
    bool thin = bit(flags, 8192.0);
#ifdef TRANSLUCENT_PASS
    float cutoff = 0.01;
#else
    float cutoff = 0.5;
#endif
    vec3 a = abs(vLocalN);
    int d = a.x > 0.5 ? (vLocalN.x > 0.0 ? 0 : 1) : a.y > 0.5 ? (vLocalN.y > 0.0 ? 2 : 3) : (vLocalN.z > 0.0 ? 4 : 5);
    bool surf = bit(flags, pow(2.0, float(d)));
    vec4 c = vec4(0.0);
    bool ok = false;
    if (surf) {
      // 薄片（翅膀）两边看到的都是后画的那一面（东，放在 +x），它透明的地方露出先画的那一面（西，放在 −x）
      c = sampleFace(box, thin ? 0 : d, vPartPos, ok);
      if (thin && (!ok || c.a < cutoff)) c = sampleFace(box, 1, vPartPos, ok);
    }
    if (!surf || !ok) {
      // 不在盒子表面上的面：拼到位时（以及半透明那一遍）不画；散开、被拨动时露出来，用这块的主像素
#ifdef TRANSLUCENT_PASS
      discard;
#else
      if (vAssembled > 0.5) discard;
#endif
      float t = vFaces.y - 1.0;
      c = texelFetch(uAllayTex, ivec2(int(mod(t, ${ALLAY_TEXTURE_SIZE}.0)), int(floor(t / ${ALLAY_TEXTURE_SIZE}.0))), 0);
      c.a = 1.0;
    }
    if (c.a < cutoff) discard;
    float ld = dot(n, uLightDir);
    ld = thin ? abs(ld) : max(ld, 0.0);
    vec3 lit = c.rgb * (0.58 + 0.42 * ld);
    lit = mix(lit, uGlowCol, vGlow * 0.55);
#ifdef TRANSLUCENT_PASS
    gl_FragColor = vec4(lit, c.a);
#else
    gl_FragColor = vec4(lit, 1.0);
#endif
    #include <colorspace_fragment>
    return;
  }
  vec2 uv = clamp(vUv, 0.002, 0.998);
  vec2 tuv = (vec2(mod(vTile, 8.0), 3.0 - floor(vTile / 8.0)) + uv) / vec2(8.0, 4.0);
  // 手算细化级别，最多到每格 1 个像素（第 4 级正好是一格的平均色，不和相邻的格子混）
  vec2 g = vUv * 16.0;
  vec2 dx = dFdx(g), dy = dFdy(g);
  float lod = clamp(0.5 * log2(max(dot(dx, dx), dot(dy, dy))), 0.0, 4.0);
  vec3 base = textureLod(uAtlas, tuv, lod).rgb * vColor;
  float key = max(dot(n, uKeyDir), 0.0);
  vec3 hemi = mix(uGround, uSky, n.y * 0.5 + 0.5);
  vec3 lit = base * (hemi + uKeyCol * key);
  vec2 ed = min(uv, 1.0 - uv);
  lit *= mix(0.8, 1.0, smoothstep(0.0, 0.16, min(ed.x, ed.y)));
  lit = mix(lit, uGlowCol, vGlow * 0.55);
  lit = mix(lit, uFogColor, vFog);
  gl_FragColor = vec4(lit, 1.0);
  #include <colorspace_fragment>
}`;

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface SculptureFrame {
  now: number;
  dt: number;
  vw: number;
  vh: number;
  /** 页面滚动位置（CSS 像素） */
  scroll: number;
  /** 该拼成哪个形（由页面按各节的占位框是否在视口里决定） */
  target: FormName;
  /** 各形的占位框（视口坐标）；不显示的为 null */
  slots: Partial<Record<FormName, Box | null>>;
  pointer: { x: number; y: number } | null;
  /** 指针轨迹：每 4 个数一个点（x、y 视口坐标，距今多少秒，速度 px/s），最近的在前 */
  trail: Float32Array;
  /** 冲击波：每 4 个数一个（x、y，距今多少秒，强度），最多两个 */
  shocks: Float32Array;
  /** 按住拖动转的角度（弧度） */
  drag: { yaw: number; pitch: number };
  /** 减少动效：直接到终态，不漂、不扇翅膀、不跟指针 */
  still: boolean;
  /** 正文在视口里的位置（每 4 个数一个框：左、上、右、下） */
  textRects: Float32Array | null;
}

/** 一张贴图（动画贴图只取第一帧） */
async function tileBitmap(id: string): Promise<ImageBitmap | null> {
  const def = BLOCKS[id];
  if (!def || !mcGameVersion) return null;
  const tex = resolveBlockFaces(def).faces.south.texture;
  const r = await mcTexture(tex);
  if (!r) return null;
  return createImageBitmap(new Blob([new Uint8Array(r.png)], { type: 'image/png' }));
}

function springTo(v: number, vel: number, target: number, omega: number, dt: number): [number, number] {
  const x = v - target;
  const e = Math.exp(-omega * dt);
  return [target + (x + (vel + omega * x) * dt) * e, (vel - omega * (vel + omega * x) * dt) * e];
}

/** 世界给雕塑的：当前相机、视口坐标 → z = 0 平面上的世界坐标、那个平面上一个 CSS 像素多长 */
export interface SculptureView {
  camera: THREE.PerspectiveCamera;
  toWorld(x: number, y: number, out: THREE.Vector3): THREE.Vector3;
  upp: number;
}

export class Sculpture {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  private readonly mat: THREE.ShaderMaterial;
  private readonly posTex: THREE.DataTexture;
  private readonly colTex: THREE.DataTexture;
  /** 体素悦灵每块 6 个面的贴图像素和标记 */
  private readonly faceTex: THREE.DataTexture;
  /** 原版悦灵贴图（32×32，与应用同一张）；没有时不拼体素悦灵 */
  private allayTex: THREE.DataTexture;
  /** 半透明的下摆另画一遍（混合、不写深度），只画这些实例 */
  private readonly translucent: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  private k = 6;
  /** 体素悦灵拼得出来（原版贴图装好了） */
  hasAllay = false;
  private readonly atlas: THREE.CanvasTexture;
  private readonly atlasCanvas: HTMLCanvasElement;
  private readonly mask: THREE.CanvasTexture;
  private readonly maskCanvas: HTMLCanvasElement;
  private maskSig = NaN;
  private readonly rows: number;
  readonly instances: number;
  private readonly forms: (Form | null)[] = new Array<Form | null>(F).fill(null);
  private theme: 'dark' | 'light' = 'dark';
  private t0 = 0;
  private disposed = false;
  // 重组：从哪个形（−1 是种子）到哪个形、进度、排着队的下一个
  private from = 0;
  private to = 0;
  private p = 1;
  private pending: number | null = null;
  private started = false;
  /** 各形的朝向（弹簧追目标） */
  private readonly rot = Array.from({ length: F }, () => ({ yaw: 0, pitch: 0, vy: 0, vp: 0 }));
  private drift = 0;
  private driftV = 0;
  /** 停下来了：没有在重组 */
  settled = false;
  /** 这一帧指针轨迹的总强度（测试和调试看指针有没有真的拨动方块） */
  stir = 0;
  /** 雕塑当前被拖着转了多少（弧度） */
  yaw = 0;
  private constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, n: number) {
    this.renderer = renderer;
    this.scene = scene;
    this.instances = n;
    this.rows = Math.ceil(n / TEX_W);
    const data = () => new Float32Array(TEX_W * this.rows * F * 4);
    const tex = (d: Float32Array) => {
      const t = new THREE.DataTexture(d, TEX_W, this.rows * F, THREE.RGBAFormat, THREE.FloatType);
      t.minFilter = THREE.NearestFilter;
      t.magFilter = THREE.NearestFilter;
      t.generateMipmaps = false;
      t.needsUpdate = true;
      return t;
    };
    this.posTex = tex(data());
    this.colTex = tex(data());
    this.faceTex = new THREE.DataTexture(new Float32Array(TEX_W * this.rows * 4), TEX_W, this.rows, THREE.RGBAFormat, THREE.FloatType);
    this.faceTex.minFilter = THREE.NearestFilter;
    this.faceTex.magFilter = THREE.NearestFilter;
    this.faceTex.generateMipmaps = false;
    this.faceTex.needsUpdate = true;
    // 还没设置的形：所有实例都不属于它（大小记为 −1）
    const pd = this.posTex.image.data as Float32Array;
    for (let i = TEX_W * this.rows; i < TEX_W * this.rows * F; i++) pd[i * 4 + 3] = -1;
    this.allayTex = new THREE.DataTexture(new Uint8Array(4), 1, 1);

    // 贴图集：先画纯色和噪点，原版贴图装好以后再画上去
    this.atlasCanvas = document.createElement('canvas');
    this.atlasCanvas.width = 128;
    this.atlasCanvas.height = 64;
    const g = this.atlasCanvas.getContext('2d')!;
    TILES.forEach((t, i) => {
      const x = (i % 8) * 16;
      const y = Math.floor(i / 8) * 16;
      g.fillStyle = t.fallback;
      g.fillRect(x, y, 16, 16);
      for (let py = 0; py < 16; py++) {
        for (let px = 0; px < 16; px++) {
          const v = Math.sin((i * 256 + py * 16 + px) * 12.9898) * 43758.5453;
          const r = v - Math.floor(v);
          g.fillStyle = r > 0.5 ? `rgba(255,255,255,${((r - 0.5) * 0.16).toFixed(3)})` : `rgba(0,0,0,${((0.5 - r) * 0.2).toFixed(3)})`;
          g.fillRect(x + px, y + py, 1, 1);
        }
      }
    });
    this.atlas = new THREE.CanvasTexture(this.atlasCanvas);
    this.atlas.colorSpace = THREE.SRGBColorSpace;
    this.atlas.magFilter = THREE.NearestFilter;
    this.atlas.minFilter = THREE.NearestMipmapLinearFilter;
    this.atlas.generateMipmaps = true;

    this.maskCanvas = document.createElement('canvas');
    this.maskCanvas.width = 192;
    this.maskCanvas.height = 108;
    this.mask = new THREE.CanvasTexture(this.maskCanvas);
    this.mask.minFilter = THREE.LinearFilter;
    this.mask.magFilter = THREE.LinearFilter;
    this.mask.generateMipmaps = false;

    const vec3s = () => Array.from({ length: F }, () => new THREE.Vector3());
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uPos: { value: this.posTex },
        uCol: { value: this.colTex },
        uMask: { value: this.mask },
        uAtlas: { value: this.atlas },
        uRows: { value: this.rows },
        uFrom: { value: 0 },
        uTo: { value: 0 },
        uP: { value: 1 },
        uStyle: { value: 0 },
        uOrigin: { value: vec3s() },
        uScale: { value: new Array<number>(F).fill(1) },
        uRot: { value: Array.from({ length: F }, () => new THREE.Vector2()) },
        uBounds: { value: Array.from({ length: F }, () => new THREE.Vector4(-1, 1, -1, 1)) },
        uTime: { value: 0 },
        uDrift: { value: 0 },
        uAspect: { value: 1 },
        uTrail: { value: Array.from({ length: TRAIL }, () => new THREE.Vector4()) },
        uShock: { value: [new THREE.Vector4(), new THREE.Vector4()] },
        uStirR: { value: 0.03 },
        uMaskOn: { value: 1 },
        uGemSpin: { value: 0 },
        uPlayX: { value: 0 },
        uFogNear: { value: 22 },
        uFogFar: { value: 72 },
        uFogColor: { value: new THREE.Color(0x0b0b0c) },
        uKeyDir: { value: new THREE.Vector3(-0.45, 0.75, 0.55).normalize() },
        uKeyCol: { value: new THREE.Color(0xffffff) },
        uSky: { value: new THREE.Color(0xffffff) },
        uGround: { value: new THREE.Color(0x222222) },
        uGlowCol: { value: new THREE.Color(0xffffff) },
        uFaces: { value: this.faceTex },
        uParts: { value: Array.from({ length: PARTS }, () => new THREE.Matrix4()) },
        uAllayCenter: { value: new THREE.Vector2() },
        uOnlyAllay: { value: 0 },
        uAllayTex: { value: this.allayTex },
        uFaceParams: { value: null },
        uLightDir: { value: new THREE.Vector3(...LIGHT_DIR) },
        uCamPos: { value: new THREE.Vector3(0, 0, 16) },
        uTanHalf: { value: Math.tan((30 * Math.PI) / 360) },
      },
    });
    const box = new THREE.BoxGeometry(1, 1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = box.index;
    geo.setAttribute('position', box.getAttribute('position'));
    geo.setAttribute('normal', box.getAttribute('normal'));
    geo.setAttribute('uv', box.getAttribute('uv'));
    geo.setAttribute('aIndex', new THREE.InstancedBufferAttribute(Float32Array.from({ length: n }, (_, i) => i), 1));
    geo.instanceCount = n;
    // 双面：和应用里那只一样（透明像素后面能看到对面的面、薄片两面都画）
    this.mat.side = THREE.DoubleSide;
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    // 层 1 是世界里清晰的那一层；层 3 只有雕塑（对比检查时单独画它）
    this.mesh.layers.set(1);
    this.mesh.layers.enable(3);
    this.scene.add(this.mesh);
    // 半透明那一遍：同一套 uniform、同一份几何（只换实例列表），在不透明的之后画
    const tgeo = new THREE.InstancedBufferGeometry();
    tgeo.index = box.index;
    tgeo.setAttribute('position', box.getAttribute('position'));
    tgeo.setAttribute('normal', box.getAttribute('normal'));
    tgeo.setAttribute('uv', box.getAttribute('uv'));
    // 按全部实例的长度预先分配（three 按第一次绑定时的长度定实例数的上限，之后换属性不会改）
    tgeo.setAttribute('aIndex', new THREE.InstancedBufferAttribute(new Float32Array(n), 1));
    tgeo.instanceCount = 0;
    const tmat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: this.mat.uniforms, defines: { TRANSLUCENT_PASS: 1 }, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    this.translucent = new THREE.Mesh(tgeo, tmat);
    this.translucent.frustumCulled = false;
    this.translucent.renderOrder = 1;
    this.translucent.layers.set(1);
    this.translucent.layers.enable(3);
    this.scene.add(this.translucent);
  }

  /** 按档位建好各个形；n 是实例数（最大的形） */
  static create(renderer: THREE.WebGLRenderer, scene: THREE.Scene, opts: { theme: 'dark' | 'light'; tier: Tier; slotHeight: number }): Sculpture {
    const k = voxelsPerPixel(opts.tier, opts.slotHeight);
    // 实例数按体素悦灵最多可能有多少块留（贴图装好后透明像素只会让块数变少）；剪辑点和时间线按同样的格数缩放
    const allayMax = allayVoxelCount(k);
    const kk = Math.max(3, Math.round(k * 0.9));
    const cut = cutForm(kk, 1e9);
    const timeline = timelineForm(kk, 1e9);
    const n = Math.max(allayMax, cut.count, timeline.count);
    const w = new Sculpture(renderer, scene, n);
    w.k = k;
    w.theme = opts.theme;
    w.setForm(FORM_INDEX.rest, restForm(n, 0));
    w.setForm(FORM_INDEX.cut, cut);
    w.setForm(FORM_INDEX.timeline, timeline);
    w.applyTheme();
    void w.loadAtlas();
    return w;
  }

  private setForm(fi: number, form: Form): void {
    this.forms[fi] = form;
    const pos = this.posTex.image.data as Float32Array;
    const col = this.colTex.image.data as Float32Array;
    const base = fi * this.rows * TEX_W * 4;
    const n = Math.min(form.count, this.instances);
    pos.set(form.pos.subarray(0, n * 4), base);
    col.set(form.col.subarray(0, n * 4), base);
    for (let i = n; i < this.rows * TEX_W; i++) {
      pos[base + i * 4 + 3] = -1;
    }
    this.posTex.needsUpdate = true;
    this.colTex.needsUpdate = true;
    (this.mat.uniforms.uBounds!.value as THREE.Vector4[])[fi]!.set(...form.bounds);
  }

  private async loadAtlas(): Promise<void> {
    const g = this.atlasCanvas.getContext('2d')!;
    await Promise.all(
      TILES.map(async (t, i) => {
        if (!t.id) return;
        const bmp = await tileBitmap(t.id).catch(() => null);
        if (!bmp || this.disposed) return;
        g.clearRect((i % 8) * 16, Math.floor(i / 8) * 16, 16, 16);
        g.drawImage(bmp, 0, 0, bmp.width, bmp.width, (i % 8) * 16, Math.floor(i / 8) * 16, 16, 16);
        bmp.close();
      }),
    );
    if (this.disposed) return;
    this.atlas.needsUpdate = true;
  }

  setTheme(theme: 'dark' | 'light', bg: string): void {
    this.theme = theme;
    (this.mat.uniforms.uFogColor!.value as THREE.Color).setStyle(bg, THREE.SRGBColorSpace);
    this.applyTheme();
  }

  private applyTheme(): void {
    const light = this.theme === 'light';
    const u = this.mat.uniforms;
    (u.uKeyCol!.value as THREE.Color).setRGB(...((light ? [0.62, 0.6, 0.57] : [0.78, 0.76, 0.72]) as [number, number, number]));
    (u.uSky!.value as THREE.Color).setRGB(...((light ? [0.62, 0.66, 0.7] : [0.42, 0.47, 0.54]) as [number, number, number]));
    (u.uGround!.value as THREE.Color).setRGB(...((light ? [0.36, 0.36, 0.38] : [0.1, 0.11, 0.13]) as [number, number, number]));
    (u.uGlowCol!.value as THREE.Color).set(light ? ALLAY_PALETTE.light : ALLAY_PALETTE.highlight);
    u.uFogNear!.value = light ? 18 : 22;
    u.uFogFar!.value = light ? 64 : 72;
  }

  /**
   * 原版悦灵贴图（与应用同一张）：装好后按它把体素悦灵精确地生成出来（透明的像素按应用的规则丢掉），
   * 之后首屏才拼体素悦灵。也给测试用：传一张合成的贴图，和应用的烘焙渲染器并排对比
   */
  setAllayTexture(img: ImageData): void {
    const S = ALLAY_TEXTURE_SIZE;
    const scale = img.width / S;
    const px = new Uint8Array(S * S * 4);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const at = (Math.floor(y * scale) * img.width + Math.floor(x * scale)) * 4;
        px.set(img.data.subarray(at, at + 4), (y * S + x) * 4);
      }
    }
    const tex = new THREE.DataTexture(px, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this.allayTex.dispose();
    this.allayTex = tex;
    this.mat.uniforms.uAllayTex!.value = tex;
    const form: AllayVoxels = allayVoxels(this.k, this.instances, (u, v) => px[(v * S + u) * 4 + 3]! / 255);
    this.setForm(ALLAY, form);
    const faces = this.faceTex.image.data as Float32Array;
    faces.fill(0);
    faces.set(form.faces.subarray(0, Math.min(form.count, this.instances) * 4));
    this.faceTex.needsUpdate = true;
    (this.mat.uniforms.uAllayCenter!.value as THREE.Vector2).set(...form.center);
    // 各盒子各面的映射（片元着色器按它算贴图坐标）
    const params = new THREE.DataTexture(form.faceParams, 24, form.boxes, THREE.RGBAFormat, THREE.FloatType);
    params.minFilter = THREE.NearestFilter;
    params.magFilter = THREE.NearestFilter;
    params.generateMipmaps = false;
    params.needsUpdate = true;
    (this.mat.uniforms.uFaceParams!.value as THREE.Texture | null)?.dispose();
    this.mat.uniforms.uFaceParams!.value = params;
    // 半透明那一遍只画下摆的实例
    const list: number[] = [];
    for (let i = 0; i < form.count; i++) if ((form.faces[i * 4]! & ALLAY_BITS.translucent) !== 0) list.push(i);
    const tgeo = this.translucent.geometry;
    const attr = tgeo.getAttribute('aIndex') as THREE.InstancedBufferAttribute;
    (attr.array as Float32Array).fill(0).set(list.slice(0, attr.count));
    attr.needsUpdate = true;
    tgeo.instanceCount = Math.min(list.length, attr.count);
    this.hasAllay = true;
  }

  /** 当前（或正在拼向）的形 */
  get form(): FormName {
    return FORM_NAMES[this.to]!;
  }

  /** 每帧：算各形的位置、朝向、重组进度、指针，写进 uniform（画由世界来画） */
  update(f: SculptureFrame, view: SculptureView): void {
    if (this.disposed) return;
    this.t0 ||= f.now;
    const t = f.still ? 0 : (f.now - this.t0) / 1000;
    const dt = f.dt;
    const u = this.mat.uniforms;
    // 没有原版悦灵贴图时拼不出体素悦灵（不拿近似的颜色凑），首屏散成细尘
    const target = f.target === 'allay' && !this.hasAllay ? FORM_INDEX.rest : FORM_INDEX[f.target];

    // 重组：一次触发后按时间播完；途中目标又变了就排队，并把当前这次加速播完（快速跳过时很快到终态）
    if (!this.started) {
      this.started = true;
      this.to = target;
      this.from = target === FORM_INDEX.rest || f.still ? target : -1;
      this.p = f.still || target === FORM_INDEX.rest ? 1 : 0;
    } else if (target !== this.to) {
      if (this.p >= 1 || f.still) this.begin(target, f.still);
      else this.pending = target;
    } else if (this.pending !== null) this.pending = null;
    const style = STYLE[FORM_NAMES[this.to]!];
    const rate = this.pending !== null ? 3.2 : this.from < 0 ? 0.85 : 1;
    if (!f.still) this.p = Math.min(1, this.p + ((dt * 1000) / style.ms) * rate);
    if (this.p >= 1 && this.pending !== null) {
      const next = this.pending;
      this.pending = null;
      this.begin(next, false);
    }
    this.settled = this.p >= 1 && this.pending === null;

    // 各形放到页面上给它留的框里（视口坐标 → 世界），朝向跟指针、跟拖动
    const upp = view.upp;
    const tanHalf = Math.tan((view.camera.fov * Math.PI) / 360);
    (u.uCamPos!.value as THREE.Vector3).copy(view.camera.position);
    u.uTanHalf!.value = tanHalf;
    const origins = u.uOrigin!.value as THREE.Vector3[];
    const scales = u.uScale!.value as number[];
    const rots = u.uRot!.value as THREE.Vector2[];
    const active = (fi: number) => fi === this.to || fi === this.from || fi === this.pending;
    for (const name of ['allay', 'cut', 'timeline'] as const) {
      const fi = FORM_INDEX[name];
      const form = this.forms[fi];
      const box = f.slots[name];
      if (!form || !box || !active(fi)) continue;
      const fw = form.bounds[1] - form.bounds[0];
      const fh = form.bounds[3] - form.bounds[2];
      const pxPerUnit = Math.min(box.width / fw, box.height / fh) * 0.92;
      scales[fi] = pxPerUnit * upp;
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      view.toWorld(cx, cy, origins[fi]!);
      // 朝向：看向指针（悦灵转头最明显），加上拖动
      const look = f.pointer && !f.still ? { x: Math.max(-1, Math.min(1, (f.pointer.x - cx) / (f.vw * 0.45))), y: Math.max(-1, Math.min(1, (f.pointer.y - cy) / (f.vh * 0.6))) } : { x: 0, y: 0 };
      const mine = fi === this.to;
      const dragYaw = mine ? f.drag.yaw : 0;
      const dragPitch = mine ? f.drag.pitch : 0;
      let yawT: number;
      let pitchT: number;
      if (name === 'allay') {
        // 默认就是应用全身图集的取景（朝右并朝镜头转 28°、俯角 8°，由骨架矩阵给出），这里只加转头看指针和拖动
        yawT = look.x * 0.5 + dragYaw;
        pitchT = look.y * 0.22 + dragPitch;
      } else if (name === 'cut') {
        yawT = look.x * 0.3 + dragYaw;
        pitchT = 0.14 + look.y * 0.12 + dragPitch;
      } else {
        yawT = -0.3 + look.x * 0.14 + dragYaw;
        pitchT = 0.44 + look.y * 0.1 + dragPitch * 0.5;
      }
      const r = this.rot[fi]!;
      if (f.still) {
        r.yaw = yawT;
        r.pitch = pitchT;
      } else {
        [r.yaw, r.vy] = springTo(r.yaw, r.vy, yawT, 5, dt);
        [r.pitch, r.vp] = springTo(r.pitch, r.vp, Math.max(-0.6, Math.min(0.9, pitchT)), 5, dt);
      }
      rots[fi]!.set(r.yaw, r.pitch);
      if (mine) this.yaw = r.yaw;
    }
    // 细尘随滚动缓缓上漂（阻尼过的滚动位置，以视口高为单位）
    const scrollVh = f.scroll / f.vh;
    if (f.still) this.drift = scrollVh;
    else [this.drift, this.driftV] = springTo(this.drift, this.driftV, scrollVh, 3, dt);

    // 指针轨迹和冲击波（视口坐标 → “视线角”空间：x、y 除以深度）
    const toTan = (x: number, y: number, out: THREE.Vector4) => out.set(((x / f.vw) * 2 - 1) * tanHalf * (f.vw / f.vh), (1 - (y / f.vh) * 2) * tanHalf, 0, 0);
    const trail = u.uTrail!.value as THREE.Vector4[];
    this.stir = 0;
    for (let k = 0; k < TRAIL; k++) {
      const v = trail[k]!;
      const at = k * 4;
      if (f.still || at + 3 >= f.trail.length) {
        v.set(0, 0, 0, 0);
        continue;
      }
      const age = f.trail[at + 2]!;
      const speed = f.trail[at + 3]!;
      const strength = Math.exp(-age * 2.4) * (0.55 + 0.45 * Math.min(1, speed / 1400)) * 0.34;
      if (strength < 0.01) {
        v.set(0, 0, 0, 0);
        continue;
      }
      toTan(f.trail[at]!, f.trail[at + 1]!, v);
      v.z = strength;
      v.w = Math.min(1, speed / 2200) ** 1.3 * 1.6;
      this.stir += strength;
    }
    const shocks = u.uShock!.value as THREE.Vector4[];
    for (let k = 0; k < 2; k++) {
      const v = shocks[k]!;
      const at = k * 4;
      if (f.still || at + 3 >= f.shocks.length || f.shocks[at + 3]! <= 0) {
        v.set(0, 0, 0, 0);
        continue;
      }
      const age = f.shocks[at + 2]!;
      toTan(f.shocks[at]!, f.shocks[at + 1]!, v);
      v.z = ((age * 1100) / f.vh) * 2 * tanHalf; // 环的半径：每秒扩 1100 px
      v.w = age > 1.4 ? 0 : Math.exp(-age * 1.8) * f.shocks[at + 3]!;
    }
    u.uStirR!.value = (78 / f.vh) * 2 * tanHalf;

    // 正文遮罩（框变了才重画、重新上传）
    this.updateMask(f);

    u.uFrom!.value = this.from;
    u.uTo!.value = this.to;
    u.uP!.value = this.p;
    u.uStyle!.value = style.style;
    u.uTime!.value = t;
    u.uDrift!.value = this.drift;
    u.uAspect!.value = f.vw / f.vh;
    // 体素悦灵的姿态：应用的 hover 动作（与图集同一套骨架和动作；减少动效时停在第 0 帧，就是图集的第一帧）
    if (this.hasAllay) this.setPose(f.still ? 0 : t * 30);
    u.uGemSpin!.value = f.still ? 0.5 : t * 0.6;
    const tl = this.forms[FORM_INDEX.timeline];
    u.uPlayX!.value = tl?.playWidth ? (((t * 0.06) % 1) - 0.5) * tl.playWidth : 0;

  }

  private setPose(frame: number): void {
    const mats = partMatrices(clipPose('hover', frame), { kind: 'body' });
    const parts = this.mat.uniforms.uParts!.value as THREE.Matrix4[];
    ALLAY_PARTS.forEach((part, i) => parts[i]!.fromArray(mats[part.name]));
  }

  /**
   * 只给测试用：按应用全身图集的取景（正交、半边长 BODY_VIEW.half 个模型像素、hover 第 frame 帧、不转头）
   * 画出拼好的体素悦灵，读回 size×size 的 RGBA（从上到下一行行）。拿去和应用烘焙出的图集同一帧并排对比
   */
  renderAllayReference(size: number, frame: number): Uint8Array | null {
    if (!this.hasAllay) return null;
    const u = this.mat.uniforms;
    const origins = u.uOrigin!.value as THREE.Vector3[];
    const scales = u.uScale!.value as number[];
    const rots = u.uRot!.value as THREE.Vector2[];
    const center = u.uAllayCenter!.value as THREE.Vector2;
    const saved = { origin: origins[ALLAY]!.clone(), scale: scales[ALLAY]!, rot: rots[ALLAY]!.clone(), center: center.clone() };
    u.uFrom!.value = ALLAY;
    u.uTo!.value = ALLAY;
    u.uP!.value = 1;
    u.uOnlyAllay!.value = 1;
    u.uMaskOn!.value = 0;
    origins[ALLAY]!.set(0, 0, 0);
    scales[ALLAY] = 1;
    rots[ALLAY]!.set(0, 0);
    center.set(0, 0);
    for (const v of u.uTrail!.value as THREE.Vector4[]) v.set(0, 0, 0, 0);
    for (const v of u.uShock!.value as THREE.Vector4[]) v.set(0, 0, 0, 0);
    this.setPose(frame);
    const h = BODY_VIEW.half;
    const cam = new THREE.OrthographicCamera(-h, h, h, -h, 1, 100);
    cam.position.set(0, 0, 50);
    // 只画雕塑（层 3），背景的方块不进来
    cam.layers.set(3);
    // 与应用的导出渲染同一条路：2 倍超采样画进线性、预乘的浮点缓冲，2×2 取平均，反预乘后转 sRGB
    const ss = 2;
    const big = size * ss;
    const rt = new THREE.WebGLRenderTarget(big, big, { type: THREE.FloatType, depthBuffer: true, samples: 0 });
    const r = this.renderer;
    r.setRenderTarget(rt);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, true);
    r.render(this.scene, cam);
    const f = new Float32Array(big * big * 4);
    r.readRenderTargetPixels(rt, 0, 0, big, big, f);
    r.setRenderTarget(null);
    rt.dispose();
    const srgb = (c: number) => {
      const x = Math.min(1, Math.max(0, c));
      return x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055;
    };
    const out = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const acc = [0, 0, 0, 0];
        for (let dy = 0; dy < ss; dy++) {
          for (let dx = 0; dx < ss; dx++) {
            // 浮点缓冲从下往上
            const at = ((big - 1 - (y * ss + dy)) * big + x * ss + dx) * 4;
            for (let c = 0; c < 4; c++) acc[c]! += f[at + c]!;
          }
        }
        const a = Math.min(1, acc[3]! / (ss * ss));
        const o = (y * size + x) * 4;
        for (let c = 0; c < 3; c++) out[o + c] = Math.round(srgb(acc[c]! / (ss * ss) / Math.max(a, 1e-5)) * 255);
        out[o + 3] = Math.round(a * 255);
      }
    }
    u.uOnlyAllay!.value = 0;
    u.uMaskOn!.value = 1;
    origins[ALLAY]!.copy(saved.origin);
    scales[ALLAY] = saved.scale;
    rots[ALLAY]!.copy(saved.rot);
    center.copy(saved.center);
    return out;
  }

  private begin(target: number, still: boolean): void {
    this.from = this.to;
    this.to = target;
    this.p = still ? 1 : 0;
  }

  private updateMask(f: SculptureFrame): void {
    const rects = f.textRects;
    let sig = rects ? rects.length : 0;
    if (rects) for (let i = 0; i < rects.length; i++) sig = (sig * 31 + Math.round(rects[i]! / 4)) % 1e9;
    if (sig === this.maskSig) return;
    this.maskSig = sig;
    const g = this.maskCanvas.getContext('2d')!;
    const W = this.maskCanvas.width;
    const H = this.maskCanvas.height;
    g.clearRect(0, 0, W, H);
    if (rects && rects.length) {
      g.filter = 'blur(2px)';
      g.fillStyle = '#fff';
      for (let i = 0; i < rects.length; i += 4) {
        const x0 = (rects[i]! / f.vw) * W;
        const y0 = (rects[i + 1]! / f.vh) * H;
        g.fillRect(x0, y0, ((rects[i + 2]! - rects[i]!) / f.vw) * W, ((rects[i + 3]! - rects[i + 1]!) / f.vh) * H);
      }
      g.filter = 'none';
    }
    this.mask.needsUpdate = true;
  }

  dispose(): void {
    this.disposed = true;
    this.mesh.geometry.dispose();
    this.mat.dispose();
    this.posTex.dispose();
    this.colTex.dispose();
    this.faceTex.dispose();
    this.allayTex.dispose();
    this.translucent.geometry.dispose();
    this.translucent.material.dispose();
    this.atlas.dispose();
    this.mask.dispose();
    (this.mat.uniforms.uFaceParams!.value as THREE.Texture | null)?.dispose();
    this.scene.remove(this.mesh, this.translucent);
  }
}

let cachedSoftware: boolean | null = null;
function isSoftwareWebgl(): boolean {
  if (cachedSoftware !== null) return cachedSoftware;
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) {
      cachedSoftware = false;
      return false;
    }
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    cachedSoftware = /SwiftShader|Basic Render Driver|WARP|llvmpipe|Software/i.test(renderer);
  } catch {
    cachedSoftware = false;
  }
  return cachedSoftware;
}

/** 档位：软件光栅化（CI WARP / SwiftShader）、窄屏、核少内存小的设备、其余 */
export function pickTier(): Tier {
  if (isSoftwareWebgl()) return 'software';
  if (window.innerWidth < 1024 || matchMedia('(pointer: coarse)').matches) return 'narrow';
  const nav = navigator as Navigator & { deviceMemory?: number };
  if ((navigator.hardwareConcurrency || 8) <= 4 || (nav.deviceMemory ?? 8) <= 4) return 'mid';
  return 'high';
}
