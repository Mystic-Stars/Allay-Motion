import type { SetupContext } from '@allay/template-sdk';
import { VERTEX } from './visuals';
import { endClock, END_LAYERS, panoramaBlurKernel, panoramaBlurTaps } from './java-optics';

export const PANORAMA_IDS = Array.from({ length: 6 }, (_, face) => `minecraft:gui/title/background/panorama_${face}`);
export const JAVA_TEXTURES = {
  panoramaOverlay: 'minecraft:gui/title/background/panorama_overlay',
  menu: 'minecraft:gui/menu_background',
  dirt: 'minecraft:gui/options_background',
  dirtBlock: 'minecraft:block/dirt',
  nether: 'minecraft:block/nether_portal',
  endSky: 'minecraft:environment/end_sky',
  end1211: 'minecraft:entity/end_portal',
  end263: 'minecraft:entity/end_portal/end_portal',
  logoWhite: 'minecraft:gui/title/mojang',
  logoRed: 'minecraft:gui/title/mojangstudios',
} as const;

export type JavaBackdrop = 'white' | 'red' | 'dirt' | 'javaPanorama' | 'netherPortal' | 'endPortal';
type Texture = Awaited<ReturnType<SetupContext['resources']['optionalTexture']>>;

export function panProjection(time: number, moving: boolean, speed = 1) {
  const yaw = (moving ? time * 2 * speed : 0) * Math.PI / 180;
  return { sin: Math.sin(yaw), cos: Math.cos(yaw), focal: Math.tan(85 * Math.PI / 360) };
}

export function javaGuiScale(width: number, height: number): number {
  return Math.min(Math.min(width, height) / 270, width / 320);
}

export function warnJavaAsset(ctx: SetupContext, asset: string, fallback: string, fallbackZh: string, code?: Parameters<SetupContext['warn']>[1]): void {
  const message = ctx.locale?.toLowerCase().startsWith('zh')
    ? `Java 加载界面缺少或无法使用 ${asset}；${fallbackZh}。请启用含对应文件的原版层或资源包。`
    : `Java loading screen: ${asset} is missing or unusable; ${fallback}. Enable a vanilla layer or pack with the matching files.`;
  if (code) ctx.warn(message, code);
  else ctx.warn(message);
}

function textureSize(texture: Texture) {
  const image: unknown = texture?.image;
  if (!image || typeof image !== 'object' || !('width' in image) || !('height' in image)) return null;
  if (typeof image.width !== 'number' || typeof image.height !== 'number') return null;
  return { width: image.width, height: image.height };
}

export async function javaTexture(ctx: SetupContext, id: string, minSide = 2): Promise<NonNullable<Texture> | null> {
  const map = await ctx.resources.optionalTexture(id);
  const size = textureSize(map);
  return size && size.width >= minSide && size.height >= minSide ? map : null;
}

