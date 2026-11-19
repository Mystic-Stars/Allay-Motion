import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { missingVanillaSoundNames, type ResourceLayer } from '../../packages/assets/src/index';
import { buildSoundCatalog, findSoundFile, missingSoundNameObjects } from '../../apps/desktop/src/main/resources/sound-catalog';
import { SoundImports } from '../../apps/desktop/src/main/resources/sound-imports';
import { cueWindow, voiceParams } from '../../apps/desktop/src/renderer/audio/schedule';
import { encodeWav } from '../../apps/desktop/src/renderer/audio/wav';

function layer(kind: ResourceLayer['kind'], files: Record<string, string>): ResourceLayer {
  return {
    id: kind, name: kind, kind, revision: '1', enabled: true, warnings: [],
    has: (path) => Object.hasOwn(files, path),
    list: (prefix) => Object.keys(files).filter((path) => path.startsWith(prefix)),
    read: async (path) => Object.hasOwn(files, path) ? new TextEncoder().encode(files[path]) : null,
  };
}

describe('T-AST 音频库', () => {
  it('识别原版、定义覆盖、同名文件覆盖、资源包新增和音乐事件/文件；保留多变体', async () => {
    const vanilla = layer('vanilla', {
      'assets/minecraft/sounds.json': JSON.stringify({
        'block.stone.place': { sounds: ['blocks/place'] },
        'block.stone.break': { sounds: ['blocks/break'] },
        'ui.button.click': { sounds: ['ui/click'] },
        'music.menu': { sounds: ['music/menu'] },
      }),
      'assets/minecraft/sounds/blocks/place.ogg': '', 'assets/minecraft/sounds/blocks/break.ogg': '',
      'assets/minecraft/sounds/ui/click.ogg': '', 'assets/minecraft/sounds/music/menu.ogg': '',
    });
    const pack = layer('pack', {
      'assets/minecraft/sounds.json': JSON.stringify({ 'block.stone.place': { replace: true, sounds: ['blocks/a', { name: 'blocks/b', weight: 3 }] } }),
      'assets/test/sounds.json': JSON.stringify({ linked: { sounds: [{ name: 'minecraft:music.menu', type: 'event' }] }, new: { sounds: ['ding'] } }),
      'assets/minecraft/sounds/blocks/a.ogg': '', 'assets/minecraft/sounds/blocks/b.ogg': '',
      'assets/minecraft/sounds/blocks/break.wav': '', 'assets/test/sounds/music/solo.ogg': '', 'assets/test/sounds/ding.ogg': '',
    });
    const stack = [vanilla, pack];
    const catalog = await buildSoundCatalog(stack);
    const items = await catalog.items(async (file) => findSoundFile(stack, file) ? 'local' : 'missing');
    const byId = Object.fromEntries(items.map((item) => [item.id, item]));
    expect(byId['minecraft:ui.button.click']).toMatchObject({ source: 'vanilla', kind: 'effect' });
    expect(byId['minecraft:block.stone.place']).toMatchObject({ source: 'definition-override', variantCount: 2 });
    expect(byId['minecraft:block.stone.break']).toMatchObject({ source: 'file-override', fileOverride: true });
    expect(findSoundFile(stack, 'minecraft:blocks/break')?.path).toMatch(/\.wav$/);
    expect(byId['test:new']).toMatchObject({ source: 'pack-new', names: { chinese: 'custom' } });
    expect(byId['test:linked']).toMatchObject({ kind: 'music', variantCount: 1 });
    expect(byId['sound-file:test/music/solo']).toMatchObject({ kind: 'music', variantCount: 1 });
    expect(byId['sound-file:minecraft/music/menu']).toBeUndefined();
    expect(catalog.variants('minecraft:block.stone.place')?.map(({ file, weight }) => [file, weight])).toEqual([['minecraft:blocks/a', 1], ['minecraft:blocks/b', 3]]);
  });

  it('对整个已知夹具检查正式字幕和术语兜底，不给陌生命名空间伪造名称', async () => {
    const vanilla = layer('vanilla', {
      'assets/minecraft/sounds.json': JSON.stringify({ 'entity.breeze.hurt': { subtitle: 'subtitles.entity.breeze.hurt', sounds: ['hurt'] }, 'music.overworld.cherry_grove': { sounds: ['music/a'] } }),
      'assets/minecraft/lang/zh_cn.json': JSON.stringify({ 'subtitles.entity.breeze.hurt': '旋风人受伤' }),
      'assets/minecraft/lang/en_us.json': JSON.stringify({ 'subtitles.entity.breeze.hurt': 'Breeze hurts' }),
    });
    const pack = layer('pack', { 'assets/test/sounds.json': JSON.stringify({ 'entity.breeze.hurt': { sounds: ['hurt'] } }) });
    const catalog = await buildSoundCatalog([vanilla, pack]);
    const items = await catalog.items(async () => 'local');
    expect(missingVanillaSoundNames(items)).toEqual([]);
    expect(items.find(({ id }) => id === 'minecraft:entity.breeze.hurt')?.names).toEqual({ 'zh-CN': '旋风人受伤', en: 'Breeze hurts', chinese: 'subtitle' });
    expect(items.find(({ id }) => id === 'minecraft:music.overworld.cherry_grove')?.names).toEqual({ 'zh-CN': '樱花树林背景音乐', chinese: 'terminology' });
    expect(items.find(({ id }) => id === 'test:entity.breeze.hurt')?.names).toEqual({ chinese: 'custom' });
    const untranslated = await buildSoundCatalog([layer('vanilla', { 'assets/minecraft/sounds.json': '{"unknown.event":{"sounds":["test"]}}' })]);
    expect(missingVanillaSoundNames(await untranslated.items(async () => 'local'))).toEqual(['minecraft:unknown.event']);
  });

  it('用不透明 ID 持久化；原文件删掉后仍能读，不能用路径代替 ID', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sound-library-'));
    try {
      const input = join(root, '个人音乐.wav');
      const bytes = encodeWav([new Float32Array([0, 0.5, 0])], 48_000);
      await writeFile(input, bytes);
      const item = await new SoundImports(root).add(input, 'music');
      await rm(input);
      const restarted = new SoundImports(root);
      expect(await restarted.list()).toEqual([item]);
      expect(await restarted.variants(item.id)).toEqual([{ file: item.id, kind: 'music', pitch: 1, volume: 1, weight: 1 }]);
      expect(await restarted.read(item.id)).toEqual(bytes);
      expect(await restarted.read(input)).toBeNull();
      expect(await restarted.read('user-audio:../../secret')).toBeNull();
      const manifest = await readFile(join(root, 'sound-library', `${item.id.slice(11)}.json`), 'utf8');
      expect(manifest).not.toContain(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('补齐中文名时只检查原版的两个固定索引对象', async () => {
    const checked: string[] = [];
    const vanilla = {
      ...layer('vanilla', {}),
      remoteObject: async (path: string) => {
        checked.push(path);
        return path.endsWith('zh_cn.json') ? { hash: 'a'.repeat(40), size: 100 } : null;
      },
    };
    expect(await missingSoundNameObjects([vanilla])).toEqual([{ hash: 'a'.repeat(40), size: 100 }]);
    expect(checked).toEqual(['assets/minecraft/sounds.json', 'assets/minecraft/lang/zh_cn.json']);
    expect(await missingSoundNameObjects([{ ...vanilla, enabled: false }])).toEqual([]);
  });

  it('T-EXP-4 续播和裁切以同一音频窗口为准，音乐忽略方块空间参数', () => {
    const cue = { sound: 'test:voice', at: 1, gain: 0.4, rate: 2, pan: 0, variant: { file: 'test:voice', pitch: 1, volume: 1 }, spatial: { pan: -0.8, gain: 0.5 } };
    expect(voiceParams(cue)).toEqual({ gain: 0.2, pan: -0.8, rate: 2 });
    expect(voiceParams({ ...cue, variant: { ...cue.variant, kind: 'music' } })).toEqual({ gain: 0.4, pan: 0, rate: 2 });
    expect(cueWindow(cue, 3, 2, 1.5, 2)).toEqual({ start: 1.5, offset: 1, end: 2 });
    expect(cueWindow({ ...cue, clip: { offset: 0.25, end: 1.75 } }, 3, 2, 1.5, 2)).toEqual({ start: 1.5, offset: 1.5, end: 1.75 });
    expect(cueWindow(cue, 0.5, 2, 1.5)).toBeNull();
  });
});
