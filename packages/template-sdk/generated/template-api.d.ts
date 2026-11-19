// 模板接口的类型定义（自包含，不依赖任何包）。
// 由 pnpm templates:api 从 packages/template-sdk/src/runtime.ts 和 scripts/template-api/three-surface.d.ts 生成，不要直接改。
//
// 用法：放在模板文件夹里，与 template.js 同级；在 template.js 的默认导出上加
//   /** @type {import('./template-api').TemplateModule} */
// 编辑器就能对 ctx 补全。ctx.THREE 只声明了模板常用的类和成员（与真实的 three.js 兼容），
// 没列出的成员运行时照样可用，只是没有补全。

/** 参数值。具体类型由 manifest 的参数定义决定（4.4） */
export type ParamValue = number | string | boolean | null | ParamValue[] | { [key: string]: ParamValue };
export type ParamValues = Record<string, ParamValue>;

export interface StageInfo {
  /** 设计单位：短边恒为 1080（02-engine.md 2.5） */
  width: number;
  height: number;
  aspect: number;
  fps: number;
  /** 输出短边像素 / 1080 */
  pixelScale: number;
  /** 输出未缩小前的参考像素尺寸；缺省时由 width、height 和 pixelScale 推出。 */
  referenceSize?: Readonly<{ width: number; height: number }>;
}

export interface Rng {
  /** [0, 1) */
  next(): number;
  /** [a, b) */
  range(a: number, b: number): number;
  /** [a, b] 内的整数 */
  int(a: number, b: number): number;
  /** 从数组里等概率取一个 */
  pick<T>(items: readonly T[]): T;
  /** 原地打乱并返回同一个数组 */
  shuffle<T>(items: T[]): T[];
}

export type EaseFn = (x: number) => number;

export type EasingName =
  | 'linear'
  | 'quadIn' | 'quadOut' | 'quadInOut'
  | 'cubicIn' | 'cubicOut' | 'cubicInOut'
  | 'quartIn' | 'quartOut' | 'quartInOut'
  | 'quintIn' | 'quintOut' | 'quintInOut'
  | 'expoIn' | 'expoOut' | 'expoInOut'
  | 'circIn' | 'circOut' | 'circInOut'
  | 'backIn' | 'backOut' | 'backInOut'
  | 'elasticOut' | 'bounceOut';

/** easing 参数的值：预设名或三次贝塞尔控制点 */
export type EasingValue = EasingName | readonly [number, number, number, number];

export type EaseLibrary = Readonly<Record<EasingName, EaseFn>> & {
  bezier(x1: number, y1: number, x2: number, y2: number): EaseFn;
  /** 把 easing 参数的值变成函数；认不出的值退回 linear */
  from(value: unknown): EaseFn;
};

export interface MathHelpers {
  /** 把 x 钳制到 [min, max] */
  clamp(x: number, min: number, max: number): number;
  /** a + (b − a) × t */
  lerp(a: number, b: number, t: number): number;
  /** lerp 的反函数：(x − a) / (b − a) */
  invLerp(a: number, b: number, x: number): number;
  /** 把 x 从 [inMin, inMax] 线性映射到 [outMin, outMax] */
  remap(x: number, inMin: number, inMax: number, outMin: number, outMax: number): number;
  /** x 在 [edge0, edge1] 之间的平滑过渡（三次 Hermite），两端钳制到 0 和 1 */
  smoothstep(edge0: number, edge1: number, x: number): number;
}

