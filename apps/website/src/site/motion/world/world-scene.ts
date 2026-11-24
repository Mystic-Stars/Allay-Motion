// 全页共用的一块 3D 方块世界（docs/decisions.md 官网 · 画布、· 磁吸方块）：一个 WebGL 上下文、一个渲染循环，固定在所有内容后面。
// - 每一节是这个世界里的一个“机位”（一串竖着排开的方块群）。走到哪一节由滚动位置决定，相机用弹簧自己飞过去，
//   中途的方块从身边掠过；停手也会飞到终态，不绑滚动位置逐帧；
// - 光：环境光 + 白色主光 + 品牌蓝的轮廓光 + 一盏跟着指针走的点光（场景光照是内容，不做泛光和光柱）；
// - 景深：方块分远、中、近三层，远近两层画进半分辨率的离屏缓冲、两遍高斯模糊后合成；
// - 能玩：指针经过时方块不动（只在能抓的那块上稍微放大一点）；点一下方块把它敲碎（碎块带重力掉下去），几秒后长回来；
// - 磁吸：按住方块拖动，手里这块是磁铁，紧跟指针、转正到一套固定的网格上，松手后留在那里轻轻浮着。屏幕上和它
//   （或它那一组里的任何一块）差不多平齐、在它左右几块以内的方块被吸过来：越近越快地朝它飞，途中转正、深度和大小
//   过渡到和它一致，最后“啪”地贴在它的左面或右面（从哪边来贴哪边，被占了就顺着往外排），棱对棱、角对角；
//   贴上就和它成了一组，跟手一起走，还能继续吸。用力甩动时甩脱最外面那块，双击一块把它从组里弹出去；
// - 首屏方块拼成的体素悦灵、剪辑点的 ◆、开源一节的时间线由体素雕塑来画（sculpture.ts），和这里共用渲染器和相机；
// - 页尾的字标由方块拼成：对齐 DOM 里那段字的位置，走到页尾时方块从四面飞进来拼好，也能推、能敲；
// - 悦灵在这个空间里飞（应用同一份烘焙图集画在一块面片上），会被近处的方块挡住。
// 贴图来自官网专用的原版贴图（public/mc/），没有提取时用纯色。three 与引擎同一版本。这个模块懒加载。
import { BLOCKS, resolveBlockFaces, type Face } from '@allay/assets';
import * as THREE from 'three';
import { mcGameVersion, mcTexture } from '../../../host/mc-pack';
import { Sculpture, type SculptureFrame, type Tier } from './sculpture';

export { pickTier, type Box, type FormName, type SculptureFrame, type Tier } from './sculpture';

type Layer = 0 | 1 | 2; // 远、中（焦平面）、近

interface Spec {
  x: number;
  y: number;
  z: number;
  s: number;
  id: string;
}

/** 一个机位的方块群（宽屏的构图；首屏原样，其余机位镜像、抽稀） */
const SPECS: Spec[] = [
  { x: 4.7, y: 2.5, z: -0.6, s: 1.1, id: 'minecraft:diamond_block' },
  { x: 6.6, y: 0.6, z: 0.6, s: 0.62, id: 'minecraft:sea_lantern' },
  { x: 2.7, y: 3.5, z: -2.2, s: 0.56, id: 'minecraft:amethyst_block' },
  { x: -7.9, y: -3.9, z: 0.4, s: 0.86, id: 'minecraft:crafting_table' },
  { x: -1.6, y: -4.6, z: -1.4, s: 0.52, id: 'minecraft:tnt' },
  { x: 0.6, y: -0.6, z: -3.4, s: 0.42, id: 'minecraft:gold_block' },
  { x: 5.9, y: 4.0, z: -3.4, s: 0.48, id: 'minecraft:packed_ice' },
  { x: -1.2, y: 4.1, z: -3.8, s: 0.42, id: 'minecraft:glowstone' },
  { x: 7.6, y: -1.8, z: -2.4, s: 0.78, id: 'minecraft:deepslate_bricks' },
  { x: -8.4, y: 3.7, z: -2.6, s: 0.58, id: 'minecraft:lapis_block' },
  { x: 1.4, y: -4.4, z: -0.8, s: 0.46, id: 'minecraft:copper_block' },
  { x: -2.6, y: 1.4, z: -9, s: 1.4, id: 'minecraft:obsidian' },
  { x: 3.2, y: -1.0, z: -10, s: 1.6, id: 'minecraft:deepslate_bricks' },
  { x: -8.4, y: -0.8, z: -11, s: 1.5, id: 'minecraft:diamond_block' },
  { x: 9.0, y: 3.6, z: -12, s: 1.8, id: 'minecraft:amethyst_block' },
  { x: 0.4, y: 4.8, z: -13, s: 1.6, id: 'minecraft:packed_ice' },
  { x: -5.2, y: 4.9, z: -10, s: 1.2, id: 'minecraft:crying_obsidian' },
  { x: 1.6, y: -4.8, z: -9, s: 1.3, id: 'minecraft:emerald_block' },
  { x: 10.4, y: -4.2, z: -11, s: 1.4, id: 'minecraft:sea_lantern' },
  { x: -11, y: 3.2, z: -13, s: 1.6, id: 'minecraft:lapis_block' },
  { x: -7.4, y: -5.3, z: 4.4, s: 1.5, id: 'minecraft:diamond_block' },
  { x: 7.2, y: 4.6, z: 3.8, s: 1.2, id: 'minecraft:amethyst_block' },
];

const EMISSIVE = new Set(['minecraft:sea_lantern', 'minecraft:glowstone', 'minecraft:crying_obsidian']);
const FALLBACK: Record<string, string> = {
  'minecraft:diamond_block': '#52D6DC',
  'minecraft:sea_lantern': '#A9DCD3',
  'minecraft:amethyst_block': '#9B85E8',
  'minecraft:crafting_table': '#9C6B3C',
  'minecraft:tnt': '#C2362F',
  'minecraft:gold_block': '#F2C94C',
  'minecraft:packed_ice': '#9CC3F5',
  'minecraft:glowstone': '#F3C969',
  'minecraft:deepslate_bricks': '#4A4A50',
  'minecraft:lapis_block': '#2F5DB8',
  'minecraft:copper_block': '#C8734A',
  'minecraft:obsidian': '#22183A',
  'minecraft:crying_obsidian': '#3A1F66',
  'minecraft:emerald_block': '#3FBF6F',
  'minecraft:quartz_block': '#ECE6DE',
  'minecraft:black_concrete': '#141518',
};
/** 字标的方块：深色主题石英块（偶尔一块钻石块），浅色主题黑色混凝土（偶尔一块青金石） */
const LETTER_IDS = { dark: ['minecraft:quartz_block', 'minecraft:diamond_block'], light: ['minecraft:black_concrete', 'minecraft:lapis_block'] } as const;

/** 机位之间在世界里竖着隔多远 */
export const STATION_GAP = 64;
/** 每个机位的相机（相对机位中心）和方块密度：首屏最满，正文多的几节稀一些 */
const CAMS: { p: [number, number, number]; l: [number, number, number]; density: number; mirror: boolean }[] = [
  { p: [0, 0, 16], l: [0, 0, 0], density: 1, mirror: false }, // 首屏
  { p: [-1.5, 0.5, 17], l: [1.5, 0, 0], density: 0.75, mirror: true }, // 工作流
  { p: [0, 0, 22], l: [0, 0, 0], density: 0.45, mirror: false }, // 剪辑点
  { p: [2, 1, 26], l: [0, 0, 0], density: 0.35, mirror: true }, // 试用
  { p: [-2, 1.5, 20], l: [0, 0, 0], density: 0.5, mirror: false }, // 模板
  { p: [2, -1, 20], l: [0, 0, 0], density: 0.5, mirror: true }, // 特性
  { p: [0, 0, 18], l: [0, 0, 0], density: 0.6, mirror: false }, // 开源
  { p: [0, 0.5, 16], l: [0, 0, 0], density: 0.7, mirror: true }, // 页尾
];
export const STATION_COUNT = CAMS.length;

const layerOf = (z: number): Layer => (z < -5 ? 0 : z > 2.5 ? 2 : 1);

function h01(n: number, seed: number): number {
  let x = Math.imul(n + 1, 2654435761) ^ Math.imul(seed + 7, 1597334677);
  x = Math.imul(x ^ (x >>> 15), 2246822519);
  x = Math.imul(x ^ (x >>> 13), 3266489917);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

const BOX_FACES: Face[] = ['east', 'west', 'up', 'down', 'south', 'north'];

/** 一张贴图（动画贴图只取第一帧）和它的平均色（碎块用） */
async function faceTexture(id: string): Promise<{ tex: THREE.Texture; avg: THREE.Color } | null> {
  const r = await mcTexture(id);
  if (!r) return null;
  const bitmap = await createImageBitmap(new Blob([new Uint8Array(r.png)], { type: 'image/png' }));
  const w = bitmap.width;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = w;
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(bitmap, 0, 0, w, w, 0, 0, w, w);
  bitmap.close();
  const px = g.getImageData(0, 0, w, w).data;
  let rr = 0;
  let gg = 0;
  let bb = 0;
  let n = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3]! < 128) continue;
    rr += px[i]!;
    gg += px[i + 1]!;
    bb += px[i + 2]!;
    n++;
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestMipmapLinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const avg = new THREE.Color().setRGB(rr / n / 255, gg / n / 255, bb / n / 255, THREE.SRGBColorSpace);
  return { tex, avg };
}

