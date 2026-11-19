import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyPreset, createPreset, defaultParams, diffFromDefaults, isParamVisible, resolveDerived, sanitizeParams, TemplateManifestSchema, type ParamValues, type SetupContext } from '../../packages/template-sdk/src';
import rawManifest from '../../packages/templates/loading-screen/manifest.json';
import { javaLoadingCopy } from '../../packages/templates/loading-screen/src/java-copy';
import { loadingProfile, setupVersionedLoading } from '../../packages/templates/loading-screen/src/versioned';

const manifest = TemplateManifestSchema.parse(rawManifest);
const defs = manifest.params!;
const style = { loadingStyle: 'javaWorld263' };
const normalize = (values: ParamValues) => sanitizeParams(defs, values, { locale: 'zh-CN' });
const visible = (key: string, values: ParamValues) => isParamVisible(defs.find((def) => def.key === key)!, normalize(values));

describe('T-FID.loading-copy', () => {
  it.each([
    ['Loading world', 'Building terrain…'],
    ['正在加载世界', '正在生成地形…'],
  ])('旧完整数据的 %s / %s 是原版标记，显式自定义则是字面', (title, subtitle) => {
    const legacy = { ...style, title, subtitle, javaBarColor: '#00000000', barColor: '#55FF55' };
    expect(normalize(legacy)).toMatchObject({ javaTitleMode: 'vanilla', javaSubtitleMode: 'vanilla', javaFillMode: 'vanilla' });
    expect(javaLoadingCopy(legacy)).toEqual({ title: undefined, subtitle: '', overrideBarColor: undefined });
    expect(javaLoadingCopy(normalize(legacy))).toEqual(javaLoadingCopy(legacy));
    const custom = normalize({ ...legacy, javaTitleMode: 'custom', javaTitle: title, javaSubtitleMode: 'custom', javaSubtitle: subtitle, javaFillMode: 'custom', javaFillColor: '#00000000' });
    expect(javaLoadingCopy(custom)).toEqual({ title, subtitle, overrideBarColor: '#00000000' });
    const preset = createPreset(manifest, 'literal', defs, custom, new Date(0));
    expect(javaLoadingCopy(applyPreset(defs, preset, { locale: 'en' }))).toEqual(javaLoadingCopy(custom));
  });

  it('独立迁移两行、保留旧标题留空与填充色优先级', () => {
    for (const [input, expected] of [
      [{ title: '', subtitle: '正在生成地形…', javaBarColor: '#00000000', barColor: '#0055aa' }, { title: '', subtitle: '', overrideBarColor: '#0055AA' }],
      [{ title: '正在加载世界', subtitle: '旧副标题', javaBarColor: '#FF002280', barColor: '#0055AA' }, { title: undefined, subtitle: '旧副标题', overrideBarColor: '#FF002280' }],
      [{ title: '旧标题', subtitle: '', barColor: '#334455' }, { title: '旧标题', subtitle: '', overrideBarColor: '#334455' }],
      [{ javaFillMode: 'custom', javaFillColor: '#00000000', javaBarColor: '#FF002280' }, { title: undefined, subtitle: '', overrideBarColor: '#00000000' }],
    ] as const) {
      const raw = { ...style, ...input };
      expect(javaLoadingCopy(raw)).toEqual(expected);
      expect(javaLoadingCopy(normalize(raw))).toEqual(expected);
    }
  });

  it('保留隐藏值，重新保存不让旧值反推覆盖显式来源或空串', () => {
    const durations = { inDuration: 0.4, hold: 2, outDuration: 0.6, cutAt: 0.4 };
    const old = normalize({ ...style, title: '旧标题', subtitle: '旧副标题', barColor: '#334455', ...durations });
    const custom = normalize({ ...old, javaTitle: '', javaSubtitle: '正在生成地形…', javaFillColor: '#00000000' });
    const vanilla = normalize({ ...custom, javaTitleMode: 'vanilla', javaSubtitleMode: 'vanilla', javaFillMode: 'vanilla' });
    const reopen = normalize(diffFromDefaults(defs, vanilla));
    expect(javaLoadingCopy(reopen)).toEqual({ title: undefined, subtitle: '', overrideBarColor: undefined });
    expect(reopen).toMatchObject(durations);
    expect(javaLoadingCopy(normalize({ ...reopen, javaTitleMode: 'custom', javaSubtitleMode: 'custom', javaFillMode: 'custom' }))).toEqual(javaLoadingCopy(custom));
    expect(javaLoadingCopy(applyPreset(defs, createPreset(manifest, 'empty', defs, custom, new Date(0))))).toEqual({ title: '', subtitle: '正在生成地形…', overrideBarColor: '#00000000' });
  });

  it('旧派生默认值走同一迁移，通用与基岩参数不串线', () => {
    const derived = TemplateManifestSchema.parse({ formatVersion: 1, id: 'testing.loading', version: '1.0.0', name: 'Loading test', category: 'transition',
      extends: { id: manifest.id, version: manifest.version }, overrides: { defaults: { ...style, title: '派生标题', barColor: '#334455' } } });
    expect(javaLoadingCopy(defaultParams(resolveDerived(derived, manifest).params))).toEqual({ title: '派生标题', subtitle: '', overrideBarColor: '#334455' });
    for (const loadingStyle of ['generic', 'bedrockWorld']) {
      const raw = { loadingStyle, title: '旧标题', subtitle: '旧副标题', barColor: '#334455' };
      expect(normalize(raw)).toMatchObject({ ...raw, javaTitleMode: 'vanilla', javaSubtitleMode: 'vanilla', javaFillMode: 'vanilla' });
      expect(visible('title', raw)).toBe(true);
      expect(visible('subtitle', raw)).toBe(true);
      expect(visible('javaTitleMode', raw)).toBe(false);
      expect(visible('javaFillMode', raw)).toBe(false);
    }
  });

  it('原版／自定义输入互斥，切掉进度条后不再展示颜色控制', () => {
    expect(['title', 'subtitle', 'javaTitle', 'javaSubtitle', 'javaFillColor'].map((key) => visible(key, style))).toEqual([false, false, false, false, false]);
    expect(visible('loadingLanguage', style)).toBe(true);
    const custom = { ...style, javaTitleMode: 'custom', javaSubtitleMode: 'custom', javaFillMode: 'custom' };
    expect(['javaTitle', 'javaSubtitle', 'javaFillColor'].map((key) => visible(key, custom))).toEqual([true, true, true]);
    expect(visible('loadingLanguage', custom)).toBe(false);
    expect(visible('javaFillColor', { ...custom, showBar: false })).toBe(false);
    expect(visible('javaFillMode', { ...custom, showBar: false })).toBe(false);
    expect(visible('javaFillMode', { ...custom, loadingStyle: 'javaWorldPanorama' })).toBe(false);
  });

  it('实际 Java 场景将自定义字面传给画字、透明黑传给填充材质，时长和剪辑点不变', async () => {
    const requireEngine = createRequire(new URL('../../packages/engine/package.json', import.meta.url));
    const module = pathToFileURL(requireEngine.resolve('three').replace(/three\.cjs$/, 'three.module.js')).href;
    const THREE = await import(/* @vite-ignore */ module) as SetupContext['THREE'];
    const profile = loadingProfile('javaWorld263')!;
    const render = async (overrides: ParamValues) => {
      const scene = new THREE.Scene();
      const labels: string[] = [];
      const ctx = {
        THREE, scene, locale: 'zh-CN', params: normalize({ ...style, ...overrides }), stage: { width: 1920, height: 1080, fps: 60 },
        resources: { optionalTexture: async () => null }, warn() {},
        text: {
          measureGui: (text: string) => ({ width: text.length * 8, advance: text.length * 8, left: 0, above: 7, below: 1 }),
          create: ({ text }: { text: string }) => {
            labels.push(text);
            return { object: new THREE.Group(), width: text.length * 8, height: 8, setOpacity() {} };
          },
        },
      } as unknown as SetupContext;
      const instance = await setupVersionedLoading(ctx, profile);
      try {
        instance.update(instance.cutTime!);
        const fill = scene.children[0]?.children.find((child) => child.renderOrder === 4);
        if (!(fill instanceof THREE.Mesh) || !(fill.material instanceof THREE.MeshBasicMaterial)) throw new Error('未建立 Java 填充材质');
        return { labels, opacity: fill.material.opacity, color: fill.material.color.getHexString(), duration: instance.duration, cutTime: instance.cutTime };
      } finally { instance.dispose?.(); }
    };
    const original = await render({});
    expect(original).toMatchObject({ labels: ['加载地形中…'], opacity: 1, color: '00ff00' });
    const custom = await render({ javaTitleMode: 'custom', javaTitle: '正在加载世界', javaSubtitleMode: 'custom', javaSubtitle: '正在生成地形…', javaFillMode: 'custom', javaFillColor: '#00000000' });
    expect(custom).toEqual({ ...original, labels: ['正在加载世界', '正在生成地形…'], opacity: 0, color: '000000' });
    expect((await render({ javaTitleMode: 'custom', javaTitle: '', javaSubtitleMode: 'custom', javaSubtitle: '' })).labels).toEqual([]);
  });
});