export interface SetupContext {
  /** three.js（r187）。只声明了常用的类和成员，见本文件末尾的 THREE 命名空间；没列出的成员运行时照样可用 */
  THREE: typeof THREE;
  /** 宿主在装载时提供的语言标签，例如 zh-CN；省略时为 en */
  readonly locale: string;
  /** 参数值（manifest 的 params 声明）。已经清洗过：类型不对的回到默认值，越界的钳制，缺的补默认值 */
  params: Readonly<ParamValues>;
  /** 舞台：设计单位下的宽高（短边恒为 1080，原点在中心，+y 向上）、宽高比、帧率、像素比例 */
  stage: Readonly<StageInfo>;
  /** 往里加东西的场景。setup 结束后引擎回收场景里剩下的几何体和材质 */
  scene: THREE.Scene;
  /** 当前相机。默认是正交相机，刚好覆盖整个舞台 */
  camera: THREE.Camera;
  /** 换相机（比如换成 createStageCamera 建的透视相机） */
  setCamera(camera: THREE.Camera): void;
  /** 建一台透视相机（fov 是垂直视角，度），位置已算好，z = 0 平面恰好填满舞台 */
  createStageCamera(opts: { fov: number }): THREE.PerspectiveCamera;
  /** 贴图、方块、物品。都在 setup 里 await 完，update 里不要再取 */
  resources: {
    /** 已设好过滤和色彩空间的贴图；缺失时返回占位图并记一条警告。.mcmeta 动画由引擎按 t 自动播放 */
    texture(id: string): Promise<THREE.Texture>;
    /** 同一已授权资源栈和原 ID；取不到时返回 null，不返回占位贴图。同一资源代内缓存探测结果 */
    optionalTexture(id: string): Promise<THREE.Texture | null>;
    /** 方块目录里的方块；不认识的 ID 用占位贴图的立方体并记一条警告 */
    block(id: string, opts?: { shading?: boolean }): Promise<BlockHandle>;
    /** 物品目录里的物品（方块 ID 按方块渲染）；不认识的 ID 用占位贴图并记一条警告 */
    item(id: string): Promise<ItemHandle>;
  };
  /** 用资源栈字体及本机系统字体排一段文字 */
  text: {
    /** 按 font 参数声明的字体自动预载；程序生成的字体 ID 可在 setup 里显式预载 */
    prepare(font: string): Promise<void>;
    /** 量一行 GUI 文字的笔宽和基线边界，与 create 选用相同字形，不创建文字贴图或场景对象。 */
    measureGui(text: string, font?: string): GuiTextMetrics;
    /** 同步创建文字；逐字使用已选资源栈字体、minecraft:default、本机系统字体 */
    create(opts: TextOptions): TextObject;
  };
  /** 贴图四边形，可带九宫格 */
  sprite: { /** 用一张贴图建精灵；中心在原点 */ create(texture: THREE.Texture, opts?: SpriteOptions): SpriteObject };
  /** 带种子的随机数（种子取模板的 seed 参数）。同一个 key 总是给出同一串数，不同 key 互不影响。在 setup 里预先算好，update 里只查表 */
  random(key?: string): Rng;
  /** 带种子的连续二维噪声（simplex），值约在 [-1, 1]；同样的输入总是同样的输出 */
  noise2D(x: number, y: number, key?: string): number;
  /** 缓动函数：预设名（如 ease.cubicInOut）、bezier(x1, y1, x2, y2)、from(easing 参数的值) */
  ease: EaseLibrary;
  /** 常用的数学小工具 */
  math: MathHelpers;
  /** 时间工具 */
  time: { /** t 在 [start, start + duration] 里的进度，钳制到 [0, 1] */ segment(t: number, start: number, duration: number): number };
  /** 音频提示 */
  audio: { /** 在时刻 at（秒）播放音效事件；只能在 setup 里调用。sound 为 null 时什么也不做 */ cue(sound: string | null, at: number, opts?: { gain?: number; rate?: number; pan?: number; position?: readonly [x: number, y: number, z: number] }): void };
  /** 记一条警告（一次装载最多 50 条）；实际回退时可在 setup 内附上资源提示码，宿主据此显示简短提示。 */
  warn(message: string, code?: 'panorama-fallback'): void;
}

/** 方块的六个面：上、下、北（-z）、南（+z，朝向默认相机）、东（+x）、西（-x） */
export type BlockFace = 'up' | 'down' | 'north' | 'south' | 'east' | 'west';

