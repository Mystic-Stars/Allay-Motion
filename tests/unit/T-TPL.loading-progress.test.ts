import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { creationParams } from '../../apps/desktop/src/renderer/features/templates/profileDefaults';
import { ease, math, segment } from '../../packages/engine/src/ease';
import { EngineResources } from '../../packages/engine/src/resources';
import { createSprite } from '../../packages/engine/src/sprite';
import loadingManifest from '../../packages/templates/loading-screen/manifest.json';
import toastManifest from '../../packages/templates/advancement-toast/manifest.json';
import loadingTemplate from '../../packages/templates/loading-screen/src/index';
import toastTemplate from '../../packages/templates/advancement-toast/src/index';
import { loadingProfile, loadingProgress } from '../../packages/templates/loading-screen/src/versioned';
import { sanitizeParams, TemplateManifestSchema, type SetupContext } from '../../packages/template-sdk/src/index';
import { versionedTexture } from '../engine/harness/versioned-resources';

const requireEngine = createRequire(new URL('../../packages/engine/package.json', import.meta.url));
const THREE = await import(pathToFileURL(requireEngine.resolve('three').replace(/three\.cjs$/, 'three.module.js')).href) as SetupContext['THREE'];
const loading = TemplateManifestSchema.parse(loadingManifest);
const toast = TemplateManifestSchema.parse(toastManifest);

function sceneFor(key: string, style: string, params: SetupContext['params']) {
  const scene = new THREE.Scene();
  const warn = vi.fn();
  const resources = new EngineResources(async (kind, id) => kind === 'texture' ? versionedTexture(id) : null, vi.fn());
  const optionalTexture = vi.fn((id: string) => resources.optionalTexture(id));
  const item = vi.fn(async () => ({ single: () => new THREE.Group() }));
  const unexpected = (): never => { throw new Error('调用了非版本化路径'); };
  const ctx: SetupContext = {
    THREE, params: { ...params, [key]: style }, locale: 'en', scene, stage: { width: 1920, height: 1080, aspect: 16 / 9, fps: 60, pixelScale: 1 },
    camera: new THREE.Camera(), setCamera: unexpected, createStageCamera: unexpected,
    resources: { optionalTexture, texture: unexpected, block: unexpected, item },
    text: { prepare: async () => undefined, measureGui: (text) => ({ advance: text.length * 6, width: text.length * 6, left: 0, above: 7, below: 1 }), create: ({ text }) => {
      const object = new THREE.Group();
      object.name = text;
      return { object, width: text.length * 6, height: 8, setOpacity() {} };
    } },
    sprite: { create: createSprite }, random: unexpected, noise2D: unexpected, ease, math, time: { segment }, audio: { cue() {} }, warn,
  };
  return { ctx, scene, warn, optionalTexture, item, resources };
}

