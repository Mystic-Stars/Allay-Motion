// 帧管线（docs/02-engine.md 2.6）：子帧 → sceneRT（RGBA16F、线性、2×2 超采样、预乘 alpha）
// → 2×2 平均后加法累积进 accumRT（RGBA16F）→ 全屏 resolve 着色器输出到 8 位目标。
//
// 抗锯齿用 2×2 超采样而不是规格写的 MSAA 4×：实测硬件的多重采样 resolve 不是逐位可复现的（NVIDIA/D3D11 上同一帧
// 反复渲染，恰好落在取整边界上的像素会在 127/128 之间跳），破坏 T-ENG-1。超采样的平均在我们自己的着色器里按固定顺序做，
// 结果只取决于输入（docs/decisions.md M3“多重采样 resolve 不确定”）。显存与 MSAA 4× 相同。
import {
  AddEquation,
  BufferGeometry,
  CustomBlending,
  Float32BufferAttribute,
  GLSL3,
  HalfFloatType,
  Mesh,
  NearestFilter,
  NoBlending,
  OneFactor,
  OneMinusSrcAlphaFactor,
  OrthographicCamera,
  RawShaderMaterial,
  RGBAFormat,
  Scene,
  UnsignedByteType,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type Camera,
  type Object3D,
  type Texture,
  type WebGLRenderer,
} from 'three';
import type { LayerTransform } from './composition-timing';

/** resolve 的三种模式 */
export type ResolveMode = 'preview' | 'straight' | 'opaque';
const MODE_CODE: Record<ResolveMode, number> = { preview: 0, straight: 1, opaque: 2 };

const VERTEX = /* glsl */ `
in vec3 position;
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

// 把子帧按权重 1/N 加进 accumRT（混合方式是 ONE, ONE）
/** 超采样倍数（每边） */
export const SUPERSAMPLE = 2;

// 把 sceneRT 的 uScale × uScale 个像素按固定顺序平均，乘上权重（1/N）累积进 accumRT
const ACCUMULATE = /* glsl */ `
precision highp float;
precision highp sampler2D;
uniform sampler2D tSrc;
uniform float uWeight;
uniform int uScale;
out highp vec4 fragColor;
void main() {
  ivec2 base = ivec2(gl_FragCoord.xy) * uScale;
  vec4 sum = vec4(0.0);
  for (int y = 0; y < uScale; y++) {
    vec4 row = vec4(0.0);
    for (int x = 0; x < uScale; x++) row += texelFetch(tSrc, base + ivec2(x, y), 0);
    sum += row;
  }
  fragColor = sum * (uWeight / float(uScale * uScale));
}`;

const COMPOSITE = /* glsl */ `
precision highp float;
precision highp sampler2D;
uniform sampler2D tSrc;
uniform vec2 uStage;
uniform vec2 uOffset;
uniform vec2 uRotation;
uniform float uScale;
uniform float uOpacity;
out highp vec4 fragColor;
void main() {
  vec2 size = vec2(textureSize(tSrc, 0));
  vec2 p = (gl_FragCoord.xy / size - 0.5) * uStage - uOffset;
  vec2 uv = mat2(uRotation.x, -uRotation.y, uRotation.y, uRotation.x) * p / (uStage * uScale) + 0.5;
  fragColor = any(lessThan(uv, vec2(0.0))) || any(greaterThanEqual(uv, vec2(1.0))) ? vec4(0.0) : texture(tSrc, uv) * uOpacity;
}`;

// 源缓冲是线性、预乘 alpha。
// 预览：反预乘 → 线性转 sRGB → 再预乘（canvas 是 premultipliedAlpha: true）。
// 导出（透明）：反预乘 rgb / max(a, 1e-5) → 线性转 sRGB，输出直通 alpha。
// 导出（不透明）：在线性空间盖到底色上 → 转 sRGB，alpha 写 1。
// uFlipY 为真时采样翻转 v，这样 readPixels 读出的第一行就是画面顶部，CPU 不用再翻。
const RESOLVE = /* glsl */ `
precision highp float;
precision highp sampler2D;
uniform sampler2D tSrc;
uniform int uMode;
uniform bool uFlipY;
uniform vec3 uBackground;
out highp vec4 fragColor;

vec3 linearToSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}