export interface BlockHandle {
  /** 边长为 1 的方块，中心在原点，模板自己缩放 */
  single(): THREE.Object3D;
  /** 建 count 个实例（一次绘制）；用 setMatrix 等摆放，每帧改完调用一次 commit() */
  instanced(count: number): BlockInstances;
  /**
   * 方块某个面用的贴图（按方块目录；不含草方块侧面的叠加层，不带面明暗和着色），供着色器平铺等用途。
   * 返回引擎缓存里的贴图：模板不要释放它，也不要改它的属性（例如 wrapS）。
   */
  faceTexture(face: BlockFace): THREE.Texture;
}

export interface BlockInstances {
  /** 加到场景里 */
  object: THREE.Object3D;
  /** 实例个数 */
  count: number;
  /** 第 index 个实例的变换 */
  setMatrix(index: number, matrix: THREE.Matrix4): void;
  /** 0–1 */
  setOpacity(index: number, opacity: number): void;
  /** 第 index 个实例的染色（与贴图相乘） */
  setTint(index: number, color: THREE.ColorRepresentation): void;
  /** 一帧里改完所有实例后调用一次 */
  commit(): void;
}

/** 物品：高度为 1，厚度为 1/16，中心在原点 */
export interface ItemHandle {
  /** 一个物品的 3D 模型（有厚度的贴图） */
  single(): THREE.Object3D;
}

export interface TextOptions {
  text: string;
  /** 资源栈字体 ID，默认 minecraft:default。逐字回退到 minecraft:default，再用系统字体；旧字体引用等同默认。 */
  font?: string;
  /** 一个字体像素对应多少设计单位 */
  size: number;
  /** #RRGGBB，默认白色 */
  color?: string;
  shadow?: boolean;
  align?: 'left' | 'center' | 'right';
  /** 设计单位；超过时按空格（中日韩字符逐字）换行 */
  maxWidth?: number;
  /** 单行 GUI 度量：纵向原点为基线，使用字体的逻辑字号而非源像素尺寸。 */
  origin?: 'guiBaseline';
}

export interface GuiTextMetrics {
  /** 以 GUI 像素计的笔尖前进量和绘制宽度。 */
  advance: number;
  width: number;
  /** 字形越出笔尖左侧时为负，单位为 GUI 像素。 */
  left: number;
  /** 字形范围在基线以上、以下的 GUI 像素数。 */
  above: number;
  below: number;
}

/** 文字对象。默认纵向原点在整段文字中线；guiBaseline 模式用基线，左对齐以笔尖为横向原点。 */
export interface TextObject {
  /** 加到场景里 */
  object: THREE.Object3D;
  /** 设计单位 */
  width: number;
  height: number;
  /** 0–1 */
  setOpacity(opacity: number): void;
}

export interface SpriteOptions {
  /** 九宫格边框 [左, 上, 右, 下]，单位是贴图像素。不给时用贴图 .mcmeta 里的 gui.scaling（若有） */
  nineSlice?: [number, number, number, number];
  /** 一个贴图像素对应多少设计单位，默认 1 */
  pixelSize?: number;
}

/** 精灵：中心在原点的贴图四边形 */
export interface SpriteObject {
  /** 加到场景里 */
  object: THREE.Object3D;
  /** 设计单位 */
  setSize(width: number, height: number): void;
  /** 0–1 */
  setOpacity(opacity: number): void;
}

/** 已生效的阶段时长（秒），键与 manifest.timeline.segments 对应。 */
export interface EffectiveTiming {
  durations: Readonly<Record<string, number>>;
  /** 当前阶段是否由对应的 duration 参数控制。 */
  editable: boolean;
}

export interface TemplateInstance {
  /** 秒，0.1–30 */
  duration: number;
  /** 转场类必填 */
  cutTime?: number | null;
  /** 参数与实际阶段不一定相等时，返回这次装载使用的时长。 */
  timing?: EffectiveTiming;
  /** 把画面摆到时刻 t（秒）。只能依赖 t 和 setup 时建立的状态；引擎可能按任意顺序、多次调用 */
  update(t: number): void;
  /** 释放 setup 里自己创建的几何体、材质、贴图 */
  dispose?(): void;
}

/** 模板文件的默认导出 */
export interface TemplateModule {
  /** 建场景、取资源、预先算好随机数，返回实例。可以是 async 的 */
  setup(ctx: SetupContext): TemplateInstance | Promise<TemplateInstance>;
}

