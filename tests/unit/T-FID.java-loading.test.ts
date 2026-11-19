import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { SetupContext } from '../../packages/template-sdk/src/runtime';
import { parseUnihex } from '../../packages/assets/src/index';
import { setupText } from '../../packages/engine/src/text';
import type { FontPayload } from '../../packages/template-sdk/src/index';
import manifest from '../../packages/templates/loading-screen/manifest.json';
import { JAVA_TEXTURES, PANORAMA_IDS, panProjection } from '../../packages/templates/loading-screen/src/java-background';
import { endClock, END_LAYERS, panoramaBlurKernel, panoramaBlurTaps, tickSmoothedProgress } from '../../packages/templates/loading-screen/src/java-optics';
import { loadingProfile, setupVersionedLoading } from '../../packages/templates/loading-screen/src/versioned';
import { CompositionLoadResultSchema, isParamVisible, LoadResultSchema, sanitizeParams, TemplateManifestSchema } from '../../packages/template-sdk/src/index';

const requireFromEngine = createRequire(new URL('../../packages/engine/package.json', import.meta.url));
const threeModule = pathToFileURL(requireFromEngine.resolve('three')).href.replace(/three\.cjs$/, 'three.module.js');
const THREE = await import(/* @vite-ignore */ threeModule) as SetupContext['THREE'];
type Texture = Awaited<ReturnType<SetupContext['resources']['texture']>>;
type Object3D = InstanceType<typeof THREE.Object3D>;
type Mesh = InstanceType<typeof THREE.Mesh>;

function texture(width = 16, height = width) {
  return new THREE.DataTexture(new Uint8Array(width * height * 4).fill(255), width, height);
}

async function mount(style: string, textures: Record<string, Texture> = {}, params: SetupContext['params'] = {}, locale = 'en', width = 1920, height = 1080, painter?: SetupContext['text']) {
  const scene = new THREE.Scene();
  const warn = vi.fn();
  const optionalTexture = vi.fn(async (id: string) => textures[id] ?? null);
  const labels: { text: string; object: Object3D; size: number; color?: string; font?: string; origin?: 'guiBaseline' }[] = [];
  const ctx = {
    THREE, locale, scene, params, warn, stage: { width, height, fps: 60 }, resources: { optionalTexture },
    ease: { cubicIn: (phase: number) => phase ** 3, cubicOut: (phase: number) => 1 - (1 - phase) ** 3 },
    text: {
      measureGui: painter?.measureGui ?? ((text: string) => ({ advance: text.length * 6, width: text.length * 6, left: 0, above: 7, below: 1 })),
      create: (options: Parameters<SetupContext['text']['create']>[0]) => {
        const result = painter?.create(options) ?? { object: new THREE.Group(), width: options.size * options.text.length * 6, height: options.size * 8, setOpacity: vi.fn() };
        const { text, size, color, font, origin } = options;
        labels.push({ text, object: result.object, size, color, font, origin });
        return result;
      },
    },
  } as unknown as SetupContext;
  const profile = loadingProfile(style);
  if (!profile) throw new Error(`Unknown loading style ${style}`);
  const instance = await setupVersionedLoading(ctx, profile);
  const root = scene.children[0]!;
  const meshes = root.children.filter((child): child is Mesh => child instanceof THREE.Mesh);
  const background = meshes.find((mesh) => mesh.renderOrder === -2)?.material;
  if (!(background instanceof THREE.ShaderMaterial)) throw new Error('Missing background');
  return { instance, scene, root, meshes, labels, warn, background, optionalTexture };
}

