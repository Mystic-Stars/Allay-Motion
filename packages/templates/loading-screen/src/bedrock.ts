import type { ParamValue, SetupContext, TemplateInstance } from '@allay/template-sdk';
import { bedrockBackdrop, imageSize } from './bedrock-background';

type Texture = Awaited<ReturnType<SetupContext['resources']['texture']>>;

const TRAVEL = {
  bedrockTravelNether: 'minecraft:blocks/netherrack', bedrockTravelEnd: 'minecraft:blocks/end_stone', bedrockTravelOverworld: 'minecraft:blocks/dirt',
} as const;
const MODES = ['bedrockStartup', 'bedrockWorld', 'bedrockPacks', ...Object.keys(TRAVEL)] as const;
export const isBedrockLoading = (mode: ParamValue | undefined): mode is string => typeof mode === 'string' && MODES.includes(mode);
const clamp = (value: number) => Math.min(1, Math.max(0, value));
const number = (value: ParamValue | undefined, fallback: number) => typeof value === 'number' ? value : fallback;
const str = (value: ParamValue | undefined) => typeof value === 'string' ? value : '';

export function bedrockLoadingState(time: number, progress: number, mode: string) {
  const p = clamp(progress);
  const frame = Math.floor(Math.max(0, time) * 10) % 18;
  const stage = p < 0.18 ? 0 : p < 0.42 ? 1 : p < 0.92 ? 2 : 3;
  const done = stage === 3 ? 1 : stage === 2 ? 0.22 + clamp((p - 0.48) / 0.4) * 0.74 : 0;
  return { stage, done, frame: Math.min(frame, 18 - frame), looping: mode === 'bedrockPacks' || stage < 2 };
}