// ---- ctx.THREE 的最小类型面 ----

export declare namespace THREE {
  type ColorSpace = '' | 'srgb' | 'srgb-linear' | 'display-p3' | 'display-p3-linear';
  type ColorRepresentation = Color | string | number;

  const SRGBColorSpace: 'srgb';
  const LinearSRGBColorSpace: 'srgb-linear';
  const NoColorSpace: '';

  const FrontSide: 0;
  const BackSide: 1;
  const DoubleSide: 2;
  type Side = 0 | 1 | 2;

  const NoBlending: 0;
  const NormalBlending: 1;
  const AdditiveBlending: 2;
  const SubtractiveBlending: 3;
  const MultiplyBlending: 4;
  type Blending = 0 | 1 | 2 | 3 | 4 | 5 | 6;

  const NearestFilter: 1003;
  const LinearFilter: 1006;
  const LinearMipmapLinearFilter: 1008;
  type MagnificationTextureFilter = 1003 | 1006;
  type MinificationTextureFilter = 1003 | 1004 | 1005 | 1006 | 1007 | 1008;

  const RepeatWrapping: 1000;
  const ClampToEdgeWrapping: 1001;
  const MirroredRepeatWrapping: 1002;
  type Wrapping = 1000 | 1001 | 1002;

  const UnsignedByteType: 1009;
  const FloatType: 1015;
  const HalfFloatType: 1016;
  const RedFormat: 1028;
  const RGFormat: 1030;
  const RGBAFormat: 1023;

  namespace MathUtils {
    const DEG2RAD: number;
    const RAD2DEG: number;
    function clamp(value: number, min: number, max: number): number;
    function lerp(x: number, y: number, t: number): number;
    function inverseLerp(x: number, y: number, value: number): number;
    function mapLinear(x: number, a1: number, a2: number, b1: number, b2: number): number;
    function smoothstep(x: number, min: number, max: number): number;
    function degToRad(degrees: number): number;
    function radToDeg(radians: number): number;
    function euclideanModulo(n: number, m: number): number;
  }

  class Vector2 {
    constructor(x?: number, y?: number);
    x: number;
    y: number;
    set(x: number, y: number): this;
    setScalar(scalar: number): this;
    copy(v: Vector2): this;
    clone(): Vector2;
    add(v: Vector2): this;
    sub(v: Vector2): this;
    multiplyScalar(s: number): this;
    lerp(v: Vector2, alpha: number): this;
    length(): number;
    normalize(): this;
    dot(v: Vector2): number;
  }

  class Vector3 {
    constructor(x?: number, y?: number, z?: number);
    x: number;
    y: number;
    z: number;
    set(x: number, y: number, z: number): this;
    setScalar(scalar: number): this;
    copy(v: Vector3): this;
    clone(): Vector3;
    add(v: Vector3): this;
    sub(v: Vector3): this;
    addVectors(a: Vector3, b: Vector3): this;
    subVectors(a: Vector3, b: Vector3): this;
    multiplyScalar(s: number): this;
    applyQuaternion(q: Quaternion): this;
    applyMatrix4(m: Matrix4): this;
    lerp(v: Vector3, alpha: number): this;
    lerpVectors(v1: Vector3, v2: Vector3, alpha: number): this;
    length(): number;
    normalize(): this;
    dot(v: Vector3): number;
    cross(v: Vector3): this;
  }

  class Vector4 {
    constructor(x?: number, y?: number, z?: number, w?: number);
    x: number;
    y: number;
    z: number;
    w: number;
    set(x: number, y: number, z: number, w: number): this;
    copy(v: Vector4): this;
    clone(): Vector4;
  }

  class Euler {
    constructor(x?: number, y?: number, z?: number, order?: 'XYZ' | 'YXZ' | 'ZXY' | 'ZYX' | 'YZX' | 'XZY');
    x: number;
    y: number;
    z: number;
    set(x: number, y: number, z: number, order?: 'XYZ' | 'YXZ' | 'ZXY' | 'ZYX' | 'YZX' | 'XZY'): this;
    copy(e: Euler): this;
  }

