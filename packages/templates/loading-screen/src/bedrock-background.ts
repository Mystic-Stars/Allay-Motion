import type { SetupContext } from '@allay/template-sdk';

type Texture = Awaited<ReturnType<SetupContext['resources']['texture']>>;
export function imageSize(texture: Texture | null | undefined) {
  const image: unknown = texture?.image;
  if (image && typeof image === 'object' && 'width' in image && 'height' in image &&
    typeof image.width === 'number' && image.width > 0 && typeof image.height === 'number' && image.height > 0) {
    return { width: image.width, height: image.height };
  }
  return null;
}

const PANORAMA = `
uniform sampler2D front, rightFace, backFace, leftFace, ceiling, floorFace;
uniform float aspect, yaw, pitch;
vec3 picture(vec2 uv) {
  vec3 d = normalize(vec3((uv - 0.5) * vec2(aspect, 1.0), 0.85));
  d.yz = mat2(cos(pitch), sin(pitch), -sin(pitch), cos(pitch)) * d.yz;
  d.xz = mat2(cos(yaw), sin(yaw), -sin(yaw), cos(yaw)) * d.xz;
  vec3 a = abs(d);
  if (a.z >= max(a.x, a.y)) {
    if (d.z > 0.0) return texture2D(front, 0.5 + d.xy / (2.0 * a.z)).rgb;
    return texture2D(backFace, 0.5 + vec2(-d.x, d.y) / (2.0 * a.z)).rgb;
  }
  if (a.x >= a.y) {
    if (d.x > 0.0) return texture2D(rightFace, 0.5 + vec2(-d.z, d.y) / (2.0 * a.x)).rgb;
    return texture2D(leftFace, 0.5 + vec2(d.z, d.y) / (2.0 * a.x)).rgb;
  }
  if (d.y > 0.0) return texture2D(ceiling, 0.5 + vec2(d.x, -d.z) / (2.0 * a.y)).rgb;
  return texture2D(floorFace, 0.5 + d.xz / (2.0 * a.y)).rgb;
}`;

export async function bedrockBackdrop(
  ctx: SetupContext, root: InstanceType<SetupContext['THREE']['Group']>, zh: boolean, override: string, tile: string | undefined, startup: boolean, unit: number,
): Promise<(time: number, alpha: number, dissolve: number) => void> {
  const { THREE, stage } = ctx;
  const custom = override ? await ctx.resources.optionalTexture(override) : null;
  if (override && !custom) ctx.warn(zh ? '无法读取所选基岩背景。' : 'The selected Bedrock background could not be read.');
  const lookup = ctx.resources.optionalTexture;
  const faces = !custom && !tile && !startup ? await Promise.all(Array.from({ length: 6 }, (_, index) => lookup(`minecraft:ui/panorama_${index}`))) : [];
  const firstFace = imageSize(faces[0]);
  const cube = faces.length === 6 && faces.every((face) => {
    const size = imageSize(face);
    return size && size.width > 1 && size.width === size.height && size.width === firstFace?.width;
  });
  const background = custom ?? (tile ? await lookup(tile) : startup || cube ? null : await lookup('minecraft:ui/bg32'));
  if (!custom && (tile ? !background : !startup && !cube)) ctx.warn(zh
    ? '缺少基岩背景；可导入普通基岩资源包或绑定背景图片。' : 'Bedrock background assets are missing. Import a regular Bedrock pack or bind a background image.');
  const color = new THREE.Color(startup ? '#363636' : tile?.endsWith('netherrack') ? '#452728' : tile?.endsWith('end_stone') ? '#655e44' : '#33312e');
  const nether = tile?.endsWith('netherrack') ?? false;
  const end = tile?.endsWith('end_stone') ?? false;
  const uniforms = {
    front: { value: faces[0] }, rightFace: { value: faces[1] }, backFace: { value: faces[2] }, leftFace: { value: faces[3] },
    ceiling: { value: faces[4] }, floorFace: { value: faces[5] }, image: { value: background },
    yaw: { value: 0 }, pitch: { value: 0.13 }, aspect: { value: stage.aspect }, solid: { value: color },
    opacity: { value: 1 }, dissolve: { value: 0 }, seed: { value: Number(ctx.params.seed ?? 1) % 10007 },
    cover: { value: new THREE.Vector2(1, 1) }, count: { value: new THREE.Vector2(stage.width / (32 * unit), stage.height / (32 * unit)) },
    gradientTop: { value: new THREE.Vector4(nether ? 0.3 : 0, nether ? 0.3 : 0, nether ? 0.3 : 0, nether || end ? 0.2 : 0.5) },
    gradientBottom: { value: new THREE.Vector4(nether ? 0.5 : 0, nether ? 0.188 : 0, nether ? 0.188 : 0, nether || end ? 0.4 : 0.7) },
    tileTint: { value: nether ? 0.5 : 1 },
  };
  const customSize = imageSize(custom);
  if (customSize) {
    const ratio = customSize.width / customSize.height / stage.aspect;
    uniforms.cover.value.set(Math.min(1, 1 / ratio), Math.min(1, ratio));
  }
  const material = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false,
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      varying vec2 vUv;
      uniform sampler2D image;
      uniform vec3 solid;
      uniform vec2 cover, count;
      uniform vec4 gradientTop, gradientBottom;
      uniform float opacity, dissolve, seed, tileTint;
      ${cube ? PANORAMA : ''}
      void main(){
        vec2 cell = floor(vUv * count * 2.0);
        if(dissolve > 0.0 && fract(sin(dot(cell, vec2(12.9898,78.233)) + seed) * 43758.5453) < dissolve) discard;
        vec3 color = solid;
        ${cube ? 'color = picture(vUv);' : custom ? 'vec4 sampleColor = texture2D(image, 0.5 + (vUv - 0.5) * cover); color = mix(solid, sampleColor.rgb, sampleColor.a);'
          : background ? 'vec2 uv = vUv * count; vec4 sampleColor = textureGrad(image, fract(uv), dFdx(uv), dFdy(uv)); vec4 shade = mix(gradientBottom, gradientTop, vUv.y); color = mix(mix(solid, sampleColor.rgb * tileTint, sampleColor.a), shade.rgb, shade.a);' : ''}
        gl_FragColor = vec4(color, opacity);
        #include <colorspace_fragment>
      }`,
  });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(stage.width, stage.height), material);
  plane.renderOrder = -10;
  root.add(plane);
  return (time, alpha, dissolve) => {
    uniforms.yaw.value = ctx.params.animateBackground === false ? 0.13 : 0.13 + time * 0.22;
    uniforms.opacity.value = alpha;
    uniforms.dissolve.value = dissolve;
  };
}
