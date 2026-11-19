import { expect, it, vi } from 'vitest';
import { EngineResources, textureInfo } from '../../packages/engine/src/resources';
import { catalogPlaceholder } from '../../packages/engine/src/catalog-placeholder';

it('T-AST-2 目录占位不是真实查询命中；必需读取有提示、可回收，下一个资源代优先使用真实纹理', async () => {
  const raw = { kind: 'rgba' as const, width: 1, height: 1, data: Uint8Array.of(13, 45, 71, 255) };
  const resolve = vi.fn<ConstructorParameters<typeof EngineResources>[0]>().mockResolvedValue(null);
  const resources = new EngineResources(resolve, vi.fn());
  const warn = vi.fn();
  const id = 'minecraft:block/snow';
  expect(resolve).not.toHaveBeenCalled();
  try {
    expect(await resources.optionalTexture(id)).toBeNull();
    const placeholder = await resources.texture(id, warn);
    expect(textureInfo(placeholder)).toMatchObject({ id, missing: true });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(id), 'catalog-placeholder');
    expect(await resources.optionalTexture(id)).toBeNull();
    const released = vi.fn();
    placeholder.addEventListener('dispose', released);
    resources.setStamp('selected-pack');
    expect(released).toHaveBeenCalledTimes(1);
    warn.mockClear(); resolve.mockResolvedValue(raw);
    const tex = await resources.texture(id, warn);
    expect(textureInfo(tex)).toMatchObject({ id, pixels: raw.data, missing: false });
    expect(await resources.optionalTexture(id)).toBe(tex);
    expect(warn).not.toHaveBeenCalled();
  } finally { resources.dispose(); }
});

it('T-AST-3 未知资源不伪造，方块、物品和界面占位按目录提供不同空间图案', () => {
  expect(catalogPlaceholder('minecraft:item/unknown_item')).toBeNull();
  expect(catalogPlaceholder('other:block/snow')).toBeNull();
  const block = catalogPlaceholder('minecraft:block/oak_planks')!;
  const item = catalogPlaceholder('minecraft:item/diamond_sword')!;
  expect(block.pixels).not.toEqual(item.pixels);
  expect(new Set(block.pixels.filter((_, offset) => offset % 4 === 0)).size).toBe(2);
  expect(new Set(item.pixels.filter((_, offset) => offset % 4 === 3))).toEqual(new Set([0, 255]));
  expect(catalogPlaceholder('minecraft:gui/sprites/toast/advancement')).toMatchObject({ width: 160, height: 32 });
});