  class Quaternion {
    constructor(x?: number, y?: number, z?: number, w?: number);
    x: number;
    y: number;
    z: number;
    w: number;
    set(x: number, y: number, z: number, w: number): this;
    identity(): this;
    copy(q: Quaternion): this;
    setFromAxisAngle(axis: Vector3, angle: number): this;
    setFromEuler(euler: Euler): this;
    multiply(q: Quaternion): this;
    premultiply(q: Quaternion): this;
    slerp(qb: Quaternion, t: number): this;
  }

  class Matrix4 {
    constructor();
    elements: number[];
    identity(): this;
    copy(m: Matrix4): this;
    compose(position: Vector3, quaternion: Quaternion, scale: Vector3): this;
    decompose(position: Vector3, quaternion: Quaternion, scale: Vector3): this;
    multiply(m: Matrix4): this;
    premultiply(m: Matrix4): this;
    makeTranslation(x: number, y: number, z: number): this;
    makeRotationX(theta: number): this;
    makeRotationY(theta: number): this;
    makeRotationZ(theta: number): this;
    makeRotationAxis(axis: Vector3, angle: number): this;
    makeScale(x: number, y: number, z: number): this;
  }

  class Color {
    constructor(color?: ColorRepresentation);
    constructor(r: number, g: number, b: number);
    r: number;
    g: number;
    b: number;
    set(...args: [color: ColorRepresentation] | [r: number, g: number, b: number]): this;
    setRGB(r: number, g: number, b: number, colorSpace?: ColorSpace): this;
    setHSL(h: number, s: number, l: number, colorSpace?: ColorSpace): this;
    setStyle(style: string, colorSpace?: ColorSpace): this;
    copy(color: Color): this;
    clone(): Color;
    lerp(color: Color, alpha: number): this;
    multiplyScalar(s: number): this;
    getHex(colorSpace?: ColorSpace): number;
    getHexString(colorSpace?: ColorSpace): string;
  }

  class Object3D {
    constructor();
    readonly isObject3D: boolean;
    name: string;
    parent: Object3D | null;
    children: Object3D[];
    readonly position: Vector3;
    readonly rotation: Euler;
    readonly quaternion: Quaternion;
    readonly scale: Vector3;
    matrix: Matrix4;
    matrixAutoUpdate: boolean;
    visible: boolean;
    renderOrder: number;
    frustumCulled: boolean;
    userData: Record<string, unknown>;
    add(...object: Object3D[]): this;
    remove(...object: Object3D[]): this;
    removeFromParent(): this;
    clear(): this;
    traverse(callback: (object: Object3D) => unknown): void;
    lookAt(x: number, y: number, z: number): void;
    rotateX(angle: number): this;
    rotateY(angle: number): this;
    rotateZ(angle: number): this;
    updateMatrix(): void;
  }

  class Group extends Object3D {
    constructor();
    readonly isGroup: boolean;
  }

  class Scene extends Object3D {
    constructor();
    readonly isScene: boolean;
  }

  class Camera extends Object3D {
    constructor();
    readonly isCamera: boolean;
  }

  class PerspectiveCamera extends Camera {
    constructor(fov?: number, aspect?: number, near?: number, far?: number);
    readonly isPerspectiveCamera: boolean;
    fov: number;
    aspect: number;
    near: number;
    far: number;
    zoom: number;
    updateProjectionMatrix(): void;
  }

  class OrthographicCamera extends Camera {
    constructor(left?: number, right?: number, top?: number, bottom?: number, near?: number, far?: number);
    readonly isOrthographicCamera: boolean;
    left: number;
    right: number;
    top: number;
    bottom: number;
    near: number;
    far: number;
    zoom: number;
    updateProjectionMatrix(): void;
  }

  /** 只作类型用：模板不需要自己建顶点属性 */
  interface BufferAttribute {
    readonly count: number;
    readonly itemSize: number;
    needsUpdate: boolean;
    getX(index: number): number;
    getY(index: number): number;
    getZ(index: number): number;
    getW(index: number): number;
    setXY(index: number, x: number, y: number): this;
    setXYZ(index: number, x: number, y: number, z: number): this;
  }

