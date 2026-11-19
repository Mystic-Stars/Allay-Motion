export const ORIGINAL_BUILTIN_NAMES = [
  'advancement-toast',
  'block-fall',
  'block-wipe',
  'item-stinger',
  'loading-screen',
  'pixel-dissolve',
] as const;

export const builtinId = (name: string) => `allay.builtin.${name}`;
export const TEST_SKIN_REF = 'skins:39ed46af-e1e9-437c-8d55-347ab4c2ec3f';

export function testSkinRgba(): Uint8Array {
  const data = new Uint8Array(64 * 64 * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data.set([(offset / 4 % 64) * 4, Math.floor(offset / 256) * 4, 162, 255], offset);
  }
  return data;
}
