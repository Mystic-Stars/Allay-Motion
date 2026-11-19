// 模板运行时契约（docs/04-templates.md 4.5）。只有类型，没有运行时代码。
// M2 起 ctx 的方块、物品、文字、精灵（resources.block / item、text、sprite）都已实现。
import type * as THREE from 'three';

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
  clamp(x: number, min: number, max: number): number;
  lerp(a: number, b: number, t: number): number;
  invLerp(a: number, b: number, x: number): number;
  remap(x: number, inMin: number, inMax: number, outMin: number, outMax: number): number;
  smoothstep(edge0: number, edge1: number, x: number): number;
}

export interface SetupContext {
  THREE: typeof THREE;
  /** 宿主在装载时提供的语言标签，例如 zh-CN；省略时为 en */
  readonly locale: string;
  params: Readonly<ParamValues>;
  stage: Readonly<StageInfo>;
  scene: THREE.Scene;
  camera: THREE.Camera;
  setCamera(camera: THREE.Camera): void;
  createStageCamera(opts: { fov: number }): THREE.PerspectiveCamera;
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
  text: {
    /** 按 font 参数声明的字体自动预载；程序生成的字体 ID 可在 setup 里显式预载 */
    prepare(font: string): Promise<void>;
    /** 量一行 GUI 文字的笔宽和基线边界，与 create 选用相同字形，不创建文字贴图或场景对象。 */
    measureGui(text: string, font?: string): GuiTextMetrics;
    create(opts: TextOptions): TextObject;
  };
  sprite: { create(texture: THREE.Texture, opts?: SpriteOptions): SpriteObject };
  random(key?: string): Rng;
  noise2D(x: number, y: number, key?: string): number;
  ease: EaseLibrary;
  math: MathHelpers;
  time: { segment(t: number, start: number, duration: number): number };
  audio: { cue(sound: string | null, at: number, opts?: { gain?: number; rate?: number; pan?: number; position?: readonly [x: number, y: number, z: number] }): void };
  warn(message: string, code?: 'panorama-fallback'): void;
}

/** 方块的六个面：上、下、北（-z）、南（+z，朝向默认相机）、东（+x）、西（-x） */
export type BlockFace = 'up' | 'down' | 'north' | 'south' | 'east' | 'west';

export interface BlockHandle {
  /** 边长为 1 的方块，中心在原点，模板自己缩放 */
  single(): THREE.Object3D;
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
  count: number;
  setMatrix(index: number, matrix: THREE.Matrix4): void;
  /** 0–1 */
  setOpacity(index: number, opacity: number): void;
  setTint(index: number, color: THREE.ColorRepresentation): void;
  /** 一帧里改完所有实例后调用一次 */
  commit(): void;
}

/** 物品：高度为 1，厚度为 1/16，中心在原点 */
export interface ItemHandle {
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
  object: THREE.Object3D;
  /** 设计单位 */
  width: number;
  height: number;
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
  object: THREE.Object3D;
  /** 设计单位 */
  setSize(width: number, height: number): void;
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
  update(t: number): void;
  dispose?(): void;
}

/** 模板文件的默认导出 */
export interface TemplateModule {
  setup(ctx: SetupContext): TemplateInstance | Promise<TemplateInstance>;
}