const BLUR_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const BLUR_FRAG = /* glsl */ `
uniform sampler2D tMap;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(tMap, vUv) * 0.2270270270;
  c += texture2D(tMap, vUv + uDir * 1.3846153846) * 0.3162162162;
  c += texture2D(tMap, vUv - uDir * 1.3846153846) * 0.3162162162;
  c += texture2D(tMap, vUv + uDir * 3.2307692308) * 0.0702702703;
  c += texture2D(tMap, vUv - uDir * 3.2307692308) * 0.0702702703;
  gl_FragColor = c;
}`;
const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tMap;
uniform float uOpacity;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(tMap, vUv);
  vec3 rgb = c.a > 0.0001 ? c.rgb / c.a : vec3(0.0);
  gl_FragColor = vec4(rgb, c.a * uOpacity);
  #include <colorspace_fragment>
  gl_FragColor.rgb *= gl_FragColor.a;
}`;

/** 一块会动的方块（漂浮的、字标里的都用它） */
interface Block {
  /** 在 blocks 里的序号（页面和测试用它指代一块） */
  id: number;
  group: THREE.InstancedMesh;
  index: number;
  /** 所在的层（只有清晰的那一层能抓） */
  layer: Layer;
  /** 原来的位置（敲碎以后在这里长回来） */
  home: THREE.Vector3;
  /** 拼在哪一组里；null 是原来那样在原位漂着、转着 */
  grp: Grp | null;
  /** 这一帧画在哪、什么朝向、多大（拾取和转成一组时用） */
  shown: THREE.Vector3;
  shownQ: THREE.Quaternion;
  shownS: number;
  /** 刚吸上的时刻和贴上去的方向（贴合时的一下回弹） */
  pulseAt: number;
  bounceDir: THREE.Vector3;
  /** 正在被手里那组吸过去；null 是没有 */
  pull: Pull | null;
  /** 世界里的基准位置 */
  base: THREE.Vector3;
  size: number;
  rot: THREE.Euler;
  spin: THREE.Vector3;
  phase: number;
  /** 被指针推开的偏移和速度 */
  push: THREE.Vector3;
  pushV: THREE.Vector3;
  /** 敲碎的时刻（毫秒，0 表示完好） */
  brokenAt: number;
  /** 敲碎后多久长回来 */
  regrowMs: number;
  avg: THREE.Color;
  station: number;
  /** 给正文让位的程度（0 完整、1 缩没了），平滑地变 */
  hide: number;
}

/**
 * 一组拼在一起的方块（单独拖出来的一块也是一组）：同一套网格，格子边长 u，格子 (0, 0, 0) 的中心在 pos，朝向 q。
 * 成员的格子坐标是整数；画的时候每块就是 pos + q·(格子 × u)，边长正好 u，相邻的面严丝合缝。
 */
interface Grp {
  id: number;
  members: { b: Block; cell: [number, number, number] }[];
  u: number;
  pos: THREE.Vector3;
  q: THREE.Quaternion;
  vel: THREE.Vector3;
  /** 显示用：按速度倾斜 */
  tilt: THREE.Quaternion;
  phase: number;
  /** 这一帧画出来的样子（原点、朝向、格子边长）：被吸的方块朝它飞 */
  disp: { base: THREE.Vector3; q: THREE.Quaternion; u: number };
  /** 压在正文上又找不到空地时缩小（1 是原样） */
  shrink: number;
}

/** 一块正在被手里那组吸过去：目标格子、往外顺延的方向、此刻的位置和速度、出发时的朝向和大小、出发时离目标多远 */
interface Pull {
  g: Grp;
  cell: [number, number, number];
  step: number;
  pos: THREE.Vector3;
  speed: number;
  q0: THREE.Quaternion;
  s0: number;
  d0: number;
}

interface Particle {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  born: number;
  size: number;
}

export interface WorldFrame {
  now: number;
  dt: number;
  /** 当前该在哪个机位（由滚动位置决定） */
  station: number;
  /** 指针的归一化坐标（−1–1，y 向下），没有指针时为 null */
  pointer: { x: number; y: number } | null;
  /** 页尾字标在视口里的位置（CSS 像素）；不在视口里时为 null */
  wordmark: { left: number; top: number; height: number } | null;
  /** 悦灵：视口坐标（CSS 像素）、显示尺寸、当前帧在图集里的序号、朝向；不出场时为 null */
  allay: { x: number; y: number; size: number; frame: number; facing: 1 | -1; tilt: number } | null;
  vw: number;
  vh: number;
  /** 减少动效：不漂浮、不入场、不跟鼠标，相机直接到位 */
  still: boolean;
  /** 正文在视口里的位置（CSS 像素，每 4 个数一个框：左、上、右、下）：落在这些框后面的方块缩起来让位 */
  textRects: Float32Array | null;
  /** 体素雕塑占着的框（同样的格式）：背景的方块也给它让位 */
  keepOut: Float32Array | null;
  /** 体素雕塑这一帧要的东西；没有时不画雕塑 */
  sculpt: SculptureFrame | null;
}

export interface WordmarkGrid {
  cols: number;
  rows: number;
  /** 有方块的格子（列、行） */
  cells: [number, number][];
}

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpS = new THREE.Vector3();
const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpE = new THREE.Euler();
const tmpV3 = new THREE.Vector3();
const tmpV4 = new THREE.Vector3();
const AXES: [number, number, number][] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
const cellKey = (c: readonly number[]) => `${c[0]},${c[1]},${c[2]}`;
/**
 * 磁吸（都按屏幕上看到的，以手里那块在屏幕上的边长为单位）：竖直方向偏差不超过 band、左右不超过 reach 的方块被吸；
 * 吸力（世界里，以格子边长 u 计）刚开始是 accel·u/s²，按出发距离与当前距离之比的平方增大；离目标 snap·u 以内“啪”地贴上
 */
export const MAGNET = { band: 0.8, reach: 4.5, accel: 3, snap: 0.08 } as const;
/** 手里的方块转正到的那套网格：侧着一点、俯一点，看得到正面、侧面和顶面（左右排开时一眼看得出是一排） */
const UPRIGHT = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.35, -0.6, 0, 'XYZ'));

export class World {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(30, 1, 0.1, 400);
  private readonly rtA: THREE.WebGLRenderTarget;
  private readonly rtB: THREE.WebGLRenderTarget;
  private readonly quad: THREE.Mesh;
  private readonly blurMat: THREE.ShaderMaterial;
  private readonly compMat: THREE.ShaderMaterial;
  private readonly quadScene = new THREE.Scene();
  private readonly quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly cursorLight: THREE.PointLight;
  private readonly rim: THREE.DirectionalLight;
  private readonly key: THREE.DirectionalLight;
  private readonly ambient: THREE.AmbientLight;
  private readonly geo = new THREE.BoxGeometry(1, 1, 1);
  private readonly blocks: Block[] = [];
  private readonly letters: Block[] = [];
  private readonly groups: THREE.InstancedMesh[] = [];
  private readonly matsByType = new Map<string, THREE.MeshLambertMaterial[]>();
  private readonly avgByType = new Map<string, THREE.Color>();
  private readonly dimMaterials: THREE.MeshLambertMaterial[] = [];
  private readonly allMaterials: THREE.MeshLambertMaterial[] = [];
  private particles!: THREE.InstancedMesh;
  private readonly parts: Particle[] = [];
  private partNext = 0;
  private letterMesh: THREE.InstancedMesh | null = null;
  private letterGrid: WordmarkGrid | null = null;
  private letterState: 'gone' | 'assembling' | 'ready' = 'gone';
  private letterT0 = 0;
  private letterStart: THREE.Vector3[] = [];
  private allayMesh: THREE.Mesh | null = null;
  private allayMat: THREE.MeshBasicMaterial | null = null;
  private allayAtlas: { columns: number; rx: number; ry: number } | null = null;
  private width = 1;
  private height = 1;
  private aspect = 1;
  private narrow = false;
  private theme: 'dark' | 'light' = 'dark';
  private camPos = new THREE.Vector3(0, 0, 16);
  private camVel = new THREE.Vector3();
  private lookPos = new THREE.Vector3();
  private lookVel = new THREE.Vector3();
  private lightPos = new THREE.Vector3(2, 1, 4);
  private firstFrame = true;
  private t0 = 0;
  private disposed = false;
  /** 相机落到机位、字标拼好（或不在）、没有在拖或飘的方块组、雕塑没在重组时为真 */
  settled = true;
  /** 首屏的体素悦灵、剪辑点的 ◆、开源的时间线（和这里共用渲染器、场景、相机） */
  sculpture: Sculpture | null = null;
  private readonly grps: Grp[] = [];
  private nextGroup = 1;
  /** 正在拖的组：抓住的那一块、拖动平面的深度、指针与组原点的偏移、指针（归一化坐标） */
  private drag: { g: Grp; grab: Block; z: number; offset: THREE.Vector3; ndcX: number; ndcY: number; lastFling: number } | null = null;
  /** 拼出一大块时让悦灵飞过来看一眼：组的中心（世界坐标）和时刻 */
  attention: { pos: THREE.Vector3; at: number } | null = null;
  private now = 0;
  /** 指针下能抓的那块（稍微放大一点作提示，位置不动） */
  private hovered: number | null = null;

  private constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, premultipliedAlpha: true, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.autoClear = false;
    const rt = () => new THREE.WebGLRenderTarget(4, 4, { depthBuffer: true, type: THREE.HalfFloatType });
    this.rtA = rt();
    this.rtB = rt();
    this.blurMat = new THREE.ShaderMaterial({ uniforms: { tMap: { value: null }, uDir: { value: new THREE.Vector2() } }, vertexShader: BLUR_VERT, fragmentShader: BLUR_FRAG, depthTest: false, depthWrite: false });
    this.compMat = new THREE.ShaderMaterial({
      uniforms: { tMap: { value: null }, uOpacity: { value: 1 } },
      vertexShader: BLUR_VERT,
      fragmentShader: COMPOSITE_FRAG,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      premultipliedAlpha: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blurMat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);

    this.ambient = new THREE.AmbientLight(0xffffff, 0.55);
    this.key = new THREE.DirectionalLight(0xffffff, 2.1);
    this.key.position.set(-4, 6, 7);
    this.rim = new THREE.DirectionalLight(0x3cb7f4, 3.2);
    this.rim.position.set(5, -2, -6);
    this.cursorLight = new THREE.PointLight(0x3cb7f4, 38, 0, 1.4);
    const hemi = new THREE.HemisphereLight(0x9fdcfa, 0x0d0d0e, 0.6);
    for (const l of [this.ambient, this.key, this.rim, this.cursorLight, hemi]) {
      l.layers.enableAll();
      this.scene.add(l);
    }
    // 方向光跟着相机走（机位在世界里竖着排开）
    this.scene.add(this.key.target, this.rim.target);
    this.camera.layers.enableAll();
  }

  static async create(canvas: HTMLCanvasElement, opts: { theme: 'dark' | 'light'; narrow: boolean; tier: Tier; slotHeight: number }): Promise<World> {
    const w = new World(canvas);
    w.theme = opts.theme;
    w.narrow = opts.narrow;
    await w.build();
    w.applyTheme();
    w.sculpture = Sculpture.create(w.renderer, w.scene, { theme: opts.theme, tier: opts.tier, slotHeight: opts.slotHeight });
    return w;
  }

  /** 原版悦灵贴图装好（或测试换上合成贴图）：体素雕塑按它生成体素悦灵 */
  setAllayTexture(img: ImageData): void {
    this.sculpture?.setAllayTexture(img);
  }

  private async materialsFor(id: string, cache: Map<string, Promise<{ tex: THREE.Texture; avg: THREE.Color } | null>>): Promise<THREE.MeshLambertMaterial[]> {
    const hit = this.matsByType.get(id);
    if (hit) return hit;
    const def = BLOCKS[id];
    const faces = def ? resolveBlockFaces(def).faces : null;
    const tex = (tid: string) => {
      let p = cache.get(tid);
      if (!p) {
        p = mcGameVersion ? faceTexture(tid).catch(() => null) : Promise.resolve(null);
        cache.set(tid, p);
      }
      return p;
    };
    const emissive = EMISSIVE.has(id);
    let avg: THREE.Color | null = null;
    const mats = await Promise.all(
      BOX_FACES.map(async (f) => {
        const t = faces ? await tex(faces[f].texture) : null;
        if (t && f === 'north') avg = t.avg;
        const m = new THREE.MeshLambertMaterial(t ? { map: t.tex } : { color: new THREE.Color(FALLBACK[id] ?? '#888888') });
        if (emissive) {
          m.emissive = new THREE.Color(0xffffff);
          if (t) m.emissiveMap = t.tex;
          m.emissiveIntensity = t ? 0.85 : 0.35;
        }
        this.allMaterials.push(m);
        return m;
      }),
    );
    this.matsByType.set(id, mats);
    this.avgByType.set(id, avg ?? new THREE.Color(FALLBACK[id] ?? '#888888'));
    return mats;
  }

  private async build(): Promise<void> {
    const cache = new Map<string, Promise<{ tex: THREE.Texture; avg: THREE.Color } | null>>();
    // 先把每个机位要放哪些方块算出来（确定性的抽稀和镜像），再按“方块类型 × 层”建实例化网格
    const plan: { spec: Spec; station: number; layer: Layer; i: number }[] = [];
    CAMS.forEach((cam, st) => {
      const density = cam.density * (this.narrow ? 0.6 : 1);
      SPECS.forEach((spec, i) => {
        if (st > 0 && h01(i, st * 31) > density) return;
        const x = cam.mirror ? -spec.x : spec.x;
        const y = st === 0 ? spec.y : spec.y + (h01(i, st) - 0.5) * 2.4;
        plan.push({ spec: { ...spec, x, y, id: st === 0 ? spec.id : SPECS[(i + st * 5) % SPECS.length]!.id }, station: st, layer: layerOf(spec.z), i: plan.length });
      });
    });
    const keyOf = (id: string, layer: Layer) => `${id}|${layer}`;
    const counts = new Map<string, number>();
    for (const p of plan) counts.set(keyOf(p.spec.id, p.layer), (counts.get(keyOf(p.spec.id, p.layer)) ?? 0) + 1);
    const meshes = new Map<string, THREE.InstancedMesh>();
    const used = new Map<string, number>();
    for (const [k, n] of counts) {
      const [id, layerStr] = k.split('|') as [string, string];
      const layer = Number(layerStr) as Layer;
      let mats = await this.materialsFor(id, cache);
      if (layer === 0) {
        // 远层：单独一套材质（深色主题压暗、浅色主题蒙一层雾）
        mats = mats.map((m) => {
          const c = m.clone();
          this.dimMaterials.push(c);
          this.allMaterials.push(c);
          return c;
        });
      }
      const mesh = new THREE.InstancedMesh(this.geo, mats, n);
      mesh.frustumCulled = false;
      mesh.layers.set(layer);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // 实例矩阵默认是单位矩阵（一块方块摆在原点）：先全部缩成 0，离相机远、这一帧不更新的也不会冒出来
      for (let i = 0; i < n; i++) mesh.setMatrixAt(i, tmpM.makeScale(0, 0, 0));
      this.scene.add(mesh);
      this.groups.push(mesh);
      meshes.set(k, mesh);
      used.set(k, 0);
    }
    for (const p of plan) {
      const k = keyOf(p.spec.id, p.layer);
      const mesh = meshes.get(k)!;
      const index = used.get(k)!;
      used.set(k, index + 1);
      const cy = -p.station * STATION_GAP;
      const base = new THREE.Vector3(p.spec.x, cy + p.spec.y, p.spec.z);
      this.blocks.push({
        id: this.blocks.length,
        group: mesh,
        index,
        layer: p.layer,
        home: base.clone(),
        grp: null,
        shown: base.clone(),
        shownQ: new THREE.Quaternion(),
        shownS: 0,
        pulseAt: 0,
        bounceDir: new THREE.Vector3(),
        pull: null,
        base,
        size: p.spec.s * (this.narrow ? 0.72 : 1),
        rot: new THREE.Euler(h01(p.i, 1) * Math.PI * 2, h01(p.i, 2) * Math.PI * 2, h01(p.i, 3) * 0.6),
        spin: new THREE.Vector3((h01(p.i, 5) - 0.5) * 0.3, (h01(p.i, 6) - 0.5) * 0.5 + 0.12, (h01(p.i, 7) - 0.5) * 0.2),
        phase: h01(p.i, 4) * Math.PI * 2,
        push: new THREE.Vector3(),
        pushV: new THREE.Vector3(),
        brokenAt: 0,
        regrowMs: 3500 + h01(p.i, 9) * 2500,
        avg: this.avgByType.get(p.spec.id)!,
        station: p.station,
        hide: 0,
      });
    }
    // 碎块：一个小方块的实例池
    const pm = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.allMaterials.push(pm);
    this.particles = new THREE.InstancedMesh(this.geo, pm, 160);
    this.particles.frustumCulled = false;
    this.particles.layers.set(1);
    this.particles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < 160; i++) {
      this.particles.setMatrixAt(i, tmpM.makeScale(0, 0, 0));
      this.particles.setColorAt(i, new THREE.Color(1, 1, 1));
    }
    this.scene.add(this.particles);
    // 字标的方块材质预先装好（主题一变就换）
    await Promise.all([...LETTER_IDS.dark, ...LETTER_IDS.light].map((id) => this.materialsFor(id, cache)));
  }

  setTheme(theme: 'dark' | 'light', bg: string): void {
    this.theme = theme;
    this.applyTheme();
    if (this.letterGrid) this.buildLetters(this.letterGrid);
    this.sculpture?.setTheme(theme, bg);
  }

  private applyTheme(): void {
    const light = this.theme === 'light';
    this.ambient.intensity = light ? 1.15 : 0.5;
    this.key.intensity = light ? 1.9 : 2.1;
    this.rim.color.set(light ? 0x0b6aa6 : 0x3cb7f4);
    this.rim.intensity = light ? 1.6 : 3.4;
    this.cursorLight.color.set(light ? 0x2b8fd6 : 0x3cb7f4);
    this.cursorLight.intensity = light ? 26 : 42;
    for (const m of this.dimMaterials) {
      m.color.setScalar(light ? 0.92 : 0.5);
      if (!m.emissiveMap) {
        m.emissive.set(light ? 0xe4e8ef : 0x000000);
        m.emissiveIntensity = light ? 0.45 : 0;
      }
    }
  }

  /** 页尾字标的点阵（由页面按 DOM 里那段字的字体栅格化出来） */
  setWordmark(grid: WordmarkGrid): void {
    this.letterGrid = grid;
    this.buildLetters(grid);
  }

  private buildLetters(grid: WordmarkGrid): void {
    if (this.letterMesh) {
      this.scene.remove(this.letterMesh);
      this.letterMesh.dispose();
      this.letterMesh = null;
    }
    this.letters.length = 0;
    const [mainId, accentId] = LETTER_IDS[this.theme];
    const mats = this.matsByType.get(mainId);
    const accent = this.matsByType.get(accentId);
    if (!mats || !accent) return;
    // 两种方块各一个实例化网格：主色和零星的强调色
    const isAccent = grid.cells.map((_, i) => h01(i, 77) < 0.06);
    const nA = isAccent.filter(Boolean).length;
    const main = new THREE.InstancedMesh(this.geo, mats, grid.cells.length - nA);
    const acc = new THREE.InstancedMesh(this.geo, accent, Math.max(1, nA));
    for (const m of [main, acc]) {
      m.frustumCulled = false;
      m.layers.set(1);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.scene.add(m);
    }
    let iMain = 0;
    let iAcc = 0;
    grid.cells.forEach((_, i) => {
      const a = isAccent[i]!;
      const group = a ? acc : main;
      const index = a ? iAcc++ : iMain++;
      group.setMatrixAt(index, tmpM.makeScale(0, 0, 0));
      this.letters.push({
        id: -1,
        group,
        index,
        layer: 1,
        home: new THREE.Vector3(),
        grp: null,
        shown: new THREE.Vector3(),
        shownQ: new THREE.Quaternion(),
        shownS: 0,
        pulseAt: 0,
        bounceDir: new THREE.Vector3(),
        pull: null,
        base: new THREE.Vector3(),
        size: 1,
        rot: new THREE.Euler(),
        spin: new THREE.Vector3(),
        phase: h01(i, 11) * Math.PI * 2,
        push: new THREE.Vector3(),
        pushV: new THREE.Vector3(),
        brokenAt: 0,
        regrowMs: 2600 + h01(i, 12) * 1800,
        avg: this.avgByType.get(a ? accentId : mainId)!,
        station: -1,
        hide: 0,
      });
    });
    // 两个网格都登记起来（销毁、换主题时一起处理）
    this.letterMesh = main;
    this.letterExtra = acc;
    this.letterState = 'gone';
  }

  private letterExtra: THREE.InstancedMesh | null = null;

  /** 悦灵的图集（应用同一份烘焙产物）：画在一块面片上，放进这个空间里 */
  setAllayAtlas(image: ImageBitmap, atlas: { columns: number; size: number }): void {
    const tex = new THREE.Texture(image);
    tex.needsUpdate = true;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    // ImageBitmap 上传时不能翻转（flipY 无效）：v 从图的顶边往下增，所以 repeat.y 取负、offset 指向格子的底边
    tex.flipY = false;
    const rx = atlas.size / image.width;
    const ry = atlas.size / image.height;
    tex.repeat.set(rx, -ry);
    this.allayAtlas = { columns: atlas.columns, rx, ry };
    this.allayMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, alphaTest: 0.02 });
    this.allayMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.allayMat);
    this.allayMesh.layers.set(1);
    this.allayMesh.renderOrder = 5;
    this.allayMesh.visible = false;
    this.scene.add(this.allayMesh);
  }

  resize(width: number, height: number): void {
    this.width = Math.max(2, Math.round(width));
    this.height = Math.max(2, Math.round(height));
    this.aspect = this.width / this.height;
    this.renderer.setSize(this.width, this.height, false);
    const hw = Math.max(2, Math.round(this.width / 2));
    const hh = Math.max(2, Math.round(this.height / 2));
    this.rtA.setSize(hw, hh);
    this.rtB.setSize(hw, hh);
    this.camera.aspect = this.aspect;
    this.camera.fov = this.aspect < 1 ? 44 : 30;
    this.camera.updateProjectionMatrix();
  }

  /** 视口坐标（CSS 像素）→ 世界里 z = zPlane 那个平面上的点（用当前相机） */
  private unproject(x: number, y: number, vw: number, vh: number, zPlane: number, out: THREE.Vector3): THREE.Vector3 {
    tmpV2.set((x / vw) * 2 - 1, -(y / vh) * 2 + 1, 0.5).unproject(this.camera);
    tmpV2.sub(this.camera.position).normalize();
    const t = (zPlane - this.camera.position.z) / tmpV2.z;
    return out.copy(this.camera.position).addScaledVector(tmpV2, t);
  }

  /** 在 z = zPlane 处，一个 CSS 像素对应多少世界单位 */
  private unitsPerPx(vh: number, zPlane: number): number {
    const dist = this.camera.position.z - zPlane;
    return (2 * Math.tan((this.camera.fov * Math.PI) / 360) * dist) / vh;
  }

  /** 指针下面能抓的方块（清晰那一层、完好、没缩起来、在当前机位附近）；没有时为 null。只看这一机位的十几块，不遍历全部 */
  pickBlock(ndcX: number, ndcY: number): number | null {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(ndcX, -ndcY), this.camera);
    let best: { id: number; d: number } | null = null;
    for (const b of this.blocks) {
      if (b.layer !== 1 || b.brokenAt || b.pull) continue;
      if (Math.abs(b.shown.y - this.camPos.y) > STATION_GAP) continue;
      if (b.shownS < (b.grp ? b.grp.u : b.size) * 0.35) continue;
      const toC = tmpV.copy(b.shown).sub(ray.ray.origin);
      const along = toC.dot(ray.ray.direction);
      if (along <= 0) continue;
      const r = b.shownS * 0.72;
      if (toC.lengthSq() - along * along > r * r) continue;
      if (!best || along < best.d) best = { id: b.id, d: along };
    }
    return best?.id ?? null;
  }

  /** 指针下面有没有能抓的方块（给光标反馈用） */
  hovering(ndcX: number, ndcY: number): boolean {
    return this.pickBlock(ndcX, ndcY) !== null;
  }

  /** 指针下能抓的那块（null 是没有）：只稍微放大一点作提示，位置不动 */
  setHover(id: number | null): void {
    this.hovered = id;
  }

  /** 把几块（按它们这一帧的样子）收成一组：第一块定网格（原点、朝向、格子边长） */
  private makeGroup(b: Block, u: number): Grp {
    const g: Grp = {
      id: this.nextGroup++,
      members: [{ b, cell: [0, 0, 0] }],
      u,
      pos: b.shown.clone(),
      q: b.shownQ.clone(),
      vel: new THREE.Vector3(),
      tilt: new THREE.Quaternion(),
      phase: h01(b.id, 51) * Math.PI * 2,
      disp: { base: b.shown.clone(), q: b.shownQ.clone(), u },
      shrink: 1,
    };
    b.grp = g;
    b.push.set(0, 0, 0);
    b.pushV.set(0, 0, 0);
    this.grps.push(g);
    return g;
  }

  private memberPos(g: Grp, cell: readonly number[], out: THREE.Vector3): THREE.Vector3 {
    return out.set(cell[0]! * g.u, cell[1]! * g.u, cell[2]! * g.u).applyQuaternion(g.q).add(g.pos);
  }

  /** 指针射线和 z = 深度 的平面的交点 */
  private rayPlane(ndcX: number, ndcY: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    tmpV4.set(ndcX, -ndcY, 0.5).unproject(this.camera).sub(this.camera.position).normalize();
    const t = (z - this.camera.position.z) / (Math.abs(tmpV4.z) < 1e-6 ? -1e-6 : tmpV4.z);
    return out.copy(this.camera.position).addScaledVector(tmpV4, t);
  }

  /** 按住一块开始拖：它在组里就整组一起拖；原来漂着的那块先收成一组（停转） */
  grab(id: number, ndcX: number, ndcY: number): void {
    const b = this.blocks[id];
    if (!b || b.brokenAt) return;
    b.pull = null;
    const g = b.grp ?? this.makeGroup(b, b.size);
    g.vel.set(0, 0, 0);
    // 拖动平面：抓住那块的深度（限在清晰那一层的深度范围里）
    const z = THREE.MathUtils.clamp(b.shown.z, -5, 2.5);
    const p0 = this.rayPlane(ndcX, ndcY, z, new THREE.Vector3());
    this.drag = { g, grab: b, z, offset: g.pos.clone().sub(p0), ndcX, ndcY, lastFling: 0 };
  }

  /** 拖动中：指针移到了哪（归一化坐标）、指针速度（px/s，用力甩时甩脱最外面那块） */
  dragTo(ndcX: number, ndcY: number, speed: number): void {
    const d = this.drag;
    if (!d) return;
    d.ndcX = ndcX;
    d.ndcY = ndcY;
    const g = d.g;
    if (speed > 2600 && g.members.length > 1 && this.now - d.lastFling > 400) {
      d.lastFling = this.now;
      // 离抓住的那块最远的那块（按格子算）
      const gc = g.members.find((m) => m.b === d.grab)!.cell;
      let far = g.members[0]!;
      let fd = -1;
      for (const m of g.members) {
        if (m.b === d.grab) continue;
        const dd = (m.cell[0] - gc[0]) ** 2 + (m.cell[1] - gc[1]) ** 2 + (m.cell[2] - gc[2]) ** 2;
        if (dd > fd) {
          fd = dd;
          far = m;
        }
      }
      const out = this.memberPos(g, far.cell, new THREE.Vector3()).sub(this.memberPos(g, gc, tmpV3)).normalize();
      this.detach(far.b, g.vel.clone().multiplyScalar(1.3).addScaledVector(out, g.u * 3));
    }
  }

  /** 松手：组留在原地，带着松手时的速度滑一小段再停下，轻轻浮着 */
  release(): void {
    const d = this.drag;
    if (!d) return;
    const g = d.g;
    const max = g.u * 8;
    if (g.vel.length() > max) g.vel.setLength(max);
    this.drag = null;
  }

  /** 双击：把这一块从组里弹出去（一组只有它自己时不动） */
  popOut(id: number): boolean {
    const b = this.blocks[id];
    const g = b?.grp;
    if (!b || !g || g.members.length < 2) return false;
    const c = new THREE.Vector3();
    for (const m of g.members) c.add(this.memberPos(g, m.cell, tmpV3));
    c.divideScalar(g.members.length);
    const out = this.memberPos(g, g.members.find((m) => m.b === b)!.cell, new THREE.Vector3()).sub(c);
    if (out.lengthSq() < 1e-6) out.set(0, 1, 0);
    out.z *= 0.2;
    out.normalize();
    this.detach(b, out.multiplyScalar(g.u * 5));
    return true;
  }

  /** 单击：敲碎这一块（在组里就先拿出来），几秒后在它原来的位置长回来 */
  breakBlock(id: number): boolean {
    const b = this.blocks[id];
    if (!b || b.brokenAt) return false;
    if (b.grp) this.detach(b, null);
    const now = this.now;
    b.brokenAt = now;
    for (let i = 0; i < 8; i++) {
      const k = this.partNext++ % 160;
      const part = this.parts[k] ?? { pos: new THREE.Vector3(), vel: new THREE.Vector3(), born: 0, size: 0 };
      const s = Math.max(b.shownS, b.size * 0.5);
      part.pos.copy(b.shown).add(new THREE.Vector3((i & 1) - 0.5, ((i >> 1) & 1) - 0.5, ((i >> 2) & 1) - 0.5).multiplyScalar(s * 0.5));
      part.vel.set((h01(now + i, 61) - 0.5) * 6, h01(now + i, 62) * 6 + 2, (h01(now + i, 63) - 0.5) * 6).multiplyScalar(s);
      part.born = now;
      part.size = s * 0.32;
      this.parts[k] = part;
      this.particles.setColorAt(k, b.avg);
    }
    if (this.particles.instanceColor) this.particles.instanceColor.needsUpdate = true;
    return true;
  }

  /**
   * 把一块从它的组里拿出来。vel 不为 null：它自己成一组带着这个速度飞出去（甩脱、弹出）；为 null：回到原来那样（敲碎时）。
   * 剩下的如果断成几截，各成一组
   */
  private detach(b: Block, vel: THREE.Vector3 | null): void {
    const g = b.grp;
    if (!g) return;
    const u = g.u;
    g.members = g.members.filter((m) => m.b !== b);
    b.grp = null;
    if (vel) {
      const s = this.makeGroup(b, u);
      s.vel.copy(vel);
    }
    if (this.drag?.grab === b) this.drag = null;
    if (g.members.length === 0) {
      this.grps.splice(this.grps.indexOf(g), 1);
      if (this.drag?.g === g) this.drag = null;
      return;
    }
    // 连通的各成一组（六邻接）
    const left = new Map(g.members.map((m) => [cellKey(m.cell), m]));
    const parts: Grp['members'][] = [];
    while (left.size) {
      const [startKey, start] = left.entries().next().value as [string, Grp['members'][number]];
      left.delete(startKey);
      const comp = [start];
      for (let i = 0; i < comp.length; i++) {
        for (const a of AXES) {
          const k = cellKey([comp[i]!.cell[0] + a[0], comp[i]!.cell[1] + a[1], comp[i]!.cell[2] + a[2]]);
          const n = left.get(k);
          if (n) {
            left.delete(k);
            comp.push(n);
          }
        }
      }
      parts.push(comp);
    }
    g.members = parts[0]!;
    for (const comp of parts.slice(1)) {
      const ng: Grp = { ...g, id: this.nextGroup++, members: comp, pos: g.pos.clone(), q: g.q.clone(), vel: g.vel.clone(), tilt: new THREE.Quaternion(), disp: { base: g.disp.base.clone(), q: g.disp.q.clone(), u: g.disp.u } };
      for (const m of comp) m.b.grp = ng;
      this.grps.push(ng);
      if (this.drag && comp.some((m) => m.b === this.drag!.grab)) this.drag.g = ng;
    }
  }

  /**
   * 磁吸，第一步：找要被吸的方块（只在拖着时算）。按屏幕上看到的：和手里那组任何一块差不多平齐（竖直偏差不超过
   * band 个块高）、在它左右 reach 个块宽以内的单块方块。目标是那一块左面或右面的格子（从哪边来贴哪边），被占了就顺着往外排。
   * 只看当前机位附近、清晰那一层的十几块
   */
  private attract(g: Grp, f: WorldFrame): void {
    const { base, q, u } = g.disp;
    const occupied = new Set(g.members.map((m) => cellKey(m.cell)));
    for (const b of this.blocks) if (b.pull?.g === g) occupied.add(cellKey(b.pull.cell));
    // 网格的 x 轴在屏幕上朝哪边（转正以后大致朝右）
    const xSign = new THREE.Vector3(1, 0, 0).applyQuaternion(q).x >= 0 ? 1 : -1;
    const tanHalf = Math.tan((this.camera.fov * Math.PI) / 360);
    const ms = g.members.map((m) => {
      const w = new THREE.Vector3(m.cell[0] * u, m.cell[1] * u, m.cell[2] * u).applyQuaternion(q).add(base);
      return { m, p: this.toScreen(w, f.vw, f.vh), size: (u * f.vh) / (2 * tanHalf * Math.max(0.5, this.camera.position.distanceTo(w))) };
    });
    for (const b of this.blocks) {
      if (b.layer !== 1 || b.brokenAt || b.pull) continue;
      if (b.grp && (b.grp === g || b.grp.members.length > 1)) continue;
      if (Math.abs(b.shown.y - this.camPos.y) > STATION_GAP) continue;
      if (b.shownS < b.size * 0.35) continue;
      const pb = this.toScreen(b.shown, f.vw, f.vh);
      if (!pb) continue;
      let best: { m: Grp['members'][number]; dx: number } | null = null;
      for (const x of ms) {
        if (!x.p) continue;
        const dy = Math.abs(pb.y - x.p.y);
        const dx = pb.x - x.p.x;
        if (dy > MAGNET.band * x.size || Math.abs(dx) > MAGNET.reach * x.size || Math.abs(dx) < 0.25 * x.size) continue;
        if (!best || Math.abs(dx) < Math.abs(best.dx)) best = { m: x.m, dx };
      }
      if (!best) continue;
      const step = Math.sign(best.dx) * xSign;
      const c: [number, number, number] = [best.m.cell[0] + step, best.m.cell[1], best.m.cell[2]];
      for (let n = 0; n < 12 && occupied.has(cellKey(c)); n++) c[0] += step;
      if (occupied.has(cellKey(c))) continue;
      occupied.add(cellKey(c));
      // 开始被吸：原来漂着的（或单独一块的组）从它此刻的样子出发
      if (b.grp) {
        this.grps.splice(this.grps.indexOf(b.grp), 1);
        b.grp = null;
      }
      const target = new THREE.Vector3(c[0] * u, c[1] * u, c[2] * u).applyQuaternion(q).add(base);
      b.pull = { g, cell: c, step, pos: b.shown.clone(), speed: 0, q0: b.shownQ.clone(), s0: Math.max(b.shownS, 1e-3), d0: Math.max(target.distanceTo(b.shown), u * 0.5) };
    }
  }

  /**
   * 磁吸，第二步：被吸的方块朝手里那组飞。加速度约与距离平方成反比（刚进范围时缓缓被拉动、越近越急），速度只增不减；
   * 途中朝向、大小、深度按走过的比例过渡到手里那组的网格，越近对得越准；到了就“啪”地贴上（一下极小的回弹），之后刚性地跟手
   */
  private updatePulls(f: WorldFrame, dt: number): void {
    for (const b of this.blocks) {
      const p = b.pull;
      if (!p) continue;
      const g = p.g;
      if (!this.grps.includes(g)) {
        this.dropPull(b);
        continue;
      }
      const { base, q, u } = g.disp;
      const target = new THREE.Vector3(p.cell[0] * u, p.cell[1] * u, p.cell[2] * u).applyQuaternion(q).add(base);
      const to = target.clone().sub(p.pos);
      const d = to.length();
      // 手里那组被拖开了（比出发时还远出一截）：松开，留在半路上轻轻浮着
      if (d > p.d0 * 1.25 + u * 0.5) {
        this.dropPull(b);
        continue;
      }
      const a = MAGNET.accel * u * Math.min(400, (p.d0 / Math.max(d, u * 0.05)) ** 2);
      p.speed += a * dt;
      const stepLen = p.speed * dt;
      if (stepLen >= d || d < MAGNET.snap * u) {
        // 啪：贴上（这一格要是刚被占了就顺着往外排）
        const occupied = new Set(g.members.map((m) => cellKey(m.cell)));
        for (let n = 0; n < 12 && occupied.has(cellKey(p.cell)); n++) p.cell[0] += p.step;
        g.members.push({ b, cell: p.cell });
        b.grp = g;
        b.pull = null;
        b.pulseAt = f.now;
        b.bounceDir.copy(to).normalize();
        if (g.members.length >= 4) {
          const c = new THREE.Vector3();
          for (const m of g.members) c.add(this.memberPos(g, m.cell, tmpV3));
          this.attention = { pos: c.divideScalar(g.members.length), at: f.now };
        }
        continue;
      }
      p.pos.addScaledVector(to, stepLen / d);
      const w = THREE.MathUtils.clamp(1 - d / p.d0, 0, 1);
      const qq = p.q0.clone().slerp(q, w);
      const s = p.s0 + (u - p.s0) * w;
      tmpM.compose(p.pos, qq, new THREE.Vector3(s, s, s));
      b.group.setMatrixAt(b.index, tmpM);
      b.shown.copy(p.pos);
      b.shownQ.copy(qq);
      b.shownS = s;
    }
  }

  /** 被吸到一半松开：自己成一组，留在此刻的位置轻轻浮着 */
  private dropPull(b: Block): void {
    b.pull = null;
    this.makeGroup(b, b.shownS);
  }

  /** 世界坐标 → 视口坐标（CSS 像素）；在相机后面时为 null */
  toScreen(pos: THREE.Vector3, vw: number, vh: number): { x: number; y: number } | null {
    tmpV.copy(pos).project(this.camera);
    if (tmpV.z > 1) return null;
    return { x: (tmpV.x * 0.5 + 0.5) * vw, y: (-tmpV.y * 0.5 + 0.5) * vh };
  }

  /** 测试和调试：能抓的方块在视口里的位置（CSS 像素）、所在的组和组的大小 */
  blocksOnScreen(vw: number, vh: number): { id: number; x: number; y: number; r: number; group: number | null; size: number }[] {
    const out: { id: number; x: number; y: number; r: number; group: number | null; size: number }[] = [];
    for (const b of this.blocks) {
      if (b.layer !== 1 || b.brokenAt || b.shownS < (b.grp ? b.grp.u : b.size) * 0.35) continue;
      tmpV.copy(b.shown).project(this.camera);
      if (tmpV.z > 1 || Math.abs(tmpV.x) > 1 || Math.abs(tmpV.y) > 1) continue;
      const px = (b.shownS / 2) * (vh / (2 * Math.tan((this.camera.fov * Math.PI) / 360) * Math.max(0.5, this.camera.position.distanceTo(b.shown))));
      out.push({ id: b.id, x: (tmpV.x * 0.5 + 0.5) * vw, y: (-tmpV.y * 0.5 + 0.5) * vh, r: px, group: b.grp?.id ?? null, size: b.grp?.members.length ?? 1 });
    }
    return out;
  }

  /** 测试和调试：某一块所在的组（编号、块数）；不在组里时为 null */
  groupOf(id: number): { id: number; size: number } | null {
    const g = this.blocks[id]?.grp;
    return g ? { id: g.id, size: g.members.length } : null;
  }

  /** 测试和调试：某一块此刻在视口里的位置 */
  screenPos(id: number, vw: number, vh: number): { x: number; y: number } | null {
    const b = this.blocks[id];
    return b ? this.toScreen(b.shown, vw, vh) : null;
  }

  /** 量一帧的渲染要多久（毫秒，含等 GPU 画完）。只给测试和调试用 */
  bench(n: number): number {
    const gl = this.renderer.getContext();
    const px = new Uint8Array(4);
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      this.render(false);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    }
    return (performance.now() - t0) / n;
  }

  frame(f: WorldFrame): void {
    if (this.disposed) return;
    this.t0 ||= f.now;
    const ms = f.still ? 1e6 : f.now - this.t0;
    const t = ms / 1000;
    const dt = f.still ? 1 : Math.min(0.1, f.dt);
    this.now = f.now;

    // 相机：机位由滚动决定，位置用弹簧追过去（第一帧、减少动效时直接到位）
    const cam = CAMS[Math.max(0, Math.min(CAMS.length - 1, f.station))]!;
    const cy = -f.station * STATION_GAP;
    const px = f.pointer && !f.still ? f.pointer.x : 0;
    const py = f.pointer && !f.still ? f.pointer.y : 0;
    const target = tmpV.set(cam.p[0] + px * 0.9, cy + cam.p[1] - py * 0.55, cam.p[2]);
    const look = tmpV2.set(cam.l[0], cy + cam.l[1], cam.l[2]);
    if (this.firstFrame || f.still) {
      this.camPos.copy(target);
      this.lookPos.copy(look);
      this.camVel.set(0, 0, 0);
      this.lookVel.set(0, 0, 0);
      this.firstFrame = false;
    } else {
      // 大跳（锚点、连按 PageDown）：先切到离目标一个半机位的地方再飞过去，飞行总在一秒多一点之内，不把中间各节都放一遍
      const dy = target.y - this.camPos.y;
      if (Math.abs(dy) > STATION_GAP * 1.5) {
        const jump = dy - Math.sign(dy) * STATION_GAP * 1.5;
        this.camPos.y += jump;
        this.lookPos.y += jump;
        this.camVel.set(0, 0, 0);
        this.lookVel.set(0, 0, 0);
      }
      springVec(this.camPos, this.camVel, target, 4.4, f.dt);
      springVec(this.lookPos, this.lookVel, look, 4.4, f.dt);
      if (this.camPos.distanceTo(target) < 0.12 && this.camVel.length() < 0.2) {
        this.camPos.copy(target);
        this.lookPos.copy(look);
        this.camVel.set(0, 0, 0);
        this.lookVel.set(0, 0, 0);
      }
    }
    const travelling = !this.camPos.equals(target);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.lookPos);
    this.key.position.set(this.camPos.x - 4, this.camPos.y + 6, 7);
    this.key.target.position.set(this.lookPos.x, this.lookPos.y, 0);
    this.rim.position.set(this.camPos.x + 5, this.camPos.y - 2, -6);
    this.rim.target.position.set(this.lookPos.x, this.lookPos.y, 0);

    // 指针：点光跟着走，附近的方块被推开
    // 指针不推开方块（鼠标经过时方块不动，才按得住想抓的那块）
    const vFov = (this.camera.fov * Math.PI) / 180;
    const hh = Math.tan(vFov / 2) * 13;
    const lx = f.pointer ? f.pointer.x * hh * this.aspect : Math.cos(t * 0.3) * 4;
    const ly = f.pointer ? -f.pointer.y * hh : Math.sin(t * 0.4) * 2 + 1;
    this.lightPos.lerp(new THREE.Vector3(this.camPos.x + lx, this.camPos.y + ly, 3), f.still ? 1 : 0.12);
    this.cursorLight.position.copy(this.lightPos);

    const squeeze = Math.min(1, this.aspect / 1.55);
    const halfW = Math.tan((this.camera.fov * Math.PI) / 360) * 16 * this.aspect;
    const narrow = this.aspect < 1;
    // 以前推开的余量弹回 0（现在指针不推了）
    const updatePush = (b: Block) => {
      b.pushV.x += (-b.push.x * 60 - b.pushV.x * 12) * dt;
      b.pushV.y += (-b.push.y * 60 - b.pushV.y * 12) * dt;
      b.push.x += b.pushV.x * dt;
      b.push.y += b.pushV.y * dt;
    };

    // 正文让位：方块投到屏幕上落在正文框里（远层除外，它是虚化的远景），就缩起来
    const rects = f.textRects;
    const pxPerUnitAt = (z: number) => f.vh / (2 * Math.tan((this.camera.fov * Math.PI) / 360) * Math.max(0.5, this.camera.position.z - z));
    const keep = f.keepOut;
    const behindText = (pos: THREE.Vector3, size: number): boolean => {
      if ((!rects || rects.length === 0) && (!keep || keep.length === 0)) return false;
      tmpV2.copy(pos).project(this.camera);
      if (tmpV2.z > 1) return false;
      const sx = (tmpV2.x * 0.5 + 0.5) * f.vw;
      const sy = (-tmpV2.y * 0.5 + 0.5) * f.vh;
      const r = size * 0.8 * pxPerUnitAt(pos.z);
      for (const set of [rects, keep]) {
        if (!set) continue;
        for (let i = 0; i < set.length; i += 4) {
          if (sx + r > set[i]! && sx - r < set[i + 2]! && sy + r > set[i + 1]! && sy - r < set[i + 3]!) return true;
        }
      }
      return false;
    };
    const hideStep = Math.min(1, dt * 7);

    // 漂浮的方块
    for (const b of this.blocks) {
      // 拼进组里的、正在被吸的方块由组来摆（见下）
      if (b.grp || b.pull) continue;
      // 离相机太远的不更新（看不见）
      if (Math.abs(b.base.y - this.camPos.y) > STATION_GAP * 1.6 && !travelling) continue;
      const pop = popScale(ms, 120 + (b.index % 24) * 45, f.still);
      const bob = f.still ? 0 : Math.sin(t * (0.5 + (b.phase % 0.4)) + b.phase) * 0.16 * b.size;
      const x = narrow && !(b.group.layers.mask & 1) ? Math.sign(b.base.x || 1) * (halfW * 0.92 + Math.abs(b.base.x) * 0.12) : b.base.x * squeeze;
      const pos = tmpS.set(x, b.base.y + bob, b.base.z);
      updatePush(b);
      pos.add(b.push);
      let scale = b.size * pop;
      if (b.brokenAt) {
        const since = f.now - b.brokenAt;
        if (since < 140) scale *= 1 - since / 140;
        else if (since < b.regrowMs) scale = 0;
        else if (since < b.regrowMs + 520) scale *= popCurve((since - b.regrowMs) / 520);
        else b.brokenAt = 0;
      }
      // 远景层虚化、压暗，宽屏上留着当景深；窄屏上正文占满宽度，远景也让位
      if (!(b.group.layers.mask & 1) || narrow) {
        const want = behindText(pos, b.size) ? 1 : 0;
        b.hide += (want - b.hide) * (f.still ? 1 : hideStep);
        scale *= 1 - easeInOut(b.hide);
      }
      if (b.id === this.hovered && !this.drag) scale *= 1.05;
      tmpE.set(b.rot.x + t * b.spin.x, b.rot.y + t * b.spin.y, b.rot.z + Math.sin(t * 0.4 + b.phase) * 0.08 + t * b.spin.z);
      tmpQ.setFromEuler(tmpE);
      tmpM.compose(pos, tmpQ, new THREE.Vector3(scale, scale, scale));
      b.group.setMatrixAt(b.index, tmpM);
      b.shown.copy(pos);
      b.shownQ.copy(tmpQ);
      b.shownS = scale;
    }
    this.updateGroups(f, t, dt, travelling);
    for (const g of this.groups) g.instanceMatrix.needsUpdate = true;

    // 页尾的字标：对齐 DOM 里那段字（视口坐标 → 世界），走到页尾时从四面飞进来拼好
    let lettersBusy = false;
    if (this.letterGrid && this.letterMesh) {
      const grid = this.letterGrid;
      const wm = f.wordmark;
      if (!wm) {
        if (this.letterState !== 'gone') {
          this.letterState = 'gone';
          for (const b of this.letters) b.group.setMatrixAt(b.index, tmpM.makeScale(0, 0, 0));
        }
      } else {
        const zPlane = 0;
        const cellPx = wm.height / grid.rows;
        const upp = this.unitsPerPx(f.vh, zPlane);
        const size = cellPx * upp * 0.98;
        if (this.letterState === 'gone') {
          this.letterState = f.still ? 'ready' : 'assembling';
          this.letterT0 = f.now;
          this.letterStart = this.letters.map((_, i) =>
            this.unproject(wm.left + grid.cells[i]![0] * cellPx, wm.top + grid.cells[i]![1] * cellPx, f.vw, f.vh, zPlane, new THREE.Vector3()).add(
              new THREE.Vector3((h01(i, 21) - 0.5) * 30, -8 - h01(i, 22) * 16, -10 - h01(i, 23) * 20),
            ),
          );
        }
        const span = 1100;
        let allDone = true;
        this.letters.forEach((b, i) => {
          const [gx, gy] = grid.cells[i]!;
          const target = this.unproject(wm.left + (gx + 0.5) * cellPx, wm.top + (gy + 0.5) * cellPx, f.vw, f.vh, zPlane, tmpS);
          target.z += (h01(i, 31) - 0.5) * size * 0.6;
          let p = 1;
          if (this.letterState === 'assembling') {
            const delay = (gx / grid.cols) * 700 + h01(i, 33) * 220;
            p = Math.min(1, Math.max(0, (f.now - this.letterT0 - delay) / span));
            if (p < 1) allDone = false;
          }
          const e = 1 - (1 - p) ** 3;
          const pos = new THREE.Vector3().lerpVectors(this.letterStart[i] ?? target, target, e);
          // 半路往镜头这边抬一点，像被抛进来
          pos.z += Math.sin(Math.PI * e) * 4;
          updatePush(b);
          pos.add(b.push);
          let scale = size * Math.min(1, e * 1.4);
          if (b.brokenAt) {
            const since = f.now - b.brokenAt;
            if (since < 120) scale *= 1 - since / 120;
            else if (since < b.regrowMs) scale = 0;
            else if (since < b.regrowMs + 480) scale *= popCurve((since - b.regrowMs) / 480);
            else b.brokenAt = 0;
          }
          tmpE.set((1 - e) * (h01(i, 41) - 0.5) * 6, (1 - e) * (h01(i, 42) - 0.5) * 6, 0);
          tmpQ.setFromEuler(tmpE);
          tmpM.compose(pos, tmpQ, new THREE.Vector3(scale, scale, scale));
          b.group.setMatrixAt(b.index, tmpM);
          b.base.copy(pos);
          b.size = size;
        });
        if (this.letterState === 'assembling' && allDone) this.letterState = 'ready';
        lettersBusy = this.letterState === 'assembling';
      }
      this.letterMesh.instanceMatrix.needsUpdate = true;
      if (this.letterExtra) this.letterExtra.instanceMatrix.needsUpdate = true;
    }

    // 碎块
    let anyPart = false;
    for (let i = 0; i < this.parts.length; i++) {
      const p = this.parts[i];
      if (!p) continue;
      const age = (f.now - p.born) / 1000;
      if (age > 1.1) {
        this.particles.setMatrixAt(i, tmpM.makeScale(0, 0, 0));
        continue;
      }
      anyPart = true;
      p.vel.y -= 22 * dt;
      p.pos.addScaledVector(p.vel, dt);
      const s = p.size * (1 - Math.max(0, age - 0.7) / 0.4);
      tmpM.compose(p.pos, tmpQ.setFromEuler(tmpE.set(age * 7, age * 5, 0)), new THREE.Vector3(s, s, s));
      this.particles.setMatrixAt(i, tmpM);
    }
    this.particles.instanceMatrix.needsUpdate = true;

    // 悦灵：视口坐标 → 世界（放在焦平面略靠前），按图集的帧取格子
    if (this.allayMesh && this.allayAtlas && this.allayMat) {
      const a = f.allay;
      this.allayMesh.visible = !!a;
      if (a) {
        const zPlane = 1.2;
        this.unproject(a.x, a.y, f.vw, f.vh, zPlane, this.allayMesh.position);
        const s = a.size * this.unitsPerPx(f.vh, zPlane);
        this.allayMesh.scale.set(s * a.facing, s, 1);
        this.allayMesh.quaternion.copy(this.camera.quaternion);
        this.allayMesh.rotateZ((-a.tilt * Math.PI) / 180);
        const map = this.allayMat.map!;
        const col = a.frame % this.allayAtlas.columns;
        const row = Math.floor(a.frame / this.allayAtlas.columns);
        map.offset.set(col * this.allayAtlas.rx, (row + 1) * this.allayAtlas.ry);
      }
    }

    // 体素雕塑（首屏的体素悦灵、剪辑点的 ◆、开源的时间线）：按当前相机把它的框对到世界里
    if (this.sculpture && f.sculpt) {
      this.sculpture.update(f.sculpt, { camera: this.camera, toWorld: (x, y, out) => this.unproject(x, y, f.vw, f.vh, 0, out), upp: this.unitsPerPx(f.vh, 0) });
    }
    const groupsResting = !this.drag && this.grps.every((g) => g.vel.lengthSq() < 1e-4) && !this.blocks.some((b) => b.pull);
    this.settled = !travelling && !lettersBusy && groupsResting && (this.sculpture?.settled ?? true);
    this.render(anyPart);
  }

  /** 方块组：手里那组紧跟指针、转正（它是磁铁，不被拉走）；其余带着速度滑一段停下、轻轻浮着、给正文让路；然后算吸附 */
  private updateGroups(f: WorldFrame, t: number, dt0: number, travelling: boolean): void {
    const dt = Math.min(0.05, dt0);
    const d = this.drag;
    if (d) {
      const target = this.rayPlane(d.ndcX, d.ndcY, d.z, new THREE.Vector3()).add(d.offset);
      const prev = d.g.pos.clone();
      d.g.pos.lerp(target, 1 - Math.exp(-dt * 35));
      d.g.vel.copy(d.g.pos).sub(prev).divideScalar(Math.max(dt, 1e-3));
      d.g.q.slerp(UPRIGHT, 1 - Math.exp(-dt * 8));
    }
    for (const g of this.grps) {
      const dragged = this.drag?.g === g;
      if (!dragged) {
        g.pos.addScaledVector(g.vel, dt);
        g.vel.multiplyScalar(Math.exp(-2.4 * dt));
        if (g.vel.lengthSq() < 1e-6) g.vel.set(0, 0, 0);
        // 留在清晰那一层的深度范围里（不飞到镜头跟前、也不沉进虚化的远景）
        if (g.pos.z > 2.5 || g.pos.z < -5) {
          g.pos.z = THREE.MathUtils.clamp(g.pos.z, -5, 2.5);
          g.vel.z = 0;
        }
        this.avoidText(g, f, dt);
        if (Math.abs(g.pos.y - this.camPos.y) > STATION_GAP * 1.6 && !travelling) continue;
      }
      // 拖着时按速度微微倾斜
      const ang = dragged ? Math.min(0.2, (g.vel.length() * 0.03) / g.u) : 0;
      const axis = new THREE.Vector3(-g.vel.y, g.vel.x, 0);
      const want = axis.lengthSq() > 1e-8 && ang > 0 ? new THREE.Quaternion().setFromAxisAngle(axis.normalize(), ang) : new THREE.Quaternion();
      g.tilt.slerp(want, 1 - Math.exp(-dt * 10));
      const q = new THREE.Quaternion().copy(g.q).premultiply(g.tilt);
      if (dragged) g.shrink = 1;
      const u = g.u * g.shrink;
      const base = g.pos.clone();
      if (!dragged && !f.still) base.y += Math.sin(t * 0.8 + g.phase) * 0.05 * g.u;
      g.disp.base.copy(base);
      g.disp.q.copy(q);
      g.disp.u = u;
      for (const m of g.members) {
        const pos = new THREE.Vector3(m.cell[0] * u, m.cell[1] * u, m.cell[2] * u).applyQuaternion(q).add(base);
        // 刚贴上的一下：沿贴过来的方向极小地碰一下就停（约 0.15 秒）
        const bAge = (f.now - m.b.pulseAt) / 1000;
        let s = u;
        if (m.b.pulseAt && bAge < 0.15) {
          const k = Math.sin((bAge / 0.15) * Math.PI) * (1 - bAge / 0.15);
          pos.addScaledVector(m.b.bounceDir, 0.04 * u * k);
          s = u * (1 + 0.03 * k);
        }
        tmpM.compose(pos, q, new THREE.Vector3(s, s, s));
        m.b.group.setMatrixAt(m.b.index, tmpM);
        m.b.shown.copy(pos);
        m.b.shownQ.copy(q);
        m.b.shownS = s;
      }
    }
    if (this.drag) this.attract(this.drag.g, f);
    this.updatePulls(f, dt);
  }

  /** 松手后压在正文上的组：找最近的空地缓缓挪过去，没有空地就整组缩小 */
  private avoidText(g: Grp, f: WorldFrame, dt: number): void {
    const sets = [f.textRects, f.keepOut];
    if (!sets.some((r) => r && r.length > 0)) return;
    const c = new THREE.Vector3();
    for (const m of g.members) c.add(this.memberPos(g, m.cell, tmpV3));
    c.divideScalar(g.members.length);
    let reach = 0;
    for (const m of g.members) reach = Math.max(reach, this.memberPos(g, m.cell, tmpV3).distanceTo(c));
    const p = c.clone().project(this.camera);
    if (p.z > 1) return;
    const sx = (p.x * 0.5 + 0.5) * f.vw;
    const sy = (-p.y * 0.5 + 0.5) * f.vh;
    const r = (reach + g.u * 0.6) * (f.vh / (2 * Math.tan((this.camera.fov * Math.PI) / 360) * Math.max(0.5, this.camera.position.distanceTo(c))));
    const hits = (x: number, y: number) => {
      for (const set of sets) {
        if (!set) continue;
        for (let i = 0; i < set.length; i += 4) {
          if (x + r > set[i]! && x - r < set[i + 2]! && y + r > set[i + 1]! && y - r < set[i + 3]!) return true;
        }
      }
      return false;
    };
    if (!hits(sx, sy)) {
      g.shrink += (1 - g.shrink) * (1 - Math.exp(-dt * 3));
      return;
    }
    // 找最近的一处空地（16 个方向、每 40 px 一步、最远约 1000 px），还得在视口里；往那里缓缓挪过去
    const margin = r * 0.6;
    let best: [number, number] | null = null;
    for (let step = 1; step <= 25 && !best; step++) {
      for (let k = 0; k < 16 && !best; k++) {
        const a = (k / 16) * Math.PI * 2;
        const nx = sx + Math.cos(a) * step * 40;
        const ny = sy + Math.sin(a) * step * 40;
        if (nx < margin || nx > f.vw - margin || ny < 56 + margin || ny > f.vh - margin) continue;
        if (!hits(nx, ny)) best = [nx, ny];
      }
    }
    const pxPerUnit = f.vh / (2 * Math.tan((this.camera.fov * Math.PI) / 360) * Math.max(0.5, this.camera.position.distanceTo(c)));
    const want = new THREE.Vector3();
    if (best) {
      // 视口的 x 向右、y 向下；世界的 y 向上
      want.set((best[0] - sx) / pxPerUnit, -(best[1] - sy) / pxPerUnit, 0);
      const dist = want.length();
      want.setLength(Math.min(g.u * 2, dist * 2.5));
    } else {
      // 实在没有空地：整组等比例缩小（缝照样严丝合缝），让出正文；挪开以后再长回原样
      g.shrink += (0.45 - g.shrink) * (1 - Math.exp(-dt * 3));
    }
    g.vel.lerp(want, 1 - Math.exp(-dt * 5));
  }

  private renderBlurred(layer: Layer, radius: number, opacity: number): void {
    const r = this.renderer;
    this.camera.layers.set(layer);
    r.setRenderTarget(this.rtA);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, true);
    r.render(this.scene, this.camera);
    this.quad.material = this.blurMat;
    for (let pass = 0; pass < 2; pass++) {
      const s = radius * (pass + 1) * 0.5;
      this.blurMat.uniforms.tMap!.value = this.rtA.texture;
      (this.blurMat.uniforms.uDir!.value as THREE.Vector2).set(s / this.rtA.width, 0);
      r.setRenderTarget(this.rtB);
      r.clear(true, false, false);
      r.render(this.quadScene, this.quadCam);
      this.blurMat.uniforms.tMap!.value = this.rtB.texture;
      (this.blurMat.uniforms.uDir!.value as THREE.Vector2).set(0, s / this.rtA.height);
      r.setRenderTarget(this.rtA);
      r.clear(true, false, false);
      r.render(this.quadScene, this.quadCam);
    }
    this.quad.material = this.compMat;
    this.compMat.uniforms.tMap!.value = this.rtA.texture;
    this.compMat.uniforms.uOpacity!.value = opacity;
    r.setRenderTarget(null);
    r.render(this.quadScene, this.quadCam);
  }

  private render(_parts: boolean): void {
    const r = this.renderer;
    r.setRenderTarget(null);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, true);
    this.renderBlurred(0, 2.2, 1);
    this.camera.layers.set(1);
    r.setRenderTarget(null);
    r.clearDepth();
    r.render(this.scene, this.camera);
    this.renderBlurred(2, 4.5, 0.95);
    this.camera.layers.enableAll();
  }

  dispose(): void {
    this.disposed = true;
    this.sculpture?.dispose();
    for (const m of this.allMaterials) {
      m.map?.dispose();
      m.dispose();
    }
    this.allayMat?.map?.dispose();
    this.allayMat?.dispose();
    this.blurMat.dispose();
    this.compMat.dispose();
    this.rtA.dispose();
    this.rtB.dispose();
    this.geo.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}

function easeInOut(x: number): number {
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

/** 入场：按顺序带一点过冲地弹出 */
function popScale(ms: number, delay: number, still: boolean): number {
  if (still) return 1;
  return Math.max(0.0001, popCurve(Math.min(1, Math.max(0, (ms - delay) / 900))));
}

function popCurve(p: number): number {
  const c1 = 1.5;
  return p >= 1 ? 1 : 1 + (c1 + 1) * (p - 1) ** 3 + c1 * (p - 1) ** 2;
}

/** 三维的临界阻尼弹簧 */
function springVec(pos: THREE.Vector3, vel: THREE.Vector3, target: THREE.Vector3, omega: number, dt: number): void {
  for (const k of ['x', 'y', 'z'] as const) {
    const x = pos[k] - target[k];
    const e = Math.exp(-omega * dt);
    const nx = (x + (vel[k] + omega * x) * dt) * e;
    const nv = (vel[k] - omega * (vel[k] + omega * x) * dt) * e;
    pos[k] = target[k] + nx;
    vel[k] = nv;
  }
}
