import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { SoundImports } from '../../apps/desktop/src/main/resources/sound-imports';
import { cueWindow } from '../../apps/desktop/src/renderer/audio/schedule';
import { encodeWav } from '../../apps/desktop/src/renderer/audio/wav';
import { localFrame, placeCue } from '../../packages/engine/src/composition-timing';
import { CompositionLoadRequestSchema, defaultParams, parseManifest, sanitizeParams, studioMaterialRefs, type AudioCue, type CompositionClip, type ParamValues, type SetupContext, type TemplateModule } from '../../packages/template-sdk/src/index';
import manifest from '../../packages/template-sdk/src/studio/object.json';
import { makeService, basePackage, writePackage } from './helpers/template-fixtures';

const template = { id: manifest.id, version: manifest.version };
const parsed = parseManifest(manifest);
if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
const defs = parsed.manifest.params ?? [];

describe('T-STUDIO 素材对象层', () => {
  it('T-STUDIO-OBJ-1 四种类型使用各自的编辑器参数，引用经 SDK 校验，中英有默认文案', () => {
    expect(defaultParams(defs, { locale: 'zh-CN' })).toMatchObject({ kind: 'text', text: '文字', image: '', sound: null });
    expect(defaultParams(defs, { locale: 'en' }).text).toBe('Text');
    expect(defs).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'image', type: 'texture', allowFile: true, visibleWhen: { key: 'kind', equals: 'image' } }),
      expect.objectContaining({ key: 'font', type: 'font', visibleWhen: { key: 'kind', equals: 'text' } }),
      expect.objectContaining({ key: 'block', type: 'block', visibleWhen: { key: 'kind', equals: 'block' } }),
      expect.objectContaining({ key: 'sound', type: 'sound', visibleWhen: { key: 'kind', equals: 'sound' } }),
    ]));
    const image = 'file:152b09cf-7a04-4a64-bf21-d857311aee01';
    const font = `user-font:${'1'.repeat(64)}`;
    expect(sanitizeParams(defs, { image, font })).toMatchObject({ image, font });
    expect(sanitizeParams(defs, { image: 'C:/images/photo.png' }).image).toBe('');
  });

  it('T-STUDIO-OBJ-2 原生素材只接受合成引用，不读取旧内置包或装载片段提供的脚本', async () => {
    const root = await mkdtemp(join(tmpdir(), 'allay-studio-objects-'));
    try {
      const builtin = join(root, 'builtin');
      writePackage(join(builtin, 'stale.allaytpl'), basePackage(studioMaterialRefs.object));
      const service = await makeService(join(root, 'user'), builtin);
      expect(service.list()).toEqual([]);
      expect(await service.read(template.id, template.version)).toBeNull();
      const clip = { id: 'text', template, params: { kind: 'text' }, startFrame: 0, sourceInFrame: 0, durationFrames: 30 };
      const composition = { formatVersion: 1, fps: 30, durationFrames: 30,
        tracks: [{ id: 'test', name: 'test', locked: false, muted: false, clips: [clip] }] };
      const request = { composition, output: { width: 80, height: 80, fps: 30 } };
      const native = { template, resourceStamp: 'test' };
      expect(CompositionLoadRequestSchema.safeParse({ ...request, sources: [native] }).success).toBe(true);
      expect(CompositionLoadRequestSchema.safeParse({ ...request, sources: [{ ...native, manifest, code: 'export default null;' }] }).success).toBe(false);
      const frozen = await service.freezeComposition({ document: JSON.stringify(composition), name: 'test', canvas: { width: 80, height: 80 }, expose: [{ clipId: clip.id, key: 'text' }] });
      await service.compositionLibrary.remember(frozen);
      expect(await service.openComposition(frozen.id)).toMatchObject({ composition, exposed: [{ clipId: clip.id, key: 'text' }] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('T-STUDIO-OBJ-3 导入五分钟本机音轨，裁晚段、乱序定位与越过源末尾均正确', async () => {
    const root = await mkdtemp(join(tmpdir(), 'allay-studio-audio-'));
    try {
      const path = join(root, 'track.wav');
      await writeFile(path, encodeWav([new Float32Array(300 * 8000)], 8000));
      const library = new SoundImports(root);
      const { id } = await library.add(path, 'music');
      await rm(path);
      expect(sanitizeParams(defs, { kind: 'sound', sound: id })).toMatchObject({ kind: 'sound', sound: id });
      expect(await library.read(id)).toHaveLength(44 + 300 * 8000 * 2);
      const [variant] = (await library.variants(id)) ?? [];
      expect(variant).toMatchObject({ file: id, kind: 'music' });
      const cue: AudioCue = { sound: id, at: 0, gain: 1, pan: 0, rate: 1, variant: variant ?? null };
      const clip: CompositionClip = { id: 'audio', template, params: { kind: 'sound', sound: id },
        startFrame: 60, sourceInFrame: 30, durationFrames: 299 * 60 };
      const placed = placeCue(cue, clip, 60, 300 * 60)!;
      expect(placed).toMatchObject({ at: 1, clip: { offset: 0.5, end: 300 } });
      expect(cueWindow(placed, 300, 1, 299)).toEqual({ start: 299, offset: 298.5, end: 300 });
      expect(cueWindow(placed, 300, 1, 0)).toEqual({ start: 1, offset: 0.5, end: 300 });
      expect(cueWindow(placed, 300, 1, 300)).toBeNull();
      expect(cueWindow(placed, 298, 1, 299)).toBeNull();
      expect([18_000, 60, 59, 17_999].map((frame) => localFrame(clip, frame))).toEqual([null, 0, null, 17_939]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('四个分支构建对应的 Three.js 对象，仅音频分支登记 cue 且场景为空', async () => {
    const source = '../../packages/engine/src/studio/object.ts';
    const { default: objectTemplate } = await import(source) as { default: TemplateModule };
    const requireEngine = createRequire(resolve(import.meta.dirname, '../../packages/engine/package.json'));
    const THREE = await import(pathToFileURL(requireEngine.resolve('three').replace(/three\.cjs$/, 'three.module.js')).href) as SetupContext['THREE'];
    const map = new THREE.DataTexture(new Uint8Array(8 * 4 * 4), 8, 4);
    const glyphs = new THREE.Group();
    const cube = new THREE.Mesh(new THREE.BoxGeometry());
    const texture = vi.fn(async () => map);
    const create = vi.fn(() => ({ object: glyphs, width: 10, height: 5, setOpacity() {} }));
    const block = vi.fn(async () => ({ single: () => cube, instanced: () => { throw new Error('not a single block'); }, faceTexture: () => map }));
    const cue = vi.fn();
    async function setup(params: ParamValues) {
      const scene = new THREE.Scene();
      const ctx: SetupContext = {
        THREE, locale: 'en', params: sanitizeParams(defs, params), scene, stage: { width: 1080, height: 1080, aspect: 1, fps: 30, pixelScale: 1 },
        camera: new THREE.Camera(), setCamera() {}, createStageCamera: () => new THREE.PerspectiveCamera(),
        resources: { texture, optionalTexture: texture, block, item: () => { throw new Error('unexpected item'); } },
        text: { prepare: async () => undefined, measureGui: () => { throw new Error('unexpected GUI measurement'); }, create }, audio: { cue },
        sprite: { create: () => { throw new Error('unexpected sprite'); } },
        random: () => { throw new Error('unexpected randomness'); }, noise2D: () => 0,
        ease: {} as SetupContext['ease'], math: {} as SetupContext['math'], time: { segment: () => 0 }, warn() {},
      };
      const instance = await objectTemplate.setup(ctx);
      for (const time of [2.9, 0, 2, 0]) instance.update(time);
      expect(instance.duration).toBeLessThanOrEqual(30);
      return scene;
    }
    const scene = await setup({ kind: 'image', image: 'file:152b09cf-7a04-4a64-bf21-d857311aee01' });
    expect(scene.children).toHaveLength(1);
    const plane = scene.children[0];
    if (!(plane instanceof THREE.Mesh) || !(plane.geometry instanceof THREE.PlaneGeometry)) throw new Error('missing image plane');
    expect(plane.geometry.parameters.width / plane.geometry.parameters.height).toBe(2);
    expect((await setup({ kind: 'image' })).children).toHaveLength(0);
    expect(texture).toHaveBeenCalledTimes(1);
    expect((await setup({ kind: 'text', font: 'test:glyphs' })).children).toEqual([glyphs]);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ font: 'test:glyphs', align: 'center' }));
    expect((await setup({ kind: 'block', block: 'minecraft:dirt' })).children).toEqual([cube]);
    expect(block).toHaveBeenCalledWith('minecraft:dirt');
    expect(cue).not.toHaveBeenCalled();
    expect((await setup({ kind: 'sound', sound: 'test:music', image: 'test:image', text: 'A' })).children).toHaveLength(0);
    expect(cue).toHaveBeenCalledExactlyOnceWith('test:music', 0, { gain: 1 });
    expect(texture).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(block).toHaveBeenCalledTimes(1);
  });
});