const FRAGMENT = /* glsl */ `
uniform sampler2D face0, face1, face2, face3, face4, face5;
uniform sampler2D picture, overlay;
uniform vec3 baseColor;
uniform vec2 stageSize, guiSize, outputSize, yaw, pitch, frameSize, frameOffset, halfTexel;
uniform float focal, opacity, phase, dissolve, seed, clockPhase, hasMenu, hasOverlay;
#ifdef PANORAMA
uniform vec2 blurTaps[5];
#endif
#ifdef END
uniform vec4 portalBasis[15];
uniform vec3 portalTints[15];
#endif
varying vec2 vUv;

vec3 toDisplay(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
vec3 toLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 panoramaDirection(vec2 position) {
  float vertical = pitch.x - position.y * pitch.y;
  float forward = pitch.y + position.y * pitch.x;
  return vec3(yaw.y * position.x + yaw.x * forward, vertical, yaw.y * forward - yaw.x * position.x);
}
vec3 panoramaSample(vec2 uv, vec2 cameraShift) {
  vec2 screenRay = (uv * 2.0 - 1.0) * focal * vec2(stageSize.x / stageSize.y, 1.0);
  vec3 ray = panoramaDirection(screenRay);
  if (dot(cameraShift, cameraShift) > 0.0) {
    vec3 origin = panoramaDirection(-cameraShift) - panoramaDirection(vec2(0));
    vec3 crossing = (mix(vec3(-1), vec3(1), step(vec3(0), ray)) - origin) / max(abs(ray), vec3(1e-8)) * sign(ray);
    crossing = mix(vec3(1e8), crossing, step(vec3(1e-8), abs(ray)));
    ray = origin + ray * min(crossing.x, min(crossing.y, crossing.z));
  }
  vec3 span = abs(ray);
  if (span.y >= max(span.x, span.z)) {
    if (ray.y < 0.0) return texture2D(face4, 0.5 + vec2(ray.x, -ray.z) / (2.0 * span.y)).rgb;
    return texture2D(face5, 0.5 + vec2(ray.x, ray.z) / (2.0 * span.y)).rgb;
  }
  if (span.x >= span.z) {
    if (ray.x > 0.0) return texture2D(face1, 0.5 + vec2(-ray.z, -ray.y) / (2.0 * span.x)).rgb;
    return texture2D(face3, 0.5 + vec2(ray.z, -ray.y) / (2.0 * span.x)).rgb;
  }
  if (ray.z > 0.0) return texture2D(face0, 0.5 + vec2(ray.x, -ray.y) / (2.0 * span.z)).rgb;
  return texture2D(face2, 0.5 + vec2(-ray.x, -ray.y) / (2.0 * span.z)).rgb;
}

#ifdef PANORAMA
vec3 panoramaDisplay(vec2 uv) {
  #ifdef LEGACY_CUBE
    vec3 base = panoramaSample(uv, vec2(-0.5) / 256.0) * 0.25196463;
    base += panoramaSample(uv, vec2(0, -0.5) / 256.0) * 0.24999616;
    base += panoramaSample(uv, vec2(-0.5, 0) / 256.0) * 0.25098039;
    base += panoramaSample(uv, vec2(0)) * 0.24705882;
  #else
    vec3 base = panoramaSample(uv, vec2(0));
  #endif
  if (hasOverlay > 0.5) {
    vec4 tint = texture2D(overlay, uv);
    base = mix(base, toDisplay(tint.rgb), tint.a);
  }
  return base;
}
#endif

#ifdef END
vec3 nearestRepeat(sampler2D map, vec2 uv) {
  ivec2 dimensions = textureSize(map, 0);
  ivec2 pixel = ivec2(fract(uv) * vec2(dimensions));
  return toDisplay(texelFetch(map, ivec2(pixel.x, dimensions.y - 1 - pixel.y), 0).rgb);
}

vec3 portalDisplay(vec2 uv) {
  vec3 radiance = nearestRepeat(picture, uv) * portalTints[0];
  for (int plane = 0; plane < 15; plane++) {
    vec4 optics = portalBasis[plane];
    vec2 rotated = vec2(dot(uv, vec2(optics.x, -optics.y)), dot(uv, optics.yx));
    vec2 translated = rotated + vec2(optics.z, 0.25 + optics.w * clockPhase);
    radiance += nearestRepeat(overlay, translated) * portalTints[plane];
  }
  return clamp(radiance, 0.0, 1.0);
}
#endif

void main() {
  vec2 local = (vUv - 0.5) * (stageSize + 2.0) + 0.5 * stageSize;
  vec2 uv = local / stageSize;
  if (abs(dissolve) > 0.5 && phase > 0.0 && phase < 1.0) {
    float threshold = fract(sin(dot(floor(local / 32.0) + seed, vec2(127.1, 311.7))) * 43758.5453);
    if (dissolve > 0.0 ? threshold >= phase : threshold < phase) discard;
  }
  vec3 color = baseColor;
  #if defined(PANORAMA)
    vec3 blurred = vec3(0.0);
    vec2 border = 0.5 / outputSize;
    for (int row = 0; row < BLUR_TAP_COUNT; row++) {
      for (int column = 0; column < BLUR_TAP_COUNT; column++) {
        vec2 dxdy = vec2(blurTaps[column].x, blurTaps[row].x) / outputSize;
        blurred += panoramaDisplay(clamp(uv + dxdy, border, 1.0 - border)) * (blurTaps[column].y * blurTaps[row].y);
      }
    }
    if (hasMenu > 0.5) {
      vec4 tint = texture2D(picture, fract(vec2(uv.x, uv.y - 1.0) * guiSize / 32.0));
      blurred = mix(blurred, toDisplay(tint.rgb), tint.a);
    }
    color = toLinear(blurred);
  #elif defined(DIRT)
    vec2 tiled = vec2(uv.x, uv.y - 1.0) * guiSize / 32.0;
    color = toLinear(toDisplay(textureGrad(picture, fract(tiled), dFdx(tiled), dFdy(tiled)).rgb) * 0.25);
  #elif defined(NETHER)
    color = textureLod(picture, frameOffset + mix(halfTexel, frameSize - halfTexel, clamp(uv, 0.0, 1.0)), 0.0).rgb;
  #elif defined(END)
    color = toLinear(portalDisplay(uv));
  #endif
  gl_FragColor = vec4(color, opacity);
}
`;