export async function setupBedrockLoading(ctx: SetupContext, mode: string): Promise<TemplateInstance> {
  const { THREE, stage, params } = ctx;
  const startup = mode === 'bedrockStartup';
  const packs = mode === 'bedrockPacks';
  const tile = TRAVEL[mode as keyof typeof TRAVEL];
  const modal = !startup;
  const world = modal && !tile && !packs;
  const zh = params.loadingLanguage === 'zh-CN' || (params.loadingLanguage !== 'en' && /^zh/i.test(ctx.locale));
  const warn = (en: string, cn: string) => ctx.warn(zh ? cn : en);
  const root = new THREE.Group();
  ctx.scene.add(root);
  const start = number(params.inDuration, 0.3);
  const hold = number(params.hold, 0.9);
  const duration = start + hold + number(params.outDuration, 0.3);
  const cutTime = start + clamp(number(params.cutAt, 0.5)) * hold;
  const pad = 1 / stage.fps;
  const inStart = Math.min(pad, start / 2);
  const inEnd = Math.max(inStart + 0.001, Math.min(start, cutTime - pad));
  const outEnd = duration - Math.min(pad, (duration - start - hold) / 2);
  const outStart = Math.min(outEnd - 0.001, Math.max(start + hold, cutTime + pad));
  const u = Math.min(4, stage.width / 312, stage.height / 270);
  const fontUnit = number(params.textScale, 5) * u / 4;
  const backdrop = await bedrockBackdrop(ctx, root, zh, str(params.bedrockBackground), tile, startup, u);
  const ui = (name: string) => ctx.resources.optionalTexture(`minecraft:ui/${name}`);
  const boundTitle = str(params.bedrockTitle);
  const loadTitle = async () => {
    const custom = boundTitle && await ctx.resources.optionalTexture(boundTitle);
    if (custom && imageSize(custom)) return custom;
    if (boundTitle) warn('The selected Bedrock title image could not be read.', '无法读取所选基岩标题图片。');
    return ui('title');
  };
  const showBar = !tile && params.showBar !== false;
  const [logo, panel, atlas0, empty, full, nub] = await Promise.all([
    loadTitle(), modal ? ui('dialog_background_hollow_3') : null,
    showBar && !startup ? ui('loading_bar') : null,
    showBar && world ? ui('experiencebarempty') : null,
    showBar && world ? ui('experiencebarfull') : null,
    showBar && world ? ui('experiencenub') : null,
  ]);
  const atlasSize = imageSize(atlas0);
  const atlas = atlasSize && atlasSize.height >= 8 && atlasSize.width === 80 * atlasSize.height ? atlas0 : null;
  if (!logo) warn('Title art missing. Import a regular Bedrock pack or bind a title PNG; no logo is drawn.', '缺少标题素材。请导入普通基岩资源包或绑定标题 PNG；不会补画标志。');
  if (modal && (!panel || (showBar && (!atlas || (!packs && (!empty || !full || !nub)))))) warn(
    'Some Bedrock panel or bar textures are missing. Import a regular Bedrock pack; neutral substitutes are used.',
    '缺少部分基岩面板或加载条贴图。请导入普通基岩资源包；当前使用中性替代。');

  const opacity: ((value: number) => void)[] = [];
  const sprite = (texture: Texture, width: number, height: number, x: number, y: number, order: number) => {
    const s = ctx.sprite.create(texture, { pixelSize: u });
    s.setSize(width, height);
    s.object.position.set(x, y, 0);
    s.object.renderOrder = order;
    root.add(s.object);
    opacity.push(s.setOpacity);
    return s.object;
  };
  const rect = (width: number, height: number, x: number, y: number, order: number, color: string, alpha = 1) => {
    const material = new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
    mesh.renderOrder = order;
    mesh.position.set(x, y, 0);
    root.add(mesh);
    opacity.push((value) => { material.opacity = value * alpha; });
    return mesh;
  };
  const logoSize = imageSize(logo);
  if (logo && logoSize) {
    const width = stage.width * 0.55;
    const height = Math.min(stage.height * 0.19, width * logoSize.height / logoSize.width, startup ? Infinity : stage.height * 0.4 - 53 * u);
    sprite(logo, height * logoSize.width / logoSize.height, height, 0, startup ? 24 * u : stage.height * 0.4 - height / 2, 1);
  }
  if (modal) {
    rect(274 * u, 69 * u, 0, -7.5 * u, 0, '#000000', 0.8);
    if (panel) sprite(panel, 290 * u, 100 * u, 0, 0, 1);
    else {
      rect(290 * u, 100 * u, 0, 0, -1, '#B8B8B8');
      rect(278 * u, 18 * u, 0, 38 * u, 1, '#B8B8B8');
    }
  }
  const label = (text: string, key: string, y: number, size = fontUnit, color = '#FFFFFF', body = false) => {
    const obj = ctx.text.create({ text, font: str(params[key]) || 'minecraft:default', size, color, align: body ? 'left' : 'center', maxWidth: 264 * u, shadow: false });
    const scale = Math.min(1, 264 * u / Math.max(1, obj.width), (body ? 40 : 13) * u / Math.max(1, obj.height));
    obj.object.scale.setScalar(scale);
    obj.object.position.set(body ? -128 * u : 0, body ? y - obj.height * scale / 2 : y, 1);
    obj.object.traverse((child) => { child.renderOrder = 5; });
    root.add(obj.object);
    opacity.push(obj.setOpacity);
    return obj.object;
  };
  const pairs = zh ? [
    ['正在启动世界', '正在加载资源'], ['正在加载资源包', '正在加载资源'], ['正在加载…', '生成地形中'], ['正在加载…', '存活'],
  ] : [
    ['Starting World', 'Loading Resources'], ['Loading resource packs', 'Loading Resources'], ['Loading…', 'Building terrain'], ['Loading…', 'Survive'],
  ];
  const wording = tile ? [zh ? ['正在生成世界', '生成地形中'] : ['Generating World', 'Building terrain']]
    : packs ? [pairs[1]!] : startup ? [zh ? ['正在启动', ''] : ['Starting up', '']] : pairs;
  const title = str(params.title);
  const sub = str(params.subtitle);
  const usePresetSubtitle = sub === 'Building terrain…' || sub === '正在生成地形…' || params.subtitle === undefined;
  const headings = wording.map(([heading, detail]) => {
    const useTitle = title !== 'Loading world' && title !== '正在加载世界' && title ? title : startup && logo ? '' : heading!;
    const useSub = usePresetSubtitle ? detail! : sub;
    return [label(useTitle, 'titleFont', (startup ? -3 : 36) * u, fontUnit, modal ? '#4D4D4D' : '#FFFFFF'),
      label(useSub, 'subtitleFont', (startup ? -16 : 22) * u)];
  });
  const tips = world && usePresetSubtitle ? (zh ? ['带上火把，照亮探索路线。', '在远行前记下家的坐标。'] :
    ['Bring torches to light your route.', 'Note your home coordinates before exploring.']).map((tip) => label(tip, 'subtitleFont', 23 * u, fontUnit, '#FFFFFF', true)) : [];
  const percentX = 7 * fontUnit;
  const percent = startup && showBar ? [0, 1, 2].map(() => Array.from({ length: 10 }, (_, digit) => label(String(digit), 'progressFont', -38 * u))) : [];
  const percentSign = percent.length ? label('%', 'progressFont', -38 * u) : null;
  const meterUnits = startup ? 100 : (290 - 12) * 0.9;
  const meterWidth = meterUnits * u;
  const meterY = (startup ? -25 : -28.5) * u;
  const track = showBar && !packs ? (empty ? sprite(empty, meterWidth, 5 * u, 0, meterY, 2) : rect(meterWidth, 3 * u, 0, meterY, 2, '#181818')) : null;
  const fill = track && !full ? rect(meterWidth, 3 * u, 0, meterY, 3, startup ? '#eeeeee' : '#8bd754') : null;
  const clip = { value: 0 };
  if (track && full) {
    const alpha = { value: 1 };
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(meterWidth, 5 * u), new THREE.ShaderMaterial({
      uniforms: { strip: { value: full }, visibleWidth: clip, alpha, width: { value: meterUnits } }, transparent: true, depthWrite: false,
      vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: `varying vec2 vUv; uniform sampler2D strip; uniform float visibleWidth,alpha,width;
        void main(){
        if(vUv.x>=visibleWidth) discard;
        float x=vUv.x*width;
        float sampleX=x<1.0 ? x : x>width-1.0 ? x-width+13.0 : 1.0+(x-1.0)*11.0/(width-2.0);
        vec4 tex=texture2D(strip,vec2(sampleX/13.0,vUv.y)); gl_FragColor=vec4(tex.rgb,tex.a*alpha);
        #include <colorspace_fragment>
        }`,
    }));
    mesh.position.y = meterY;
    mesh.renderOrder = 3;
    opacity.push((value) => { alpha.value = value; });
    root.add(mesh);
  }
  const dividers = track && nub ? (() => {
    const alpha = { value: 1 };
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry((meterUnits - 10) * u, 5 * u), new THREE.ShaderMaterial({
      uniforms: { strip: { value: nub }, alpha, repeats: { value: (meterUnits - 10) / 11 } }, transparent: true, depthWrite: false,
      vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: `varying vec2 vUv; uniform sampler2D strip; uniform float repeats,alpha;
        void main(){vec2 tile=vec2(vUv.x*repeats,vUv.y); vec4 tex=textureGrad(strip,vec2(fract(tile.x),tile.y),dFdx(tile),dFdy(tile));
        gl_FragColor=vec4(tex.rgb,tex.a*alpha);
        #include <colorspace_fragment>
        }`,
    }));
    mesh.position.y = meterY;
    mesh.renderOrder = 4;
    opacity.push((value) => { alpha.value = value; });
    root.add(mesh);
    return mesh;
  })() : null;
  const atlasUv = atlas ? { value: 0 } : null;
  const loopAlpha = { value: 1 };
  const loop = atlas && atlasUv ? new THREE.Mesh(new THREE.PlaneGeometry(64 * u, 8 * u), new THREE.ShaderMaterial({
    uniforms: { atlas: { value: atlas }, frame: atlasUv, alpha: loopAlpha }, transparent: true, depthWrite: false,
    vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `varying vec2 vUv; uniform sampler2D atlas; uniform float frame,alpha;
      void main(){vec4 tex=texture2D(atlas,vec2((frame+clamp(vUv.x,0.0078125,0.9921875))/10.0,vUv.y)); gl_FragColor=vec4(tex.rgb*0.7,tex.a*alpha);
      #include <colorspace_fragment>
      }`,
  })) : null;
  const idle = showBar && !startup && !loop ? rect(10 * u, 3 * u, 0, meterY, 3, '#bbbbaa') : null;
  if (loop) {
    loop.position.y = meterY;
    loop.renderOrder = 3;
    opacity.push((value) => { loopAlpha.value = value; });
    root.add(loop);
  }

  return {
    duration, cutTime,
    update(t) {
      const entering = t <= cutTime;
      const shown = entering ? clamp((t - inStart) / (inEnd - inStart)) : clamp((outEnd - t) / (outEnd - outStart));
      const transition = entering ? params.inStyle : params.outStyle;
      const slide = transition === 'slideUp';
      root.visible = shown > 0;
      root.position.y = slide ? stage.height * (1 - ctx.ease.cubicOut(shown)) * (entering ? -1 : 1) : 0;
      backdrop(t, slide || transition === 'dissolve' ? 1 : shown, transition === 'dissolve' ? 1 - shown : 0);
      for (const setOpacity of opacity) setOpacity(slide ? 1 : shown);
      const p = clamp((t - start) / hold);
      const state = bedrockLoadingState(t, p, mode);
      const active = wording.length === 1 ? 0 : state.stage;
      const tipIndex = state.stage === 2 && p >= 0.53 && tips.length ? (p < 0.72 ? 0 : 1) : -1;
      headings.forEach(([heading, detail], index) => {
        heading!.visible = index === active;
        detail!.visible = index === active && tipIndex < 0;
      });
      tips.forEach((node, index) => { node.visible = index === tipIndex; });
      if (percentSign) {
        const digits = String(Math.floor(p * 100));
        percentSign.position.x = digits.length * percentX / 2;
        percent.forEach((nodes, slot) => nodes.forEach((node, digit) => {
          node.visible = digits[slot] === String(digit);
          node.position.x = (slot - digits.length / 2) * percentX;
        }));
      }
      const determinate = startup || !state.looping;
      if (track) track.visible = determinate;
      if (dividers) dividers.visible = determinate;
      if (loop && atlasUv) { loop.visible = !determinate; atlasUv.value = state.frame; }
      if (idle) { idle.visible = !determinate; idle.position.x = (state.frame - 4.5) * 6 * u; }
      clip.value = determinate ? state.done : 0;
      if (fill) {
        const width = meterWidth * (startup ? p : state.done);
        fill.visible = determinate && width > 0;
        fill.scale.x = width / meterWidth;
        fill.position.x = (width - meterWidth) / 2;
      }
    },
  };
}