describe('T-TPL-2 版本选择和模拟加载进度', () => {
  it('旧参数缺失时使用通用样式，新选项均对应实现且有中英标签', () => {
    for (const [manifest, key] of [[loading, 'loadingStyle'], [toast, 'toastStyle']] as const) {
      const params = manifest.params ?? [];
      expect(sanitizeParams(params, {}, { locale: 'zh-CN' })[key]).toBe('generic');
      expect(sanitizeParams(params, { [key]: 'constructor' })[key]).toBe('generic');
      const def = params.find((param) => param.key === key);
      if (def?.type !== 'enum') throw new Error(`missing enum ${key}`);
      for (const option of def.options) {
        expect(option.label).toEqual({ 'zh-CN': expect.any(String), en: expect.any(String) });
      }
    }
  });

  it.each([['loadingStyle', loading, loadingTemplate], ['toastStyle', toast, toastTemplate]] as const)('%s 的所有版本选项走真实模板入口', async (key, manifest, template) => {
    const def = manifest.params?.find((param) => param.key === key);
    if (def?.type !== 'enum') throw new Error(`missing enum ${key}`);
    for (const { value } of def.options) {
      if (value === 'generic') continue;
      const fixture = sceneFor(key, value, sanitizeParams(manifest.params ?? [], {}, { locale: 'en' }));
      const instance = await template.setup(fixture.ctx);
      try {
        expect(fixture.optionalTexture, value).toHaveBeenCalled();
        expect(fixture.warn, value).not.toHaveBeenCalled();
        if (value === 'bedrockAchievement') {
          expect(fixture.optionalTexture.mock.calls.flat()).toEqual(['minecraft:ui/greyborder', 'minecraft:ui/achievement_third_party']);
          expect(fixture.item).not.toHaveBeenCalled();
          instance.update(instance.duration / 2);
          expect(fixture.scene.children[0]?.position.x).toBe(0);
        }
      } finally { instance.dispose?.(); fixture.resources.dispose(); }
    }
  });

  it('区分早期区块布局、经下界路线与 26.3 的状态实现', () => {
    expect(loadingProfile('javaWorldDirt114')).toMatchObject({ background: 'dirt', layout: 'percent', grid: 45 });
    expect(loadingProfile('javaWorldDirt')).toMatchObject({ background: 'dirt', layout: 'percent', grid: 43 });
    expect(loadingProfile('javaWorldPanorama')).toMatchObject({ background: 'javaPanorama', layout: 'percent', grid: 29 });
    expect(loadingProfile('javaWorldBar')).toMatchObject({ background: 'javaPanorama', layout: 'chunkBar', grid: 35 });
    expect(loadingProfile('javaWorld263')).toMatchObject({ background: 'javaPanorama', layout: 'chunkBar', grid: 35, modern: true });
    expect(loadingProfile('javaTravelNether')).toMatchObject({ scene: 'dimension', background: 'netherPortal' });
    expect(loadingProfile('bedrockTravelNether')).toMatchObject({ scene: 'dimension', background: 'netherrack' });
  });

  it.each([
    ['java', '1.11.2', true, 'generic', 'generic'],
    ['java', '1.12', true, 'generic', 'javaAdvancement'],
    ['java', '1.14', true, 'javaWorldDirt114', 'javaAdvancement'],
    ['java', '1.14.1', true, 'javaWorldDirt', 'javaAdvancement'],
    ['java', '1.20.4', true, 'javaWorldDirt', 'javaAdvancement'],
    ['java', '1.20.5', true, 'javaWorldPanorama', 'javaAdvancement'],
    ['java', '1.21.8', true, 'javaWorldPanorama', 'javaAdvancement'],
    ['java', '1.21.9', true, 'javaWorldBar', 'javaAdvancement'],
    ['java', '1.21.11', true, 'javaWorldBar', 'javaAdvancement'],
    ['java', '1.21.12', true, 'generic', 'generic'],
    ['java', '26.3', false, 'generic', 'generic'],
    ['java', '26.3', true, 'javaWorld263', 'javaAdvancement263'],
    ['bedrock', '1.21.0', true, 'bedrockWorld', 'bedrockAchievement'],
    ['bedrock', '1.21.1', true, 'generic', 'generic'],
  ] as const)('%s %s（release=%s）显式新建的判定边界', (edition, version, release, loadingStyle, toastStyle) => {
    const resource = { edition, version, release };
    expect(creationParams({ ref: loading, params: loading.params ?? [] }, 'en', resource).loadingStyle).toBe(loadingStyle);
    expect(creationParams({ ref: toast, params: toast.params ?? [] }, 'en', resource).toastStyle).toBe(toastStyle);
  });

  it.each(['resource', 'chunks', 'bedrock'] as const)('%s 进度有停顿、单调不回退、首尾封顶', (mode) => {
    const samples = Array.from({ length: 101 }, (_, index) => loadingProgress(mode, index / 100));
    expect(loadingProgress(mode, -1)).toBe(0);
    expect(loadingProgress(mode, 2)).toBe(1);
    expect(samples.every((value, index) => !index || value >= samples[index - 1]!)).toBe(true);
    expect(samples.some((value, index) => value > 0 && value < 1 && value === samples[index - 1])).toBe(true);
    expect(samples[50]).not.toBe(0.5);
  });
});
