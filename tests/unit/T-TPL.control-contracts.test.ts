import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { ease, math, segment } from '../../packages/engine/src/ease';
import { createRng } from '../../packages/engine/src/random';
import { createSprite } from '../../packages/engine/src/sprite';
import { TemplateManifestSchema, sanitizeParams, type ParamValues, type SetupContext, type TemplateModule } from '../../packages/template-sdk/src/index';
import blockWipe from '../../packages/templates/block-wipe/src/index';
import wipeManifest from '../../packages/templates/block-wipe/manifest.json';
import blockFall from '../../packages/templates/block-fall/src/index';
import fallManifest from '../../packages/templates/block-fall/manifest.json';
import itemStinger from '../../packages/templates/item-stinger/src/index';
import stingerManifest from '../../packages/templates/item-stinger/manifest.json';
import pixelDissolve from '../../packages/templates/pixel-dissolve/src/index';
import dissolveManifest from '../../packages/templates/pixel-dissolve/manifest.json';
import motionManifest from '../../packages/template-sdk/src/studio/player.json';
import objectManifest from '../../packages/template-sdk/src/studio/object.json';
import { isVisible } from '../../packages/ui/src/editor/ParamPanel';

const requireEngine = createRequire(new URL('../../packages/engine/package.json', import.meta.url));
const THREE = await import(pathToFileURL(realpathSync(requireEngine.resolve('three')).replace(/three\.cjs$/, 'three.module.js')).href) as SetupContext['THREE'];
const motionSource = '../../packages/engine/src/studio/player/index.ts';
const objectSource = '../../packages/engine/src/studio/object.ts';
const { default: playerMotion } = await import(motionSource) as { default: TemplateModule };
const { default: studioObject } = await import(objectSource) as { default: TemplateModule };
const unexpected = (): never => { throw new Error('未预期的模板调用'); };
const texture = (width: number, height: number) => new THREE.DataTexture(new Uint8Array(width * height * 4).fill(255), width, height);

async function run(template: TemplateModule, manifest: unknown, edits: ParamValues = {}, image?: ReturnType<typeof texture>) {
  const defs = TemplateManifestSchema.parse(manifest).params ?? [];
  const params = sanitizeParams(defs, edits);
  const scene = new THREE.Scene();
  const map = image ?? texture(16, 16);
  const landings: { id: string; index: number; matrix: number[] }[] = [];
  const cue = vi.fn<SetupContext['audio']['cue']>();
  const text = vi.fn<SetupContext['text']['create']>(() => ({ object: new THREE.Group(), width: 20, height: 10, setOpacity() {} }));
  const warn = vi.fn<SetupContext['warn']>();
  const block = vi.fn<SetupContext['resources']['block']>(async (id) => ({
    single: () => new THREE.Mesh(new THREE.BoxGeometry()),
    faceTexture: () => map,
    instanced: (count) => ({
      count, object: new THREE.Group(), setMatrix: (index, value) => landings.push({ id, index, matrix: [...value.elements] }),
      setOpacity: unexpected, setTint: unexpected, commit() {},
    }),
  }));
  const item = vi.fn<SetupContext['resources']['item']>(async () => ({ single: () => new THREE.Group() }));
  const setCamera = vi.fn<SetupContext['setCamera']>();
  const instance = await template.setup({
    THREE, params, locale: 'en', scene, stage: { width: 1920, height: 1080, aspect: 16 / 9, fps: 60, pixelScale: 1 },
    camera: new THREE.OrthographicCamera(), setCamera, createStageCamera: ({ fov }) => new THREE.PerspectiveCamera(fov),
    resources: { block, item, texture: async () => map, optionalTexture: async () => image ?? null },
    text: { prepare: unexpected, measureGui: unexpected, create: text }, sprite: { create: createSprite },
    random: (key = '') => createRng(typeof params.seed === 'number' ? params.seed : 1, key),
    noise2D: (x, y) => Math.sin(x * 2.3 + y) * Math.cos(y * 1.7 - x),
    ease, math, time: { segment }, audio: { cue }, warn,
  });
  return {
    params, scene, instance, cue, text, warn, block, item, setCamera,
    shows: (key: string) => isVisible(defs.find((def) => def.key === key)!, params),
    sample: (time: number) => { landings.length = 0; instance.update(time); return landings.slice(); },
    uniforms: () => {
      const mesh = scene.children[0];
      if (!(mesh instanceof THREE.Mesh) || !(mesh.material instanceof THREE.ShaderMaterial)) throw new Error('未找到着色器网格');
      return mesh.material.uniforms;
    },
  };
}

