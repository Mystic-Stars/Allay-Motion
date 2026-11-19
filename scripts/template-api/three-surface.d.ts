// ctx.THREE 的最小类型面（docs/code-editing-and-mcp-plan.md H8）。生成 template-api.d.ts 时原样嵌进去，
// 让那份类型定义自包含、不依赖 three 的类型包。只列模板实际会用到的类和成员：
// - 声明的每个成员都要与真实的 three（@types/three，版本见 packages/engine/package.json）兼容，
//   T-DEV-3 用 TypeScript 核对“真实的 three 可以赋给这里声明的类型”；
// - 没列出的成员在运行时照样存在，只是外部编辑器里没有补全。需要时在这里补，再跑 pnpm templates:api。
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
