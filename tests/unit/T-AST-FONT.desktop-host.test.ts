import { afterEach, expect, it, vi } from 'vitest';
import { createResolver } from '../../apps/desktop/src/renderer/engine-host/resource-client';
import { IPC } from '../../apps/desktop/src/shared/ipc-channels';

afterEach(() => vi.unstubAllGlobals());

it('T-AST-FONT：独立字体没有导入、回读或内置回退通道', () => {
  expect(IPC.fonts).toEqual({ list: 'fonts:list' });
  expect(IPC.resources).not.toHaveProperty('fallbackFont');
});

it('T-AST-FONT：旧引用共用当前配置的默认字体缓存；切换配置后重新解析包内 TTF', async () => {
  const fontProviders = vi.fn(async (_id: string, profile: string) => ({ providers: [{
    type: 'ttf', file: `assets/example/font/${profile}.ttf`, size: 12, oversample: 1, shift: [0, 0], skip: '',
  }], skipped: [] }));
  const read = vi.fn(async () => new Uint8Array(16));
  vi.stubGlobal('window', { allay: { resources: { fontProviders, read } } });
  for (const profile of ['profile-a', 'profile-b']) {
    const resolve = createResolver(null, profile);
    for (const id of ['allay:fallback', `user-font:${'0'.repeat(64)}`, 'minecraft:default']) {
      expect(await resolve('font', id)).toMatchObject({ kind: 'font', providers: [{ type: 'ttf', bytes: new Uint8Array(16) }] });
    }
    expect(read).toHaveBeenCalledWith(`assets/example/font/${profile}.ttf`, profile);
  }
  expect(fontProviders.mock.calls).toEqual([['minecraft:default', 'profile-a'], ['minecraft:default', 'profile-b']]);
});
