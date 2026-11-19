import { applyPreset, createPreset, defaultParams, diffFromDefaults, ParamDefSchema, sanitizeParams } from '../../packages/template-sdk/src';
import { describe, expect, it, vi } from 'vitest';
import loadingManifest from '../../packages/templates/loading-screen/manifest.json';
import toastManifest from '../../packages/templates/advancement-toast/manifest.json';
import { javaToastTiming } from '../../packages/templates/advancement-toast/src/java-timing';
import type { ResourceProfileInfo, ResourceState } from '../../apps/desktop/src/shared/resources';
import { coverKey, profileCoverKey } from '../../apps/desktop/src/renderer/features/gallery/covers';
import { boundResourceEdition, creationParams } from '../../apps/desktop/src/renderer/features/templates/profileDefaults';

vi.mock('../../apps/desktop/src/renderer/engine-host/EngineHost', () => ({ EngineHost: {} }));

const relevantKeys = new Set(['loadingStyle', 'toastStyle', 'title', 'inDuration', 'hold', 'outDuration', 'javaTiming']);
function sourceOf(manifest: typeof loadingManifest | typeof toastManifest) {
  return { ref: manifest, params: manifest.params.filter(({ key }) => relevantKeys.has(key)).map((def) => ParamDefSchema.parse(def)) };
}
const loading = sourceOf(loadingManifest);
const toast = sourceOf(toastManifest);
const profile = (id: string, versionId: string, source: ResourceProfileInfo['source'] = 'downloaded'): ResourceProfileInfo => ({
  id, versionId, source, name: id, missing: false, stamp: id, gameDir: null, resourcePacksDir: null, sourcePath: '',
});
const resources: ResourceState = {
  stamp: 'a', layers: [], brokenPacks: [], vanilla: { consent: true, enabled: true, active: 'cached', problem: null, local: null, cached: { versionId: '1.21.11' } },
  download: { status: 'idle' }, detecting: false, hasAssets: true,
  library: { activeProfileId: 'active', pinnedId: 'pinned', profiles: [profile('active', '1.21.1'), profile('pinned', '1.21.11'), profile('bedrock', '1.21.0', 'bedrock')] },
};