describe('T-FID Java 加载界面', () => {
  it('全景提示协议仅接受已知标识，合成按片段携带', () => {
    const base = { duration: 1, cutTime: null, audioCues: [], warnings: [] };
    expect(LoadResultSchema.safeParse({ ...base, resourceNotices: ['panorama-fallback'] }).success).toBe(true);
    expect(LoadResultSchema.safeParse({ ...base, resourceNotices: ['unknown'] }).success).toBe(false);
    const clip = { id: 'clip-a', notices: ['panorama-fallback'] };
    expect(CompositionLoadResultSchema.safeParse({ ...base, totalFrames: 30, clipResourceNotices: [clip] }).success).toBe(true);
    expect(CompositionLoadResultSchema.safeParse({ ...base, totalFrames: 30, clipResourceNotices: [{ ...clip, path: 'unexpected' }] }).success).toBe(false);
  });

  it('默认保留 generic；旧 ID 和 26.3 各自保留', () => {
    expect(manifest.params.find(({ key }) => key === 'loadingStyle')?.default).toBe('generic');
    expect(loadingProfile('generic')).toBeUndefined();
    expect(loadingProfile('javaWorldDirt114')).toMatchObject({ grid: 45, background: 'dirt' });
    expect(loadingProfile('javaWorldDirt')).toMatchObject({ grid: 43, background: 'dirt' });
    expect(loadingProfile('javaWorldBar')).toMatchObject({ grid: 35, layout: 'chunkBar' });
    expect(loadingProfile('javaWorld263')).toMatchObject({ grid: 35, layout: 'chunkBar', modern: true });
  });

  it('红底字标使用上下半图拼成左右两边，带原版进度条但没有标题', async () => {
    const logo = texture(512);
    for (const style of ['javaStartupRed', 'javaReloadRed']) {
      const { instance, meshes, labels, background, warn } = await mount(style, { [JAVA_TEXTURES.logoRed]: logo }, { title: 'Loading world' });
      instance.update(instance.cutTime!);
      expect(labels).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
      expect(background.uniforms.baseColor?.value.getHexString()).toBe('ef323d');
      const halves = meshes.filter((mesh) => mesh.renderOrder === 2);
      expect(halves.map((mesh) => [mesh.position.x, mesh.position.y, mesh.scale.x, mesh.scale.y])).toEqual([[-270, -2, 540, 268], [270, -2, 540, 268]]);
      expect(halves[0]?.geometry.getAttribute('uv').getY(2)).toBe(0.5);
      expect(halves[1]?.geometry.getAttribute('uv').getY(2)).toBe(0);
      expect(halves[0]?.geometry.getAttribute('uv').getX(0)).toBeCloseTo(-0.0005208333, 8);
      expect(halves[1]?.geometry.getAttribute('uv').getX(0)).toBeCloseTo(0.0005208333, 8);
      expect(meshes.some((mesh) => mesh.scale.x === 1072 && mesh.scale.y === 4 && mesh.position.y === -338)).toBe(true);
    }
  });

  it('全景查六面，默认投影 85° 和每秒 2°；1×1 JAR 占位不算全景', async () => {
    const maps = Object.fromEntries(PANORAMA_IDS.map((id) => [id, texture(16)]));
    maps[JAVA_TEXTURES.menu] = texture();
    const { optionalTexture, background, instance, warn } = await mount('javaWorldPanorama', maps);
    expect(optionalTexture.mock.calls.slice(0, 6).flat()).toEqual(PANORAMA_IDS);
    expect(background.defines.PANORAMA).toBe(1);
    expect(background.uniforms.face2?.value.image).toBe(maps[PANORAMA_IDS[2]!]!.image);
    expect(warn).not.toHaveBeenCalled();
    expect(panProjection(5, true)).toMatchObject({ sin: expect.closeTo(0.173648, 5), cos: expect.closeTo(0.984808, 5), focal: expect.closeTo(0.916331, 5) });
    instance.update(0.75);
    expect(background.uniforms.yaw?.value.x).toBeCloseTo(0.02617695, 7);

    const missing = await mount('javaWorldPanorama', { ...maps, [PANORAMA_IDS[3]!]: texture(1) }, {}, 'zh-CN');
    expect(missing.background.defines.PANORAMA).toBeUndefined();
    expect(missing.warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('不伪造全景'), 'panorama-fallback');
    const mismatched = await mount('javaWorld263', { ...maps, [PANORAMA_IDS[4]!]: texture(16, 32) });
    expect(mismatched.background.defines.PANORAMA).toBeUndefined();
    expect(mismatched.warn).toHaveBeenCalledExactlyOnceWith(expect.any(String), 'panorama-fallback');
  });

  it('白底旧档用独立字标；冷启动已经铺底，重载在同一时刻仍在淡入', async () => {
    const oldLogo = texture(512);
    const startup = await mount('javaStartupWhite', { [JAVA_TEXTURES.logoWhite]: oldLogo });
    const reload = await mount('javaReloadWhite', { [JAVA_TEXTURES.logoWhite]: oldLogo });
    const checkedTime = 0.175;
    for (const mounted of [startup, reload]) {
      const logo = mounted.meshes.filter(({ renderOrder }) => renderOrder === 2);
      expect(logo).toHaveLength(1);
      expect(logo[0]?.scale.toArray()).toEqual([1024, 1024, 1]);
      expect(mounted.optionalTexture.mock.calls.flat()).toEqual(['minecraft:gui/title/mojang']);
      expect(mounted.labels).toEqual([]);
      mounted.instance.update(checkedTime);
    }
    expect(startup.background.uniforms.opacity?.value).toBe(1);
    expect(reload.background.uniforms.opacity?.value).toBeCloseTo(0.625, 3);
  });

  it('1.21.1 画 58×58 GUI 像素区块及整数百分比；26.3 画 70×70、状态文字与 200×2 条', async () => {
    const legacy = await mount('javaWorldPanorama', {}, { inDuration: 0.25, hold: 1, outDuration: 0.25 });
    legacy.instance.update(0.625);
    expect(legacy.labels.filter(({ object }) => object.visible).map(({ text }) => text)).toEqual(['26%']);
    expect(legacy.meshes.find(({ renderOrder }) => renderOrder === 1)?.scale.x).toBe(232);
    expect(legacy.labels.find(({ text }) => text === '26%')).toMatchObject({ origin: 'guiBaseline', object: { position: { y: 132 } } });
    expect(legacy.meshes.some(({ scale }) => scale.x === 800)).toBe(false);

    const latest = await mount('javaWorld263', {}, { inDuration: 0.25, hold: 1, outDuration: 0.25 }, 'zh-CN');
    latest.instance.update(0.625);
    expect(latest.labels.map(({ text }) => text)).toEqual(['加载地形中…']);
    expect(latest.labels[0]).toMatchObject({ origin: 'guiBaseline', object: { position: { y: 216 } } });
    expect(latest.meshes.find(({ renderOrder }) => renderOrder === 1)?.scale.x).toBe(280);
    expect(latest.meshes.some(({ scale, position }) => scale.x === 800 && scale.y === 8 && position.y === 192)).toBe(true);
    const fill = latest.meshes.find(({ renderOrder }) => renderOrder === 4)!;
    expect(fill.scale.x).toBe(104);
    expect(fill.position.x - fill.scale.x / 2).toBe(-400);
  });

  it('26.3 第 18 / 45 帧：合成 Unihex 保留整张双密度掩码，阴影和白字在黑条之上', async () => {
    const phrase = '加载地形中…';
    const tables = parseUnihex(Array.from(phrase, (char) => `${char.codePointAt(0)!.toString(16)}:${'8001'.repeat(16)}`).join('\n'))!;
    const font: FontPayload = { kind: 'font', skipped: [], providers: [{ type: 'unihex', tables }] };
    const owned: Parameters<typeof setupText>[3] = [];
    const painter = await setupText([], async () => font, vi.fn(), owned, () => true);
    const oldLabel = painter.create({ text: phrase, size: 4, align: 'center', shadow: true });
    const oldGuiHeight = oldLabel.height / 4;
    expect(oldGuiHeight).toBe(16);
    expect(74 + oldGuiHeight).toBeGreaterThan(86);
    oldLabel.object.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.geometry.dispose();
      object.material.dispose();
    });
    const params = { inDuration: 0.3, hold: 0.9, outDuration: 0.3 };
    const maps = Object.fromEntries(PANORAMA_IDS.map((id) => [id, texture()]));
    maps[JAVA_TEXTURES.menu] = texture();
    for (const resources of [{}, maps]) {
      const mounted = await mount('javaWorld263', resources, params, 'zh-CN', 1920, 1080, painter);
      try {
        const { object, size } = mounted.labels[0]!;
        const [shadow, ink] = object.children;
        const blackBar = mounted.meshes.find(({ renderOrder }) => renderOrder === 3)!;
        const guiY = (edge: number) => (540 - edge) / 4;
        const yBounds = (node: Object3D) => {
          const bounds = new THREE.Box3().setFromObject(node);
          return [guiY(bounds.max.y), guiY(bounds.min.y)];
        };
        const atlas = owned.at(-1)?.image as { width: number; height: number; data: Uint8Array };
        expect([atlas.width, atlas.height, atlas.data[3], atlas.data[(15 * atlas.width) * 4 + 3]]).toEqual([108, 16, 255, 255]);
        for (const time of [18 / 60, 45 / 60, 18 / 60]) {
          mounted.instance.update(time);
          mounted.scene.updateMatrixWorld(true);
          expect(size).toBe(4);
          expect([object.position.x, guiY(object.position.y)]).toEqual([-108, 81]);
          expect(yBounds(ink!)).toEqual([74, 82]);
          expect(yBounds(shadow!)).toEqual([75, 83]);
          expect(yBounds(blackBar)).toEqual([86, 88]);
          expect((ink as Mesh).renderOrder).toBeLessThan(blackBar.renderOrder);
        }
        mounted.instance.update(mounted.instance.duration);
        expect(mounted.root.visible).toBe(false);
      } finally { mounted.instance.dispose?.(); }
    }
    owned.forEach((map) => map.dispose());
  });

  it('超大中英混排和缺失字体 ID 回退不越过屏幕、黑条、区块或另一行', async () => {
    const glyph = parseUnihex(Array.from('中A钻生成…0123456789%', (char) => `${char.codePointAt(0)!.toString(16).padStart(4, '0')}:${'8001'.repeat(16)}`).join('\n'))!;
    const vanilla: FontPayload = { kind: 'font', skipped: [], providers: [{ type: 'unihex', tables: glyph }] };
    const owned: Parameters<typeof setupText>[3] = [];
    const warn = vi.fn();
    const painter = await setupText(['test:absent'], async (id) => id === 'minecraft:default' ? vanilla : null, warn, owned, () => true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('font test:absent is unavailable; using minecraft:default'));
    const params = { title: '中A钻'.repeat(13), subtitle: '生成中A…'.repeat(11), subtitleFont: 'test:absent', textScale: 12 };
    const guiY = (edge: number) => (540 - edge) / 4;
    for (const style of ['javaWorld263', 'javaWorldPanorama', 'javaTravelDirt']) {
      const mounted = await mount(style, {}, params, 'zh-CN', 1920, 1080, painter);
      try {
        mounted.instance.update(0.75);
        const [heading, caption] = [params.title, params.subtitle].map((text) => mounted.labels.find((label) => label.text === text)!);
        for (const { object, origin, size } of [heading!, caption!]) {
          const box = new THREE.Box3().setFromObject(object);
          expect(origin).toBe('guiBaseline');
          expect(size).toBeGreaterThan(0);
          expect(box.min.x).toBeGreaterThanOrEqual(-952.001);
          expect(box.max.x).toBeLessThanOrEqual(952.001);
        }
        const headingBottom = guiY(new THREE.Box3().setFromObject(heading!.object).min.y);
        const captionTop = guiY(new THREE.Box3().setFromObject(caption!.object).max.y);
        if (style === 'javaWorld263') {
          expect(headingBottom).toBeLessThanOrEqual(85);
          expect(captionTop).toBeGreaterThanOrEqual(171);
        } else if (style === 'javaWorldPanorama') {
          const percent = mounted.labels.find(({ text, object }) => text.endsWith('%') && object.visible)!;
          const percentBounds = new THREE.Box3().setFromObject(percent.object);
          expect(headingBottom).toBeLessThan(guiY(percentBounds.max.y));
          expect(guiY(percentBounds.min.y)).toBeLessThanOrEqual(105);
          expect(captionTop).toBeGreaterThanOrEqual(165);
        } else expect(headingBottom).toBeLessThan(captionTop);
      } finally { mounted.instance.dispose?.(); }
    }
    owned.forEach((map) => map.dispose());
  });

  it('奇数笔宽按原版整数除法居中，空白副标题不创建几何', async () => {
    const tables = parseUnihex(`4E2D:${'8001'.repeat(16)}`)!;
    const font: FontPayload = { kind: 'font', skipped: [], providers: [{ type: 'unihex', tables }] };
    const owned: Parameters<typeof setupText>[3] = [];
    const painter = await setupText([], async () => font, vi.fn(), owned, () => true);
    const mounted = await mount('javaTravelDirt', {}, { title: '中', subtitle: '   ' }, 'zh-CN', 1920, 1080, painter);
    try {
      expect(painter.measureGui('中').advance).toBe(9);
      expect(mounted.labels.map(({ text, object }) => [text, object.position.x, object.position.y])).toEqual([['中', -16, 172]]);
      expect(owned).toHaveLength(1);
    } finally {
      mounted.instance.dispose?.();
      owned.forEach((map) => map.dispose());
    }
  });

  it('六道菜单滤波的离散核、屏幕像素范围和转速输入', async () => {
    const kernel = panoramaBlurKernel(5);
    expect(kernel).toHaveLength(31);
    expect(kernel[0]).toBeCloseTo(1 / 1331, 12);
    expect(kernel[15]).toBeCloseTo(91 / 1331, 12);
    expect(kernel.reduce((total, weight) => total + weight, 0)).toBeCloseTo(1, 12);
    expect(kernel.reduce((total, weight, index) => total + weight * (index - 15) ** 2, 0)).toBeCloseTo(30, 10);
    const taps = panoramaBlurTaps(kernel);
    expect(taps[0]?.[0]).toBeCloseTo(-(15 * 1 + 14 * 3 + 13 * 6 + 12 * 10 + 11 * 15 + 10 * 21) / 56, 10);
    expect(taps[0]?.[1]).toBeCloseTo(56 / 1331, 12);
    expect(panoramaBlurTaps(panoramaBlurKernel(0))).toEqual([[0, 1]]);

    const maps = Object.fromEntries(PANORAMA_IDS.map((id) => [id, texture()]));
    maps[JAVA_TEXTURES.menu] = texture();
    const legacy = await mount('javaWorldPanorama', maps);
    const modern = await mount('javaWorld263', maps, { javaMenuBlur: 0, javaPanoramaSpeed: 2 });
    expect(legacy.background.defines).toMatchObject({ BLUR_TAP_COUNT: 5, LEGACY_CUBE: 1 });
    expect(modern.background.defines.BLUR_TAP_COUNT).toBe(1);
    expect(modern.background.defines.LEGACY_CUBE).toBeUndefined();
    modern.instance.update(1);
    expect(modern.background.uniforms.yaw?.value.x).toBeCloseTo(0.069756474, 8);
  });

  it('末地两版使用相同的 15 层屏幕投影；相位可设、可冻结、可按刻回绕', async () => {
    const assets = { [JAVA_TEXTURES.endSky]: texture(), [JAVA_TEXTURES.end1211]: texture(), [JAVA_TEXTURES.end263]: texture() };
    const legacy = await mount('javaTravelEnd', assets, { javaEndStartTick: 3000 });
    const modern = await mount('javaTravelEnd263', assets, { javaEndStartTick: 3000, animateBackground: false });
    for (const mounted of [legacy, modern]) {
      const layers = mounted.background.uniforms.portalBasis?.value as InstanceType<typeof THREE.Vector4>[];
      expect(layers).toHaveLength(15);
      const project = ({ x, y, z, w }: InstanceType<typeof THREE.Vector4>) => [0.25 * x - 0.75 * y + z, 0.25 * y + 0.75 * x + 0.25 + 0.125 * w];
      expect(project(layers[0]!)).toEqual([expect.closeTo(8.658234203, 8), expect.closeTo(3.858666631, 8)]);
      expect(project(layers[7]!)).toEqual([expect.closeTo(3.208169986, 8), expect.closeTo(0.378317289, 8)]);
      expect(project(layers[14]!)).toEqual([expect.closeTo(1.004166667, 8), expect.closeTo(1.9375, 8)]);
      expect(mounted.background.uniforms.portalTints?.value[14].toArray()).toEqual([0.204675, 0.390010, 0.302066]);
      mounted.instance.update(0.5);
    }
    expect(END_LAYERS).toHaveLength(15);
    expect(legacy.background.uniforms.clockPhase?.value).toBeCloseTo(0.125416667, 8);
    expect(modern.background.uniforms.clockPhase?.value).toBe(0.125);
    expect(endClock(0.05, true, 23999)).toBe(0);
  });

  it('服务器进度的显示值按 20 Hz 平滑，不依赖更新顺序', () => {
    const targetAt = () => 1;
    expect(tickSmoothedProgress(0.049, 0.2, targetAt)).toBe(0);
    expect(tickSmoothedProgress(0.05, 0.2, targetAt)).toBeCloseTo(0.2, 12);
    expect(tickSmoothedProgress(0.15, 0.2, targetAt)).toBeCloseTo(0.488, 12);
    expect(tickSmoothedProgress(1, 0.2, targetAt)).toBeCloseTo(0.988470785, 8);
    expect(tickSmoothedProgress(0.1, 0.2, targetAt)).toBeCloseTo(0.36, 12);
  });

  it('显式标题、副标题、字号、颜色、字体和条色不被预设吞掉', async () => {
    const { instance, labels, meshes } = await mount('javaWorld263', {}, {
      title: 'Next scene', subtitle: 'Preparing assets', titleFont: 'saved:title', subtitleFont: 'saved:subtitle',
      textColor: '#80CED1', textScale: 10, javaBarColor: '#55FF5580',
    });
    instance.update(instance.cutTime!);
    expect(labels).toEqual([
      expect.objectContaining({ text: 'Next scene', font: 'saved:title', color: '#80CED1', size: 8 }),
      expect.objectContaining({ text: 'Preparing assets', font: 'saved:subtitle', color: '#80CED1', size: 8 }),
    ]);
    expect(meshes.find(({ renderOrder }) => renderOrder === 4)?.material).toMatchObject({ opacity: 128 / 255 });
    expect(meshes.find(({ renderOrder }) => renderOrder === 4)?.material).toBeInstanceOf(THREE.MeshBasicMaterial);
  });

  it('清单的每个加载样式只提供其接线所支持的背景和进度选项', () => {
    const definitions = TemplateManifestSchema.parse(manifest).params!;
    const styles = definitions.find(({ key }) => key === 'loadingStyle');
    if (styles?.type !== 'enum') throw new Error('Missing loading style selector');
    const generic = ['block', 'dim', 'tileSize', 'barColor'];
    const panorama = ['javaWorldPanorama', 'javaWorldBar', 'javaWorld263', 'javaTravelOverworld', 'javaTravelOverworld263'];
    const end = ['javaTravelEnd', 'javaTravelEnd263'];
    const motion = [...panorama, ...end, 'javaTravelNether', 'javaTravelNether263', 'bedrockPacks', 'bedrockWorld'];
    const percent = ['javaWorldDirt114', 'javaWorldDirt', 'javaWorldPanorama', 'bedrockStartup'];
    const javaBars = ['javaStartupWhite', 'javaStartupRed', 'javaReloadWhite', 'javaReloadRed', 'javaWorldBar', 'javaWorld263'];
    for (const { value } of styles.options) {
      const values = sanitizeParams(definitions, { loadingStyle: value });
      const visible = (key: string, overrides: SetupContext['params'] = {}) => {
        const def = definitions.find((definition) => definition.key === key);
        if (!def) throw new Error(`Missing ${key}`);
        return isParamVisible(def, { ...values, ...overrides });
      };
      for (const key of generic) expect(visible(key), `${value}/${key}`).toBe(value === 'generic');
      expect(visible('javaPanoramaSpeed'), value).toBe(panorama.includes(value));
      expect(visible('javaMenuBlur'), value).toBe(panorama.includes(value));
      expect(visible('javaEndStartTick'), value).toBe(end.includes(value));
      expect(visible('animateBackground'), value).toBe(motion.includes(value));
      expect(visible('javaDarkSplash'), value).toBe(['javaStartupRed', 'javaReloadRed'].includes(value));
      expect(visible('javaFillMode'), value).toBe(javaBars.includes(value));
      expect(visible('javaFillColor'), value).toBe(false);
      expect(visible('javaFillColor', { javaFillMode: 'custom' }), value).toBe(javaBars.includes(value));
      expect(visible('progressFont'), value).toBe(percent.includes(value));
      for (const key of ['barColor', 'javaFillMode', 'javaFillColor', 'progressFont']) expect(visible(key, { showBar: false, javaFillMode: 'custom' }), `${value}/${key}`).toBe(false);
      expect(visible('animateBackground', { bedrockBackground: 'file:background.png' }), value).toBe(motion.includes(value) && !value.startsWith('bedrock'));
      expect(visible('javaPanoramaSpeed', { animateBackground: false }), value).toBe(false);
      expect(visible('seed'), value).toBe(false);
      expect(visible('seed', { outStyle: 'dissolve' }), value).toBe(true);
      expect(visible('showBar'), value).toBe(value === 'generic' || javaBars.includes(value) || percent.includes(value) || ['bedrockPacks', 'bedrockWorld'].includes(value));
      expect(visible('textColor'), value).toBe(!value.startsWith('bedrock') && !value.startsWith('javaStartup') && !value.startsWith('javaReload'));
      if (value.startsWith('java')) {
        expect(visible('titleFont', { javaTitleMode: 'custom', javaTitle: 'Custom heading' }), value).toBe(true);
        expect(visible('subtitleFont', { javaSubtitleMode: 'custom', javaSubtitle: 'Custom caption' }), value).toBe(true);
        expect(visible('textScale', { javaSubtitleMode: 'custom', javaSubtitle: 'Custom caption' }), value).toBe(true);
        expect(visible('loadingLanguage', { javaTitleMode: 'custom', javaTitle: 'Custom heading' }), value).toBe(false);
      }
      for (const key of ['bedrockBackground', 'bedrockTitle']) expect(visible(key), `${value}/${key}`).toBe(value.startsWith('bedrock'));
    }
  });

  it('现代红底可切黑，关掉进度不会残留条，也不会丢弃显式文字', async () => {
    const mounted = await mount('javaReloadRed', { [JAVA_TEXTURES.logoRed]: texture(512) }, {
      javaDarkSplash: true, showBar: false, title: 'Take two', subtitle: '',
    });
    mounted.instance.update(mounted.instance.cutTime!);
    expect(mounted.background.uniforms.baseColor?.value.getHexString()).toBe('000000');
    expect(mounted.meshes.map(({ renderOrder }) => renderOrder)).toEqual([-2, 2, 2]);
    expect(mounted.labels.map(({ text }) => text)).toEqual(['Take two']);
  });

  it('维度路径用贴图，使用资源帧 UV；冻结不改共享贴图', async () => {
    const portal = texture(16, 512);
    portal.repeat.set(1, 1 / 32);
    portal.offset.set(0, 25 / 32);
    const moving = await mount('javaTravelNether', { [JAVA_TEXTURES.nether]: portal });
    const frozen = await mount('javaTravelNether263', { [JAVA_TEXTURES.nether]: portal }, { animateBackground: false });
    portal.offset.y = 22 / 32;
    for (const sample of [moving, frozen]) {
      sample.instance.update(0.45);
      expect(sample.labels.map(({ text }) => text)).toEqual(['Loading terrain...']);
      expect(sample.labels[0]).toMatchObject({ origin: 'guiBaseline', object: { position: { y: 172 } } });
      expect(sample.background.defines.NETHER).toBe(1);
      expect(sample.meshes).toHaveLength(1);
    }
    expect(moving.background.uniforms.frameOffset?.value.y).toBe(22 / 32);
    expect(frozen.background.uniforms.frameOffset?.value.y).toBe(31 / 32);
    expect(portal.offset.y).toBe(22 / 32);
    const nativeStrip = await mount('javaTravelNether263', { [JAVA_TEXTURES.nether]: texture(16, 512) });
    nativeStrip.instance.update(0.45);
    expect(nativeStrip.background.uniforms.frameOffset?.value.y).toBe(22 / 32);
    nativeStrip.instance.update(0);
    expect(nativeStrip.background.uniforms.frameOffset?.value.y).toBe(31 / 32);
    expect(nativeStrip.warn).not.toHaveBeenCalled();
    for (const [style, path] of [['javaTravelEnd', JAVA_TEXTURES.end1211], ['javaTravelEnd263', JAVA_TEXTURES.end263]] as const) {
      const end = await mount(style, { [path]: texture(256), [JAVA_TEXTURES.endSky]: texture(128) });
      expect(end.optionalTexture.mock.calls.flat()).toEqual([JAVA_TEXTURES.endSky, path]);
      expect(end.background.defines.END).toBe(1);
    }
  });

  it.each(['fade', 'slideUp', 'dissolve'])('首末隐藏，剪辑点实心；乱序不改变 %s', async (style) => {
    const mounted = await mount('javaTravelDirt', { [JAVA_TEXTURES.dirtBlock]: texture() }, { inStyle: style, outStyle: style, cutAt: 0 }, 'en', 1080, 1920);
    expect(mounted.warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('resource stack dirt block'));
    const { instance, root, background } = mounted;
    const values = (time: number) => {
      instance.update(time);
      return [root.visible, root.position.y, background.uniforms.opacity?.value, background.uniforms.phase?.value];
    };
    const entry = values(0.18);
    expect(values(instance.duration)[0]).toBe(false);
    expect(values(instance.cutTime!)).toEqual([true, 0, 1, 1]);
    expect(values(0)[0]).toBe(false);
    expect(values(0.18)).toEqual(entry);
    instance.dispose?.();
    expect(mounted.scene.children).toHaveLength(0);
  });
});