export async function createJavaBackground(ctx: SetupContext, background: JavaBackdrop, modern: boolean, guiUnit: number) {
  const { THREE, stage } = ctx;
  const defines: Record<string, number> = {};
  const speed = typeof ctx.params.javaPanoramaSpeed === 'number' ? ctx.params.javaPanoramaSpeed : 1;
  const radius = typeof ctx.params.javaMenuBlur === 'number' ? Math.min(10, Math.max(0, Math.round(ctx.params.javaMenuBlur))) : 5;
  const startTick = typeof ctx.params.javaEndStartTick === 'number' ? ctx.params.javaEndStartTick : 0;
  const isPanorama = background === 'javaPanorama';
  const taps = isPanorama ? panoramaBlurTaps(panoramaBlurKernel(radius)) : [];
  const textures: NonNullable<Texture>[] = [];
  let picture: Texture = null;
  let overlay: Texture = null;
  let frameSize = new THREE.Vector2(1, 1);
  let frameOffset = new THREE.Vector2();
  const initialFrame = frameOffset.clone();
  const halfTexel = new THREE.Vector2();
  let nativeNetherStrip = false;
  let color = '#101010';
  if (background === 'javaPanorama') {
    const faces = await Promise.all(PANORAMA_IDS.map((id) => javaTexture(ctx, id)));
    const side = textureSize(faces[0] ?? null)?.width;
    const good = faces.every((face) => {
      const size = textureSize(face);
      return size && size.width === side && size.height === side;
    });
    if (good) {
      defines.PANORAMA = 1;
      defines.BLUR_TAP_COUNT = taps.length;
      if (!modern) defines.LEGACY_CUBE = 1;
      for (const face of faces) {
        if (!face) continue;
        const copy = face.clone();
        copy.colorSpace = THREE.NoColorSpace;
        copy.magFilter = THREE.LinearFilter;
        copy.minFilter = THREE.LinearFilter;
        copy.needsUpdate = true;
        textures.push(copy);
      }
      [picture, overlay] = await Promise.all([javaTexture(ctx, JAVA_TEXTURES.menu), javaTexture(ctx, JAVA_TEXTURES.panoramaOverlay, 1)]);
      if (!picture) warnJavaAsset(ctx, JAVA_TEXTURES.menu, 'showing the panorama without the menu tint', '全景不加菜单遮罩');
    } else warnJavaAsset(ctx, 'panorama_0…5', 'showing a plain dark background, not a substitute panorama', '改用纯深色背景，不伪造全景', 'panorama-fallback');
  } else if (background === 'dirt') {
    picture = await javaTexture(ctx, JAVA_TEXTURES.dirt);
    if (!picture) {
      picture = await javaTexture(ctx, JAVA_TEXTURES.dirtBlock);
      warnJavaAsset(ctx, JAVA_TEXTURES.dirt, picture ? 'using the resource stack dirt block instead' : 'using a plain dark background', picture ? '改用资源栈的泥土方块贴图' : '改用纯深色背景');
    }
    if (picture) defines.DIRT = 1;
  } else if (background === 'netherPortal') {
    picture = await javaTexture(ctx, JAVA_TEXTURES.nether);
    const size = textureSize(picture);
    if (picture && size) {
      defines.NETHER = 1;
      halfTexel.set(0.5 / size.width, 0.5 / size.height);
      frameSize = picture.repeat;
      frameOffset = picture.offset.clone();
      if (frameSize.x === 1 && frameSize.y === 1 && size.height > size.width) {
        frameSize = new THREE.Vector2(1, size.width / size.height);
        frameOffset.set(0, 1 - frameSize.y);
        nativeNetherStrip = size.width === 16 && size.height === 512;
        if (!nativeNetherStrip) warnJavaAsset(ctx, `${JAVA_TEXTURES.nether}.png.mcmeta`, 'showing only the first frame', '只显示第一帧');
      }
      initialFrame.set(0, 1 - frameSize.y);
    } else warnJavaAsset(ctx, JAVA_TEXTURES.nether, 'using a plain dark background', '改用纯深色背景');
  } else if (background === 'endPortal') {
    const path = modern ? JAVA_TEXTURES.end263 : JAVA_TEXTURES.end1211;
    [picture, overlay] = await Promise.all([javaTexture(ctx, JAVA_TEXTURES.endSky), javaTexture(ctx, path)]);
    if (!overlay) {
      overlay = await javaTexture(ctx, modern ? JAVA_TEXTURES.end1211 : JAVA_TEXTURES.end263);
      if (overlay) warnJavaAsset(ctx, path, 'using the other verified Java version’s End texture path', '使用另一已核对 Java 版本的末地贴图路径');
    }
    if (picture && overlay) defines.END = 1;
    else warnJavaAsset(ctx, !picture ? JAVA_TEXTURES.endSky : path, 'using a plain dark background', '改用纯深色背景');
  } else color = background === 'red' ? (ctx.params.javaDarkSplash === true ? '#000000' : '#EF323D') : '#FFFFFF';

  const uniforms = {
    opacity: { value: 1 }, clockPhase: { value: endClock(0, false, startTick) }, phase: { value: 1 }, dissolve: { value: 0 },
    seed: { value: typeof ctx.params.seed === 'number' ? ctx.params.seed % 65521 : 1 },
    baseColor: { value: new THREE.Color(color) },
    stageSize: { value: new THREE.Vector2(stage.width, stage.height) },
    outputSize: { value: new THREE.Vector2(stage.width * (stage.pixelScale ?? 1), stage.height * (stage.pixelScale ?? 1)) },
    blurTaps: { value: Array.from({ length: 5 }, (_, index) => new THREE.Vector2(...(taps[index] ?? [0, 0]))) },
    portalBasis: { value: defines.END ? END_LAYERS.map(({ basisX, basisY, offsetX, clockWeight }) => new THREE.Vector4(basisX, basisY, offsetX, clockWeight)) : [] },
    portalTints: { value: defines.END ? END_LAYERS.map(({ tint }) => new THREE.Vector3(...tint)) : [] },
    guiSize: { value: new THREE.Vector2(stage.width / guiUnit, stage.height / guiUnit) },
    yaw: { value: new THREE.Vector2(0, 1) }, pitch: { value: new THREE.Vector2(Math.sin(Math.PI / 18), Math.cos(Math.PI / 18)) },
    focal: { value: panProjection(0, false).focal },
    face0: { value: textures[0] }, face1: { value: textures[1] }, face2: { value: textures[2] },
    face3: { value: textures[3] }, face4: { value: textures[4] }, face5: { value: textures[5] },
    picture: { value: picture }, overlay: { value: overlay },
    hasMenu: { value: picture ? 1 : 0 }, hasOverlay: { value: overlay ? 1 : 0 },
    frameSize: { value: frameSize }, frameOffset: { value: frameOffset },
    halfTexel: { value: halfTexel },
  };
  const material = new THREE.ShaderMaterial({ defines, uniforms, vertexShader: VERTEX, fragmentShader: FRAGMENT, transparent: true, depthWrite: false });
  return {
    material,
    update(time: number, motion: boolean, opacity: number, phase: number, dissolve: number) {
      uniforms.opacity.value = opacity;
      uniforms.clockPhase.value = endClock(time, motion, startTick);
      uniforms.phase.value = phase;
      uniforms.dissolve.value = dissolve;
      const view = panProjection(time, motion, speed);
      uniforms.yaw.value.set(view.sin, view.cos);
      if (defines.NETHER) {
        if (picture && motion && frameSize === picture.repeat) frameOffset.copy(picture.offset);
        else {
          frameOffset.copy(initialFrame);
          if (motion && nativeNetherStrip) frameOffset.y -= (Math.floor(Math.max(0, time) * 20) % 32) / 32;
        }
      }
    },
    dispose() {
      material.dispose();
      for (const texture of textures) texture.dispose();
    },
  };
}