describe('T-FID.profile-defaults', () => {
  it('只跟随实际绑定的资源：片段、工程、主资源依序，缺失不借用主资源', () => {
    expect(creationParams(loading, 'en', boundResourceEdition(resources)).loadingStyle).toBe('javaWorldPanorama');
    expect(creationParams(loading, 'en', boundResourceEdition(resources, 'pinned')).loadingStyle).toBe('javaWorldBar');
    const bedrock = boundResourceEdition(resources, 'pinned', 'bedrock');
    expect(creationParams(loading, 'en', bedrock).loadingStyle).toBe('bedrockWorld');
    expect(creationParams(toast, 'en', bedrock).toastStyle).toBe('bedrockAchievement');
    expect(boundResourceEdition(resources, 'missing')).toBeNull();
    expect(boundResourceEdition({ ...resources, library: { ...resources.library!, activeProfileId: null } })).toBeNull();
  });

  it.each(['1.21.1', '1.21.9', '1.21.10', '1.21.11'])('Java %s 使用进度布局和新时长；显式参数优先', (version) => {
    const resource = { edition: 'java', version, release: true } as const;
    expect(creationParams(toast, 'en', resource)).toMatchObject({ toastStyle: 'javaAdvancement', inDuration: 0.6, hold: 5, outDuration: 0.6 });
    expect(creationParams(toast, 'en', resource, { hold: 3, title: 'Custom' })).toMatchObject({ hold: 3, title: 'Custom' });
    expect(creationParams(toast, 'en', resource, { toastStyle: 'generic' })).toEqual(defaultParams(toast.params));
  });

  it.each([[loading, 'loadingStyle', 'javaWorld263'], [toast, 'toastStyle', 'javaAdvancement263']] as const)('26.3 只启用实际声明的场景', (source, key, value) => {
    const resource = { edition: 'java', version: '26.3', release: true } as const;
    const without = { ...source, params: source.params.map((def) => def.type === 'enum' ? { ...def, options: def.options.filter((option) => option.value !== value) } : def) };
    expect(creationParams(without, 'en', resource)[key]).toBe('generic');
    const withScene = { ...without, params: without.params.map((def) => def.key === key && def.type === 'enum'
      ? { ...def, options: [...def.options, { value, label: value }] } : def) };
    expect(creationParams(withScene, 'en', resource)[key]).toBe(value);
  });

  it.each(['javaAdvancement', 'javaAdvancement263'] as const)('新建计时与 %s 的原版计时分段一致', (style) => {
    const recipe = creationParams(toast, 'en', null, { toastStyle: style });
    const reference = javaToastTiming(style, { javaTiming: 'vanilla' });
    expect(javaToastTiming(style, recipe)).toMatchObject({ duration: reference.duration, outAt: reference.outAt });
  });

  it('未知来源用参考场景，未知版本和快照不冒充匹配', () => {
    expect(creationParams(loading, 'zh-CN', null).loadingStyle).toBe('javaWorldPanorama');
    expect(creationParams(toast, 'en', null).toastStyle).toBe('javaAdvancement');
    expect(creationParams(loading, 'en', { edition: 'java', version: '1.21.12', release: true }).loadingStyle).toBe('generic');
    expect(creationParams(toast, 'en', { edition: 'java', version: '1.21.11', release: false }).toastStyle).toBe('generic');
    expect(creationParams(toast, 'en', { edition: 'bedrock', version: '1.0.0', release: true }).toastStyle).toBe('generic');
  });

  it('新参数存差值能还原；旧 v1 工程和空预设继续按原 manifest 补值', () => {
    for (const source of [loading, toast]) {
      const style = source === loading ? 'loadingStyle' : 'toastStyle';
      const created = creationParams(source, 'en', boundResourceEdition(resources));
      const saved = diffFromDefaults(source.params, created, { locale: 'en' });
      expect(saved[style]).not.toBeUndefined();
      expect(sanitizeParams(source.params, saved, { locale: 'en' })).toEqual(created);
      const old = sanitizeParams(source.params, {}, { locale: 'en' });
      expect(old[style]).toBe('generic');
      const preset = createPreset(source.ref, 'Old', source.params, old, new Date(0), { locale: 'en' });
      expect(preset.params).toEqual({});
      expect(applyPreset(source.params, preset, { locale: 'en' })).toEqual(old);
    }
    expect(sanitizeParams(toast.params, {}).hold).toBe(2.5);
  });

  it('派生和其他模板继续使用其自己的默认值', () => {
    const custom = { ...toast, ref: { ...toast.ref, id: 'user.custom-toast' } };
    expect(creationParams(custom, 'en', boundResourceEdition(resources))).toEqual(defaultParams(custom.params, { locale: 'en' }));
  });

  it('封面缓存隔离旧封面、版本配方、语言和模板代码', async () => {
    const key = coverKey(loading.ref.id, loading.ref.version);
    const active = creationParams(loading, 'en', boundResourceEdition(resources));
    const project = creationParams(loading, 'en', boundResourceEdition(resources, 'pinned'));
    const cacheKey = await profileCoverKey(key, 'en', active, 'code');
    expect(cacheKey).toMatch(/^[a-z0-9_.~-]{1,194}$/);
    expect(await profileCoverKey(key, 'en', active, 'code')).toBe(cacheKey);
    expect(new Set([key, cacheKey, await profileCoverKey(key, 'en', project, 'code'),
      await profileCoverKey(key, 'zh-CN', active, 'code'), await profileCoverKey(key, 'en', active, 'changed')]).size).toBe(5);
  });
});