  const Float32BufferAttribute: {
    new (array: Iterable<number> | ArrayLike<number> | ArrayBuffer | number, itemSize: number, normalized?: boolean): BufferAttribute;
  };

  class BufferGeometry {
    constructor();
    readonly isBufferGeometry: boolean;
    groups: Array<{ start: number; count: number; materialIndex?: number | undefined }>;
    getAttribute(name: string): BufferAttribute | undefined;
    setAttribute(name: string, attribute: BufferAttribute): this;
    getIndex(): BufferAttribute | null;
    translate(x: number, y: number, z: number): this;
    scale(x: number, y: number, z: number): this;
    rotateX(angle: number): this;
    rotateY(angle: number): this;
    rotateZ(angle: number): this;
    dispose(): void;
  }

  class PlaneGeometry extends BufferGeometry {
    constructor(width?: number, height?: number, widthSegments?: number, heightSegments?: number);
  }

  class BoxGeometry extends BufferGeometry {
    constructor(width?: number, height?: number, depth?: number, widthSegments?: number, heightSegments?: number, depthSegments?: number);
  }

  class CircleGeometry extends BufferGeometry {
    constructor(radius?: number, segments?: number, thetaStart?: number, thetaLength?: number);
  }

  interface MaterialParameters {
    opacity?: number | undefined;
    transparent?: boolean | undefined;
    side?: Side | undefined;
    blending?: Blending | undefined;
    depthTest?: boolean | undefined;
    depthWrite?: boolean | undefined;
    alphaTest?: number | undefined;
    toneMapped?: boolean | undefined;
    vertexColors?: boolean | undefined;
  }

  class Material {
    constructor();
    readonly isMaterial: boolean;
    opacity: number;
    transparent: boolean;
    side: Side;
    blending: Blending;
    depthTest: boolean;
    depthWrite: boolean;
    alphaTest: number;
    toneMapped: boolean;
    vertexColors: boolean;
    visible: boolean;
    needsUpdate: boolean;
    dispose(): void;
  }

  interface MeshBasicMaterialParameters extends MaterialParameters {
    color?: ColorRepresentation | undefined;
    map?: Texture | null | undefined;
    alphaMap?: Texture | null | undefined;
  }

  class MeshBasicMaterial extends Material {
    constructor(parameters?: MeshBasicMaterialParameters);
    readonly isMeshBasicMaterial: boolean;
    color: Color;
    map: Texture | null;
    alphaMap: Texture | null;
  }

  interface IUniform<T = unknown> {
    value: T;
  }

  interface ShaderMaterialParameters extends MaterialParameters {
    uniforms?: { [uniform: string]: IUniform } | undefined;
    vertexShader?: string | undefined;
    fragmentShader?: string | undefined;
    defines?: { [key: string]: unknown } | undefined;
  }

  class ShaderMaterial extends Material {
    constructor(parameters?: ShaderMaterialParameters);
    readonly isShaderMaterial: boolean;
    uniforms: { [uniform: string]: IUniform };
    vertexShader: string;
    fragmentShader: string;
  }

  class Mesh extends Object3D {
    constructor(geometry?: BufferGeometry, material?: Material | Material[]);
    readonly isMesh: boolean;
    geometry: BufferGeometry;
    material: Material | Material[];
  }

  class Texture {
    readonly isTexture: boolean;
    /** 图像数据（类型与 three 一致是 unknown）。引擎给的贴图都有 width、height（像素），读之前自己断言类型 */
    image: unknown;
    magFilter: MagnificationTextureFilter;
    minFilter: MinificationTextureFilter;
    wrapS: Wrapping;
    wrapT: Wrapping;
    colorSpace: string;
    generateMipmaps: boolean;
    flipY: boolean;
    readonly offset: Vector2;
    readonly repeat: Vector2;
    needsUpdate: boolean;
    clone(): this;
    dispose(): void;
  }

  class DataTexture extends Texture {
    constructor(data?: ArrayBufferView | null, width?: number, height?: number, format?: number, type?: number);
    readonly isDataTexture: boolean;
  }
}
