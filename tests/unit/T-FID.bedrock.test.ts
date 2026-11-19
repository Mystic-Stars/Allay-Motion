import { mkdtempSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { openBedrockPack } from '../../apps/desktop/src/main/resources/bedrock';
import { parseGuiNineSlice, textureIdToPath } from '../../packages/assets/src/index';
import { ease, math, segment } from '../../packages/engine/src/ease';
import { EngineResources, makeDataTexture, textureInfo } from '../../packages/engine/src/resources';
import { createSprite } from '../../packages/engine/src/sprite';
import { diffFromDefaults, isParamVisible, sanitizeParams, TemplateManifestSchema, type ParamValues, type SetupContext, type TemplateModule } from '../../packages/template-sdk/src/index';
import { setupBedrockAchievement } from '../../packages/templates/advancement-toast/src/bedrock';
import { setupBedrockLoading } from '../../packages/templates/loading-screen/src/bedrock';
import { buildZip, solidPng } from './helpers/resource-fixtures';
import loadingManifest from '../../packages/templates/loading-screen/manifest.json';
import toastManifest from '../../packages/templates/advancement-toast/manifest.json';

const requireEngine = createRequire(new URL('../../packages/engine/package.json', import.meta.url));
const THREE = await import(pathToFileURL(requireEngine.resolve('three').replace(/three\.cjs$/, 'three.module.js')).href) as SetupContext['THREE'];
const loading: TemplateModule = { setup: (ctx) => setupBedrockLoading(ctx, String(ctx.params.loadingStyle)) };
const toast: TemplateModule = { setup: setupBedrockAchievement };

describe('T-AST-3 / T-FID · 普通基岩资源', () => {
  it('同代探测合并、成功共享且缺失不污染必需贴图；换代才重新探测', async () => {
    const raw = { kind: 'rgba', width: 1, height: 1, data: new Uint8Array([6, 7, 8, 255]) } as const;
    const resolveTexture = vi.fn(async (kind: string, id: string) => kind === 'texture' && id === 'minecraft:ui/title' ? raw : null);
    const warn = vi.fn();
    const resources = new EngineResources(resolveTexture, vi.fn());
    const title = 'minecraft:ui/title';
    const missing = 'minecraft:ui/missing';
    const [found, required] = await Promise.all([resources.optionalTexture(title), resources.texture(title, warn)]);
    expect(found).toBe(required);
    expect(textureInfo(required)?.missing).toBe(false);
    expect(await Promise.all([resources.optionalTexture(missing), resources.optionalTexture(missing)])).toEqual([null, null]);
    expect(resolveTexture).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
    expect(textureInfo(await resources.texture(missing, warn))?.missing).toBe(true);
    expect(await resources.optionalTexture(missing)).toBeNull();
    expect(textureInfo(await resources.texture(missing, warn))?.missing).toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(resolveTexture).toHaveBeenCalledTimes(4);
    resources.setStamp('changed');
    expect(await resources.optionalTexture(missing)).toBeNull();
    expect(resolveTexture).toHaveBeenCalledTimes(5);
    resources.dispose();
  });

  it('普通 mcpack 保留原加载纹理 ID、大小写归一和九宫格；不映射 UI 代码', async () => {
    const root = mkdtempSync(resolve('tests', '.bedrock-pack-'));
    const path = join(root, 'fixture.mcpack');
    const png = solidPng('#436578');
    try {
      writeFileSync(path, buildZip([
        { name: 'manifest.json', data: JSON.stringify({ format_version: 2, header: { name: 'fixture', uuid: '954a18de-cf49-4276-ba96-847bfcc3e316', version: [1, 0, 0] }, modules: [{ type: 'resources' }] }) },
        ...['ui/title', 'ui/bg32', 'ui/panorama_0', 'ui/loading_bar', 'ui/greyBorder', 'blocks/end_stone'].map((name) => ({ name: `textures/${name}.png`, data: png })),
        { name: 'ui/progress_screen.json', data: '{}' },
      ]));
      const pack = await openBedrockPack(path, 'fixture', true);
      try {
        expect(pack).not.toBeNull();
        for (const id of ['ui/title', 'ui/bg32', 'ui/panorama_0', 'ui/loading_bar', 'ui/greyborder', 'blocks/end_stone', 'block/end_stone']) {
          expect(Array.from(await pack!.read(textureIdToPath(`minecraft:${id}`)!) ?? [])).toEqual(Array.from(png));
        }
        const meta = await pack!.read('assets/minecraft/textures/ui/greyborder.png.mcmeta');
        expect(parseGuiNineSlice(new TextDecoder().decode(meta!))).toEqual({ width: 16, height: 16, border: { left: 4, top: 4, right: 4, bottom: 4 } });
        expect(await pack!.read('assets/minecraft/ui/progress_screen.json')).toBeNull();
      } finally { pack?.close(); }
    } finally { rmSync(path, { force: true }); rmdirSync(root); }
  });

  it('两个 manifest 保持 generic 并只在对应基岩模式暴露绑定字段', () => {
    for (const manifest of [loadingManifest, toastManifest]) {
      const { params = [] } = TemplateManifestSchema.parse(manifest);
      expect(params.find((param) => param.key.endsWith('Style'))?.default).toBe('generic');
      const bindings = params.filter((param) => param.key.startsWith('bedrock'));
      const textureBindings = bindings.filter((binding) => binding.type === 'texture');
      expect(textureBindings.map((binding) => binding.key)).toEqual(manifest === loadingManifest ? ['bedrockBackground', 'bedrockTitle'] : ['bedrockAchievementIcon']);
      for (const binding of textureBindings) expect(binding).toMatchObject({ allowFile: true, default: '', visibleWhen: { key: manifest === loadingManifest ? 'loadingStyle' : 'toastStyle' } });
    }
  });
});

async function sceneFor(template: TemplateModule, params: ParamValues, withTextures = true, options: {
  locale?: string;
  missing?: readonly string[];
  faceSize?: number;
  wide?: boolean;
} = {}) {
  const scene = new THREE.Scene();
  const warn = vi.fn();
  const optionalTexture = vi.fn(async (id: string) => {
    if (!withTextures || options.missing?.includes(id)) return null;
    const [width, height] = id.endsWith('loading_bar') ? [640, 8] : id.endsWith('title') || id.startsWith('file:title') ? [64, 11]
      : id.includes('panorama_') ? [options.faceSize ?? 8, options.faceSize ?? 8]
      : id.endsWith('experiencenub') ? [11, 5] : id.includes('experiencebar') ? [13, 5] : [8, 8];
    const texture = makeDataTexture(width!, height!, new Uint8Array(width! * height! * 4).fill(255));
    texture.name = id;
    return texture;
  });
  const unexpected = (): never => { throw new Error('unexpected template API call'); };
  const create = vi.fn<SetupContext['text']['create']>(({ text, size }) => {
    const object = new THREE.Object3D();
    object.name = text;
    return { object, width: 6 * text.length * size, height: 8 * size, setOpacity() {} };
  });
  const cue = vi.fn<SetupContext['audio']['cue']>();
  const stage = options.wide ? { width: 1920, height: 1080, aspect: 16 / 9, fps: 60, pixelScale: 1 } : { width: 1080, height: 1920, aspect: 9 / 16, fps: 60, pixelScale: 1 };
  const instance = await template.setup({
    THREE, params, locale: options.locale ?? 'zh-CN', scene, stage,
    camera: new THREE.Camera(), setCamera: unexpected, createStageCamera: unexpected,
    resources: { optionalTexture, texture: unexpected, block: unexpected, item: unexpected },
    text: { prepare: async () => undefined, measureGui: unexpected, create },
    sprite: { create: createSprite }, random: unexpected, noise2D: unexpected, ease, math, time: { segment }, audio: { cue }, warn,
  });
  const root = scene.children[0]!;
  const frame = (time: number) => {
    instance.update(time);
    return { visible: root.visible, y: root.position.y, text: root.children.filter((obj) => obj.visible && obj.name).map((obj) => obj.name),
      shaders: root.children.flatMap((obj) => obj instanceof THREE.Mesh && obj.material instanceof THREE.ShaderMaterial
        ? [{ visible: obj.visible, atlas: obj.material.uniforms.frame?.value as number | undefined, fill: obj.material.uniforms.visibleWidth?.value as number | undefined }]
        : []),
    };
  };
  const meshes = root.children.filter((obj) => obj instanceof THREE.Mesh);
  const shader = (uniform: string) => meshes.find((obj) => obj.material instanceof THREE.ShaderMaterial && uniform in obj.material.uniforms)?.material as InstanceType<SetupContext['THREE']['ShaderMaterial']> | undefined;
  const sprites = meshes.filter((obj) => obj.material instanceof THREE.MeshBasicMaterial && obj.material.map !== null);
  return { instance, frame, warn, optionalTexture, create, cue, root, shader, sprites };
}

describe('T-TPL-3/4 · 基岩场景多帧状态', () => {
  it('世界分阶段换文案、往返 UV 后切换确定进度，乱序取同帧一致', async () => {
    const { frame, instance, warn } = await sceneFor(loading, { loadingStyle: 'bedrockWorld', inDuration: 0.3, hold: 2, outDuration: 0.3, subtitle: 'Building terrain…' });
    expect(warn).not.toHaveBeenCalled();
    expect(frame(0).visible).toBe(false);
    const early = frame(0.32);
    const packs = frame(0.78);
    const building = frame(1.4);
    const done = frame(2.22);
    expect(early.text).toContain('正在启动世界');
    expect(packs.text).toContain('正在加载资源包');
    expect(packs.shaders.find((shader) => shader.atlas !== undefined)?.atlas).not.toBe(early.shaders.find((shader) => shader.atlas !== undefined)?.atlas);
    expect(frame(1.28).text).toContain('生成地形中');
    expect(building.text).toContain('带上火把，照亮探索路线。');
    expect(building.text).not.toContain('生成地形中');
    expect(frame(1.9).text).toContain('在远行前记下家的坐标。');
    expect(building.shaders.some((shader) => !shader.visible && shader.atlas !== undefined)).toBe(true);
    expect(done.text).toContain('存活');
    expect(done.shaders.some((shader) => shader.fill === 1)).toBe(true);
    expect(frame(instance.duration).visible).toBe(false);
    expect(frame(0.78)).toEqual(packs);
    expect(frame(1.4)).toEqual(building);
  });

  it('切维度使用对应原路径、标题和面板但无进度；启动缺图不画标题；成就从顶中进入', async () => {
    const travel = await sceneFor(loading, { loadingStyle: 'bedrockTravelEnd' });
    expect(travel.optionalTexture.mock.calls).toEqual([['minecraft:blocks/end_stone'], ['minecraft:ui/title'], ['minecraft:ui/dialog_background_hollow_3']]);
    expect(travel.shader('visibleWidth')).toBeUndefined();
    expect(travel.root.children.some((obj) => obj.renderOrder === 1)).toBe(true);
    const start = await sceneFor(loading, { loadingStyle: 'bedrockStartup', bedrockTitle: 'file:missing' }, false);
    expect(start.optionalTexture).toHaveBeenCalledWith('file:missing');
    expect(start.warn).toHaveBeenCalled();
    expect(start.frame(0.75).text).toContain('正在启动');
    const achievement = await sceneFor(toast, { toastStyle: 'bedrockAchievement', title: '示例', bedrockAchievementIcon: 'file:demo' });
    expect(achievement.optionalTexture.mock.calls).toEqual([['minecraft:ui/greyborder'], ['file:demo']]);
    expect(achievement.instance.cutTime).toBeNull();
    expect(achievement.frame(0).visible).toBe(false);
    const middle = achievement.frame(0.5);
    expect(middle.text).toContain('示例');
    expect(achievement.frame(0.12).y).toBeGreaterThan(middle.y);
    expect(achievement.frame(achievement.instance.duration).visible).toBe(false);
    expect(achievement.frame(0.5)).toEqual(middle);
  });

  it('世界进度的 GUI 坐标、宽度、分隔纹理和全景冻结不会被字号覆盖', async () => {
    const defaults = { loadingStyle: 'bedrockWorld', hold: 2 };
    const usual = await sceneFor(loading, defaults, true, { wide: true });
    const adjusted = await sceneFor(loading, { ...defaults, textScale: 2, animateBackground: false }, true, { wide: true });
    const geometry = (scene: typeof usual, id: string) => {
      const sprite = scene.sprites.find((item) => item.material instanceof THREE.MeshBasicMaterial && item.material.map?.name === id)!;
      const bounds = new THREE.Box3().setFromObject(sprite);
      return [bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, sprite.position.y];
    };
    expect(geometry(usual, 'minecraft:ui/dialog_background_hollow_3')).toEqual([1160, 400, 0]);
    expect(geometry(adjusted, 'minecraft:ui/dialog_background_hollow_3')).toEqual([1160, 400, 0]);
    expect(geometry(usual, 'minecraft:ui/title')[0]).toBeCloseTo(1056, 3);
    expect(adjusted.create.mock.calls[0]![0].size).toBe(2);
    expect(adjusted.shader('repeats')?.uniforms.repeats?.value).toBeCloseTo((278 * 0.9 - 10) / 11);
    adjusted.frame(1.3);
    const yaw = adjusted.shader('yaw')!.uniforms.yaw!.value as number;
    const progress = adjusted.shader('visibleWidth')!.uniforms.visibleWidth!.value as number;
    adjusted.frame(2.2);
    expect(adjusted.shader('yaw')!.uniforms.yaw!.value).toBe(yaw);
    expect(adjusted.shader('visibleWidth')!.uniforms.visibleWidth!.value).toBeGreaterThan(progress);
    expect(usual.optionalTexture).not.toHaveBeenCalledWith('minecraft:ui/bg32');
    const stub = await sceneFor(loading, defaults, true, { faceSize: 1 });
    expect(stub.optionalTexture).toHaveBeenCalledWith('minecraft:ui/bg32');
    expect(stub.warn).toHaveBeenCalled();
    expect(stub.shader('yaw')?.fragmentShader).not.toContain('picture(vUv)');
  });

  it('绑定优先且自定义文案不被轮换覆盖，显式空副标题、显隐和启动百分比字体有效', async () => {
    const world = await sceneFor(loading, {
      loadingStyle: 'bedrockWorld', bedrockTitle: 'file:title', bedrockBackground: 'file:background', title: 'Custom', subtitle: 'Custom tip',
      titleFont: 'test:heading', subtitleFont: 'test:body', showBar: false, loadingLanguage: 'en',
    });
    expect(world.optionalTexture.mock.calls).toEqual([['file:background'], ['file:title'], ['minecraft:ui/dialog_background_hollow_3']]);
    expect(world.shader('visibleWidth')).toBeUndefined();
    expect(world.frame(0.95).text).toEqual(['Custom', 'Custom tip']);
    expect(world.create.mock.calls.map(([entry]) => entry)).toContainEqual(expect.objectContaining({ text: 'Custom tip', font: 'test:body' }));
    const blank = await sceneFor(loading, { loadingStyle: 'bedrockWorld', subtitle: '' });
    expect(blank.frame(0.95).text).toEqual(['正在加载…']);
    const startup = await sceneFor(loading, { loadingStyle: 'bedrockStartup', loadingLanguage: 'en', progressFont: 'test:counter', subtitle: 'Custom', title: 'Custom title' });
    expect(startup.create.mock.calls.map(([entry]) => entry)).toContainEqual(expect.objectContaining({ text: '%', font: 'test:counter' }));
    expect(startup.frame(0.75).text).toContain('Custom title');
  });

  it('成就边距使用设计单位，自选图标失效后回退同资源栈，保留自选字体颜色和音效', async () => {
    const zero = await sceneFor(toast, { toastStyle: 'bedrockAchievement', title: 'Demo' });
    const tuned = await sceneFor(toast, {
      toastStyle: 'bedrockAchievement', title: 'Demo', margin: 36, guiScale: 4, bedrockAchievementIcon: 'file:absent',
      headerColor: '#12ABCD', titleColor: '#88BD22', titleFont: 'test:name', sound: 'test:cue', volume: 0.29,
    }, true, { missing: ['file:absent'] });
    expect(tuned.frame(0.6).y).toBeCloseTo(zero.frame(0.6).y - 36);
    expect(tuned.optionalTexture.mock.calls).toEqual([['minecraft:ui/greyborder'], ['file:absent'], ['minecraft:ui/achievement_third_party']]);
    expect(tuned.warn).toHaveBeenCalledTimes(1);
    expect(tuned.create.mock.calls.map(([entry]) => entry)).toContainEqual(expect.objectContaining({ text: 'Demo', color: '#88BD22', font: 'test:name' }));
    expect(tuned.create.mock.calls[0]![0].color).toBe('#12ABCD');
    expect(tuned.cue).toHaveBeenCalledWith('test:cue', 0, { gain: 0.29 });
  });
});

describe('T-FID · 基岩成就的来源、旧值与保存重开', () => {
  const defs = TemplateManifestSchema.parse(toastManifest).params!;
  const mode = { toastStyle: 'bedrockAchievement' };
  const clean = (params: ParamValues = {}, locale = 'en') => sanitizeParams(defs, { ...mode, ...params }, { locale });
  const serialize = (params: ParamValues) => JSON.parse(JSON.stringify(diffFromDefaults(defs, params, { locale: 'en' }))) as ParamValues;
  const open = (params: ParamValues) => sanitizeParams(defs, serialize(params), { locale: 'zh-CN' });
  const visible = (params: ParamValues, key: string) => isParamVisible(defs.find((definition) => definition.key === key)!, params);

  it('旧工程保留自定义标题、非默认颜色及音效；最初的默认效果不变', async () => {
    const legacy = clean({ header: 'An old heading', headerColor: '#12ABCD', sound: 'test:legacy', volume: 0.37, title: 'Demo' });
    const reopened = open(legacy);
    expect(reopened).toMatchObject({ bedrockHeadingMode: 'compatible', bedrockHeading: 'An old heading' });
    const oldScene = await sceneFor(toast, reopened);
    expect(oldScene.create.mock.calls[0]![0]).toMatchObject({ text: 'An old heading', color: '#12ABCD' });
    expect(oldScene.cue).toHaveBeenCalledWith('test:legacy', 0, { gain: 0.37 });
    expect(visible(reopened, 'volume')).toBe(true);

    const preset = await sceneFor(toast, open(clean()), true, { locale: 'zh-CN' });
    expect(preset.create.mock.calls[0]![0]).toMatchObject({ text: '成就已解锁', color: '#FFFFFF' });
    expect(preset.cue).not.toHaveBeenCalled();
    for (const header of ['Advancement Made!', '进度已达成！', '']) {
      const fullLegacy = await sceneFor(toast, clean({ header }));
      expect(fullLegacy.create.mock.calls[0]![0].text).toBe('成就已解锁');
    }
  });

  it('显式选择原来冲突的标题、黄色和音效，跨语言重开仍按原样使用', async () => {
    const selected = clean({
      bedrockHeadingMode: 'custom', bedrockHeading: 'Advancement Made!', bedrockColorMode: 'custom',
      headerColor: '#FFFF55', bedrockSoundMode: 'custom', sound: 'minecraft:ui.toast.in', volume: 0.23,
    });
    expect(serialize(selected)).toMatchObject({
      bedrockHeadingMode: 'custom', bedrockHeading: 'Advancement Made!', bedrockColorMode: 'custom', bedrockSoundMode: 'custom',
    });
    const after = await sceneFor(toast, open(selected), true, { locale: 'zh-CN' });
    expect(after.create.mock.calls[0]![0]).toMatchObject({ text: 'Advancement Made!', color: '#FFFF55' });
    expect(after.cue).toHaveBeenCalledWith('minecraft:ui.toast.in', 0, { gain: 0.23 });
  });

  it('清空迁移来的标题、关闭音效均可重开；切回预设不会被旧标题回填', async () => {
    const legacy = clean({ header: 'Legacy', sound: 'test:legacy' });
    const cleared = clean({ ...legacy, bedrockHeadingMode: 'custom', bedrockHeading: '', bedrockSoundMode: 'custom', sound: null });
    expect(serialize(cleared)).toMatchObject({ bedrockHeading: '', sound: null });
    const after = await sceneFor(toast, open(cleared));
    expect(after.create.mock.calls).toHaveLength(1);
    expect(after.cue).not.toHaveBeenCalled();
    expect(visible(open(cleared), 'volume')).toBe(false);

    const reset = open(clean({ ...legacy, bedrockHeadingMode: 'preset' }));
    expect(reset.bedrockHeadingMode).toBe('preset');
    const resetScene = await sceneFor(toast, reset);
    expect(resetScene.create.mock.calls[0]![0].text).toBe('成就已解锁');
  });

  it('只显示当前模式的一套控件，不改变 Generic 及 Java 共享参数的默认值', () => {
    const preset = clean();
    const custom = clean({ bedrockHeadingMode: 'custom', bedrockColorMode: 'custom', bedrockSoundMode: 'custom' });
    const bedrockOnly = ['bedrockHeadingMode', 'bedrockHeading', 'bedrockColorMode', 'bedrockSoundMode'];
    expect(['toastLanguage', 'header', 'bedrockHeading', 'headerColor', 'sound', 'volume'].map((key) => visible(preset, key))).toEqual([true, false, false, false, false, false]);
    expect(['toastLanguage', 'header', 'bedrockHeading', 'headerColor', 'sound', 'volume'].map((key) => visible(custom, key))).toEqual([false, false, true, true, true, true]);
    for (const toastStyle of ['generic', 'javaAchievement', 'javaAdvancement', 'javaAdvancement263']) {
      const params = sanitizeParams(defs, { toastStyle }, { locale: 'en' });
      expect(bedrockOnly.some((key) => visible(params, key))).toBe(false);
      expect(['headerColor', 'sound', 'volume'].every((key) => visible(params, key))).toBe(true);
      expect(params).toMatchObject({ header: 'Advancement Made!', headerColor: '#FFFF55', sound: 'minecraft:ui.toast.in', volume: 0.8 });
    }
  });
});
