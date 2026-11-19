import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SkinLibrary } from '../../apps/desktop/src/main/skins/library';
import { MAX_SKIN_BYTES } from '../../apps/desktop/src/main/skins/png';
import { SkinRefSchema } from '../../apps/desktop/src/shared/skins';
import { encodePng } from '../../scripts/mascot-bake/png';

let root: string;
let library: SkinLibrary;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'allay-skins-'));
  library = new SkinLibrary(root);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function fixture(width = 64, height = 64) {
  const data = new Uint8Array(width * height * 4);
  data.fill(255);
  data.set([31, 127, 248, 109]);
  return { data, png: encodePng({ width, height, data }) };
}

describe('T-SKIN-1 离线皮肤库', () => {
  it('PNG 由对话框取得后导入，原文件删除仍可重启读取；可独立选择及删除', async () => {
    const original = join(root, '我的创作.png');
    const { png, data } = fixture();
    await writeFile(original, png);
    const slim = await library.importFile(original, 'slim');
    const classic = await library.importFile(original, 'classic');
    expect(slim).toMatchObject({ name: '我的创作', model: 'slim', height: 64, source: 'local' });
    expect(SkinRefSchema.safeParse(slim.ref).success).toBe(true);
    expect(classic.ref).not.toBe(slim.ref);
    await rm(original);
    const restarted = new SkinLibrary(root);
    expect(await restarted.list()).toEqual(expect.arrayContaining([classic, slim]));
    expect(await restarted.read(slim.ref)).toEqual({ width: 64, height: 64, data });
    expect(await restarted.remove(slim.ref)).toBe(true);
    expect(await library.read(slim.ref)).toBeNull();
    expect(await library.list()).toEqual([classic]);
  });

  it('64×32 强制宽臂，旧的全不透明帽子区不会覆盖脸；有透明信息的帽子保留', async () => {
    const { data, png } = fixture(64, 32);
    const legacy = await library.add(png, '旧版', 'slim', 'local');
    expect(legacy).toMatchObject({ model: 'classic', height: 32 });
    expect((await library.read(legacy.ref))?.data[(8 * 64 + 40) * 4 + 3]).toBe(0);
    data[(8 * 64 + 41) * 4 + 3] = 0;
    const legacyHat = await library.add(encodePng({ width: 64, height: 32, data }), '有帽子', 'classic', 'local');
    expect((await library.read(legacyHat.ref))?.data).toEqual(data);
  });

  it('拒绝不合法尺寸、损坏和超大文件，未知引用与路径均无法读取', async () => {
    await expect(library.add(fixture(128, 128).png, 'large', 'classic', 'local')).rejects.toMatchObject({ code: 'invalid-png' });
    const { png } = fixture();
    png[32] = png[32]! ^ 0xff;
    await expect(library.add(png, 'damaged', 'classic', 'local')).rejects.toMatchObject({ code: 'invalid-png' });
    await expect(library.add(Buffer.alloc(MAX_SKIN_BYTES + 1), 'huge', 'slim', 'local')).rejects.toMatchObject({ code: 'too-large' });
    expect(await library.read('skins:../outside')).toBeNull();
    expect(await library.read('skins:39ed46af-e1e9-437c-8d55-347ab4c2ec3f')).toBeNull();
    expect(await readdir(join(root, 'skins'))).toEqual([]);
  });
});