void main() {
  ivec2 size = textureSize(tSrc, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  if (uFlipY) p.y = size.y - 1 - p.y;
  vec4 c = texelFetch(tSrc, p, 0);
  float a = clamp(c.a, 0.0, 1.0);
  if (uMode == 2) {
    fragColor = vec4(linearToSrgb(c.rgb + uBackground * (1.0 - a)), 1.0);
    return;
  }
  vec3 srgb = linearToSrgb(c.rgb / max(a, 1e-5));
  fragColor = uMode == 0 ? vec4(srgb * a, a) : vec4(srgb, a);
}`;

function fullscreenTriangle(): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  return g;
}

function halfFloatTarget(width: number, height: number, samples: number, depth: boolean): WebGLRenderTarget {
  const rt = new WebGLRenderTarget(width, height, {
    type: HalfFloatType,
    format: RGBAFormat,
    samples,
    depthBuffer: depth,
    stencilBuffer: false,
    generateMipmaps: false,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
  });
  return rt;
}

export interface PipelineRenderOptions {
  scene: Scene;
  camera: Camera;
  /** 子帧时间；长度就是 N */
  times: readonly number[];
  /** 在每个子帧前调用（模板的 update） */
  update(t: number): void;
}

interface LayerPass {
  scene: Scene;
  camera: Camera;
  transform: LayerTransform;
}

export interface CompositionRenderOptions {
  times: readonly number[];
  stage: { width: number; height: number };
  layersAt(time: number, draw: (layer: LayerPass) => void): void;
}

type RenderOptions = PipelineRenderOptions | CompositionRenderOptions;

export class FramePipeline {
  private width: number;
  private height: number;
  /** 实际的超采样倍数：输出的 2 倍超过显卡的最大尺寸时退回 1（不抗锯齿） */
  private scale = SUPERSAMPLE;
  private readonly maxSize: number;
  private sceneRT: WebGLRenderTarget;
  private accumRT: WebGLRenderTarget;
  private compositionRT: WebGLRenderTarget | null = null;
  private composite: RawShaderMaterial | null = null;
  private outRT: WebGLRenderTarget | null = null;

  private readonly passScene = new Scene();
  private readonly passCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly passMesh: Mesh;
  private readonly accumulate: RawShaderMaterial;
  private readonly resolve: RawShaderMaterial;

  constructor(
    private readonly renderer: WebGLRenderer,
    width: number,
    height: number,
    private readonly withOutputTarget: boolean,
  ) {
    this.width = width;
    this.height = height;
    const gl = renderer.getContext();
    this.maxSize = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number);
    this.scale = this.scaleFor(width, height);
    this.sceneRT = halfFloatTarget(width * this.scale, height * this.scale, 0, true);
    this.accumRT = halfFloatTarget(width, height, 0, false);
    if (withOutputTarget) this.outRT = this.makeOutputTarget();

    this.accumulate = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: VERTEX,
      fragmentShader: ACCUMULATE,
      uniforms: { tSrc: { value: null }, uWeight: { value: 1 }, uScale: { value: SUPERSAMPLE } },
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: OneFactor,
      blendDst: OneFactor,
      blendEquationAlpha: AddEquation,
      blendSrcAlpha: OneFactor,
      blendDstAlpha: OneFactor,
      depthTest: false,
      depthWrite: false,
    });
    this.resolve = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: VERTEX,
      fragmentShader: RESOLVE,
      uniforms: {
        tSrc: { value: null },
        uMode: { value: 0 },
        uFlipY: { value: false },
        uBackground: { value: new Vector3() },
      },
      blending: NoBlending,
      depthTest: false,
      depthWrite: false,
    });
    this.passMesh = new Mesh(fullscreenTriangle(), this.accumulate);
    this.passMesh.frustumCulled = false;
    this.passScene.add(this.passMesh);
  }

  get size(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  /** 当前的超采样倍数（诊断用） */
  get supersample(): number {
    return this.scale;
  }

  private scaleFor(width: number, height: number): number {
    return Math.max(width, height) * SUPERSAMPLE <= this.maxSize ? SUPERSAMPLE : 1;
  }

  setSize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.scale = this.scaleFor(width, height);
    this.sceneRT.setSize(width * this.scale, height * this.scale);
    this.compositionRT?.setSize(width * this.scale, height * this.scale);
    this.accumRT.setSize(width, height);
    this.outRT?.setSize(width, height);
  }

  /**
   * 按场景渲染时的目标（sceneRT）预先编译场景里的着色器，并逐个检查链接结果。
   * 着色器编译失败时 Three 调用 renderer.debug.onShaderError（引擎在 init 里设好，记成模板警告）。
   */
  compileScene(scene: Object3D, camera: Camera): void {
    const { renderer } = this;
    renderer.setRenderTarget(this.sceneRT);
    try {
      renderer.compile(scene, camera);
      // 链接结果在程序第一次被使用时才检查（WebGLProgram 的 onFirstUse），这里主动触发一次
      for (const program of renderer.info.programs ?? []) program.getUniforms();
    } finally {
      renderer.setRenderTarget(null);
    }
  }

  /** 渲染所有子帧，返回存着线性、预乘 alpha 结果的纹理 */
  private renderSubframes(opts: RenderOptions): Texture {
    const { renderer } = this;
    const n = opts.times.length;
    renderer.setClearColor(0x000000, 0);

    // N = 1 也经过累积通道：超采样的平均在那里做（权重 1，加到清空的 accumRT 上，结果与直接写入相同）
    renderer.setRenderTarget(this.accumRT);
    renderer.clear(true, false, false);
    const layered = 'layersAt' in opts;
    const target = layered ? this.prepareComposition() : this.sceneRT;
    this.accumulate.uniforms.tSrc!.value = target.texture;
    this.accumulate.uniforms.uWeight!.value = 1 / n;
    this.accumulate.uniforms.uScale!.value = this.scale;
    const draw = layered ? this.compositionPass(opts, target) : null;
    for (const time of opts.times) {
      if (layered) {
        renderer.setRenderTarget(target);
        renderer.clear(true, false, false);
        opts.layersAt(time, draw!);
      } else {
        opts.update(time);
        this.drawScene(opts.scene, opts.camera);
      }
      renderer.setRenderTarget(this.accumRT);
      this.passMesh.material = this.accumulate;
      renderer.render(this.passScene, this.passCamera);
    }
    return this.accumRT.texture;
  }

  private drawScene(scene: Scene, camera: Camera): void {
    this.renderer.setRenderTarget(this.sceneRT);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear(true, true, false);
    this.renderer.render(scene, camera);
  }

  private prepareComposition(): WebGLRenderTarget {
    this.composite ??= new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: VERTEX,
      fragmentShader: COMPOSITE,
      uniforms: {
        tSrc: { value: this.sceneRT.texture }, uStage: { value: new Vector2() }, uOffset: { value: new Vector2() },
        uRotation: { value: new Vector2() }, uScale: { value: 1 }, uOpacity: { value: 1 },
      },
      transparent: true,
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: OneFactor,
      blendDst: OneMinusSrcAlphaFactor,
      blendEquationAlpha: AddEquation,
      blendSrcAlpha: OneFactor,
      blendDstAlpha: OneMinusSrcAlphaFactor,
      depthTest: false,
      depthWrite: false,
    });
    return this.compositionRT ??= halfFloatTarget(this.sceneRT.width, this.sceneRT.height, 0, false);
  }

  private compositionPass(opts: CompositionRenderOptions, target: WebGLRenderTarget): (layer: LayerPass) => void {
    const material = this.composite!;
    const uniforms = material.uniforms;
    (uniforms.uStage!.value as Vector2).set(opts.stage.width, opts.stage.height);
    return ({ scene, camera, transform }) => {
      if (transform.opacity <= 0 || transform.scale <= 0) return;
      this.drawScene(scene, camera);
      this.renderer.setRenderTarget(target);
      (uniforms.uOffset!.value as Vector2).set(transform.x, transform.y);
      const radians = transform.rotation * Math.PI / 180;
      (uniforms.uRotation!.value as Vector2).set(Math.cos(radians), Math.sin(radians));
      uniforms.uScale!.value = transform.scale;
      uniforms.uOpacity!.value = Math.min(1, transform.opacity);
      this.passMesh.material = material;
      this.renderer.render(this.passScene, this.passCamera);
    };
  }

  clearComposition(): void {
    this.compositionRT?.dispose();
    this.compositionRT = null;
  }

  private runResolve(source: Texture, mode: ResolveMode, flipY: boolean, background: readonly [number, number, number]): void {
    const u = this.resolve.uniforms;
    u.tSrc!.value = source;
    u.uMode!.value = MODE_CODE[mode];
    u.uFlipY!.value = flipY;
    (u.uBackground!.value as Vector3).set(background[0], background[1], background[2]);
    this.passMesh.material = this.resolve;
    this.renderer.render(this.passScene, this.passCamera);
  }

  /** 预览：画到 canvas（默认帧缓冲） */
  renderToCanvas(opts: RenderOptions): void {
    const autoClear = this.renderer.autoClear;
    this.renderer.autoClear = false;
    try {
      const source = this.renderSubframes(opts);
      this.renderer.setRenderTarget(null);
      this.runResolve(source, 'preview', false, [0, 0, 0]);
    } finally {
      this.renderer.autoClear = autoClear;
    }
  }

  /**
   * 导出：resolve 到 8 位目标并读回。返回直通 alpha（或不透明）的 RGBA8，第一行是画面顶部。
   * background 是线性 RGB，只在 opaque 模式下用。
   */
  renderToPixels(opts: RenderOptions, mode: Exclude<ResolveMode, 'preview'>, background: readonly [number, number, number]): Uint8Array<ArrayBuffer> {
    if (!this.outRT) throw new Error('this pipeline has no output target');
    const autoClear = this.renderer.autoClear;
    this.renderer.autoClear = false;
    try {
      const source = this.renderSubframes(opts);
      this.renderer.setRenderTarget(this.outRT);
      this.runResolve(source, mode, true, background);
      const pixels = new Uint8Array(this.width * this.height * 4);
      this.renderer.readRenderTargetPixels(this.outRT, 0, 0, this.width, this.height, pixels);
      return pixels;
    } finally {
      this.renderer.setRenderTarget(null);
      this.renderer.autoClear = autoClear;
    }
  }

  private makeOutputTarget(): WebGLRenderTarget {
    return new WebGLRenderTarget(this.width, this.height, {
      type: UnsignedByteType,
      format: RGBAFormat,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
    });
  }

  dispose(): void {
    this.clearComposition();
    this.composite?.dispose();
    this.sceneRT.dispose();
    this.accumRT.dispose();
    this.outRT?.dispose();
    this.accumulate.dispose();
    this.resolve.dispose();
    this.passMesh.geometry.dispose();
  }
}
