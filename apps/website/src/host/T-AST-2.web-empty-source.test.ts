import { expect, it, vi } from 'vitest';
import { createBrowserHost } from './browser-host';

vi.mock('virtual:allay-website-mc', () => ({ default: { gameVersion: '26.3', files: [] } }));
vi.mock('virtual:allay-builtin-templates', () => ({ default: [] }));

it('T-AST-2 网页空索引不能当原版或演示包：目录内外均报告缺图，查询不联网', async () => {
  const text = { en: 'test', 'zh-CN': '测试' };
  const fetch = vi.fn(() => { throw new Error('unexpected network request'); });
  vi.stubGlobal('fetch', fetch);
  try {
    const { api } = createBrowserHost({ settings: { language: 'en' }, messages: { mcPackName: text, mcPackDescription: text, exportTarget: text } });
    const state = await api.resources.layers();
    expect(state).toMatchObject({ hasAssets: false, vanilla: { active: null, consent: false } });
    expect(state.layers.map(layer => [layer.kind, layer.empty])).toEqual([['builtin', true]]);
    for (const id of ['minecraft:block/stone', 'minecraft:item/nonexistent']) expect(await api.resources.readTexture(id)).toBeNull();
    expect(await api.resources.fontProviders('minecraft:default')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});