describe('T-TPL-3/4 原创模板的参数契约', () => {
  it('方块擦除：正交模式仍读旋转；重叠为 1 时所有方块同时起动', async () => {
    const flat = await run(blockWipe, wipeManifest, { style: 'flat', spin: 'flipX', cols: 4, overlap: 1 });
    const noSpin = await run(blockWipe, wipeManifest, { style: 'flat', spin: 'none', cols: 4, overlap: 1 });
    expect(flat.setCamera).not.toHaveBeenCalled();
    expect(flat.block).toHaveBeenCalledWith('minecraft:diamond_block', { shading: false });
    expect(flat.sample(0.2)[0]!.matrix).not.toEqual(noSpin.sample(0.2)[0]!.matrix);
    const cues = flat.cue.mock.calls.filter(([sound]) => sound === flat.params.placeSound);
    expect(cues).toHaveLength(12);
    expect(new Set(cues.map(([, time]) => time)).size).toBe(1);
  });

  it.each([[blockWipe, wipeManifest], [blockFall, fallManifest]] as const)('两种方块模板：音乐独立调音，关闭后保留音量值；单一材质不受布局和权重影响', async (template, manifest) => {
    const common = { cols: 4, placeSound: null, breakSound: null, musicVolume: 0.23 };
    const silent = await run(template, manifest, { ...common, blocks: [{ id: 'minecraft:stone', weight: 1 }] });
    const music = await run(template, manifest, { ...common, blocks: [{ id: 'minecraft:stone', weight: 7 }], music: 'test:music', materialDistribution: 'checker', spatialAudio: true });
    expect(silent.shows('musicVolume')).toBe(false);
    expect(silent.params.musicVolume).toBe(0.23);
    expect(silent.cue).not.toHaveBeenCalled();
    expect(music.shows('musicVolume')).toBe(true);
    expect(music.cue).toHaveBeenCalledExactlyOnceWith('test:music', 0, { gain: 0.23 });
    expect(music.sample(0.32)).toEqual(silent.sample(0.32));
  });

  it('方块坠落：零回弹的第一声落地更晚；空间音只作用于方块声音', async () => {
    const bounce = await run(blockFall, fallManifest, { bounce: 0.75, spatialAudio: true, volume: 0.42 });
    const noBounce = await run(blockFall, fallManifest, { bounce: 0, spatialAudio: false, volume: 0.42 });
    const [sound, at, opts] = bounce.cue.mock.calls[0]!;
    expect(sound).toBe('minecraft:block.stone.place');
    expect(opts).toMatchObject({ gain: 0.42, position: [expect.any(Number), expect.any(Number), 0] });
    expect(noBounce.cue.mock.calls[0]![1]).toBeGreaterThan(at);
    expect(noBounce.cue.mock.calls[0]![2]).toEqual({ gain: 0.42 });
    expect(noBounce.sample(at)).not.toEqual(bounce.sample(at));
  });

  it('物品飞掠：图片优先且按动画单帧尺寸取景，缺图才使用选中的物品', async () => {
    const image = texture(24, 96);
    image.repeat.set(1, 0.25);
    const patch = { item: 'minecraft:apple', image: 'test:custom', itemScale: 0.44, sound: null, edge: 'straight', pixelSize: 120 };
    const withImage = await run(itemStinger, stingerManifest, patch, image);
    expect(withImage.shows('item')).toBe(false);
    expect(withImage.shows('volume')).toBe(false);
    expect(withImage.item).not.toHaveBeenCalled();
    expect(withImage.cue).not.toHaveBeenCalled();
    const sprite = withImage.scene.children[1]?.children[0];
    if (!(sprite instanceof THREE.Mesh)) throw new Error('未找到自定义图片');
    sprite.geometry.computeBoundingBox();
    const size = sprite.geometry.boundingBox!.getSize(new THREE.Vector3());
    expect(size.x).toBeCloseTo(size.y);
    expect(size.y).toBeCloseTo(0.44 * 1080, 3);
    expect(withImage.uniforms().uPixel?.value).toBe(120);
    const missing = await run(itemStinger, stingerManifest, patch);
    expect(missing.item).toHaveBeenCalledExactlyOnceWith('minecraft:apple');
    expect(missing.warn).toHaveBeenCalledWith(expect.stringContaining('unavailable'));
    expect(missing.params.image).toBe(patch.image);
    const cleared = await run(itemStinger, stingerManifest, { ...patch, image: '' });
    expect(cleared.shows('item')).toBe(true);
    expect(cleared.item).toHaveBeenCalledExactlyOnceWith('minecraft:apple');
    expect(cleared.warn).not.toHaveBeenCalled();
  });

  it.each([[itemStinger, stingerManifest, 'fillBlock'], [pixelDissolve, dissolveManifest, 'block']] as const)('方块填充读取所选贴图及其不断更新的单帧 UV', async (template, manifest, key) => {
    const map = texture(8, 16);
    map.repeat.set(1, 0.5);
    map.offset.set(0, 0.5);
    const result = await run(template, manifest, { fill: 'block', [key]: 'minecraft:water' }, map);
    expect(result.block).toHaveBeenCalledExactlyOnceWith('minecraft:water', { shading: false });
    const { uTex, uTexRepeat, uTexOffset } = result.uniforms();
    expect(uTex?.value).toBe(map);
    expect(uTexRepeat?.value).toEqual(new THREE.Vector2(1, 0.5));
    expect(uTexOffset?.value).toEqual(new THREE.Vector2(0, 0.5));
    map.offset.set(0, 0);
    result.instance.update(0.2);
    expect(uTexOffset?.value).toEqual(new THREE.Vector2(0, 0));
  });

  it('像素溶解：模式切换保留错落，只有扫过和径向用它改变阈值；零宽度隐藏边缘色', async () => {
    const thresholds = (result: Awaited<ReturnType<typeof run>>) => {
      const map: unknown = result.uniforms().uThresh?.value;
      if (!(map instanceof THREE.DataTexture)) throw new Error('缺少阈值贴图');
      return map.image.data;
    };
    for (const pattern of ['noise', 'random', 'sweep', 'radial']) {
      const changed = await run(pixelDissolve, dissolveManifest, { pattern, spread: 0.91, accentWidth: 0, outReverse: true });
      const control = await run(pixelDissolve, dissolveManifest, { pattern, spread: 0, accentWidth: 0 });
      const usesSpread = pattern === 'sweep' || pattern === 'radial';
      expect(changed.shows('spread')).toBe(usesSpread);
      expect(changed.shows('angle')).toBe(pattern === 'sweep');
      expect(changed.shows('accentColor')).toBe(false);
      expect(changed.params.spread).toBe(0.91);
      if (usesSpread) expect(thresholds(changed)).not.toEqual(thresholds(control));
      else expect(thresholds(changed)).toEqual(thresholds(control));
      expect(changed.uniforms().uReverse?.value).toBe(1);
    }
  });

  it('角色：站立与跳跃隐藏步伐晃动，走跑时改值改变机位且不修改资源贴图', async () => {
    const skin = 'skins:152b09cf-7a04-4a64-bf21-d857311aee01';
    const map = texture(64, 64);
    map.minFilter = THREE.LinearMipmapLinearFilter;
    map.generateMipmaps = true;
    const idle = await run(playerMotion, motionManifest, { skin, action: 'idle', bob: 1, edition: 'bedrock' }, map);
    expect(idle.shows('edition')).toBe(false);
    expect(idle.shows('bob')).toBe(false);
    const jump = await run(playerMotion, motionManifest, { skin, action: 'jump' }, map);
    expect(jump.shows('edition')).toBe(true);
    expect(jump.shows('bob')).toBe(false);
    const running = await run(playerMotion, motionManifest, { skin, action: 'sprint', bob: 0.9, fov: 70, orbit: -30 }, map);
    const steady = await run(playerMotion, motionManifest, { skin, action: 'sprint', bob: 0, fov: 70, orbit: -30 }, map);
    running.instance.update(0.33);
    steady.instance.update(0.33);
    const camera = running.setCamera.mock.calls[0]?.[0];
    expect(camera).toBeInstanceOf(THREE.PerspectiveCamera);
    expect(camera).toMatchObject({ fov: 70 });
    expect(camera?.position.x).toBeLessThan(0);
    expect(camera?.position.toArray()).not.toEqual(steady.setCamera.mock.calls[0]?.[0].position.toArray());
    expect(map.minFilter).toBe(THREE.LinearMipmapLinearFilter);
    expect(map.generateMipmaps).toBe(true);
    const missing = await run(playerMotion, motionManifest, { skin });
    expect(missing.warn).toHaveBeenCalledOnce();
    expect(missing.scene.children).toEqual([]);
  });

  it('素材对象：只消费当前类型的值；从音频切回文字保留字体、文案和大小', async () => {
    const edits = { text: '用户输入', font: 'test:glyphs', textSize: 31, color: '#a1173e', shadow: true, sound: 'test:score', gain: 1.34 };
    const audio = await run(studioObject, objectManifest, { ...edits, kind: 'sound' });
    expect(audio.shows('text')).toBe(false);
    expect(audio.shows('gain')).toBe(true);
    expect(audio.scene.children).toEqual([]);
    expect(audio.cue).toHaveBeenCalledExactlyOnceWith('test:score', 0, { gain: 1.34 });
    const title = await run(studioObject, objectManifest, { ...audio.params, kind: 'text' });
    expect(title.shows('text')).toBe(true);
    expect(title.shows('gain')).toBe(false);
    expect(title.cue).not.toHaveBeenCalled();
    expect(title.text).toHaveBeenCalledWith(expect.objectContaining({ text: edits.text, font: edits.font, size: 31, color: '#A1173E', shadow: true }));
  });
});
