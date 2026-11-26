// M6b 音频（docs/05-export.md 5.5、02-engine.md 2.10）：预览播放的调度、静音、循环、试听、sound 参数、缺失音效的提示，
// 以及 T-EXP-4 的端到端部分。窗口不显示、不抢焦点，并且整个页面静音（主进程在测试窗口上 setAudioMuted），不发出声音。
// 音效来自测试里现场生成的文件夹资源包：sounds.json 加正弦波 WAV（测试数据，不是产品素材，也不是游戏文件）。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { encodeWav } from '../../apps/desktop/src/renderer/audio/wav';
import { solidPng, tex } from '../unit/helpers/resource-fixtures';
import { startFakeMojang } from './fake-mojang';
import { launchApp, makeUserDataDir, removeUserDataDir, requirePinnedFfmpeg, ROOT, renderBoundTimeout } from './helpers';

type Locale = { audio: { missing: string }; editor: { sound: { categories: Record<string, string> } } };
const locale = (name: string): Locale => JSON.parse(readFileSync(join(ROOT, 'apps/desktop/src/renderer/i18n/locales', name), 'utf8')) as Locale;
const en = locale('en.json');
const zhCN = locale('zh-CN.json');

function sine(freq: number, seconds: number): Uint8Array {
  const n = Math.round(seconds * 48_000);
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = 0.3 * Math.sin((2 * Math.PI * freq * i) / 48_000);
  return encodeWav([data, data], 48_000);
}

/** 文件夹资源包：放置（两个变体）、破坏、提示框滑入三个事件；其余事件没有 */
function writeSoundPack(root: string): void {
  const files: Record<string, Uint8Array | string> = {
    'pack.mcmeta': JSON.stringify({ pack: { pack_format: 34, description: 'test sounds' } }),
    'assets/minecraft/sounds.json': JSON.stringify({
      'block.stone.place': { sounds: ['test/place1', 'test/place2'] },
      'block.stone.break': { sounds: [{ name: 'test/break', volume: 0.8 }] },
      'ui.toast.in': { sounds: ['test/toast'] },
    }),
    'assets/minecraft/sounds/test/place1.wav': sine(440, 0.2),
    'assets/minecraft/sounds/test/place2.wav': sine(550, 0.2),
    'assets/minecraft/sounds/test/break.wav': sine(330, 0.3),
    'assets/minecraft/sounds/test/toast.wav': sine(880, 0.4),
  };
  for (const [rel, data] of Object.entries(files)) {
    const file = join(root, rel);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, data);
  }
}

/** 数据目录；withPack 时预先在 settings.json 里登记一个文件夹资源包 */
function setup(withPack: boolean): string {
  const dir = makeUserDataDir();
  if (withPack) {
    const pack = join(dir, 'sound-pack');
    writeSoundPack(pack);
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ formatVersion: 1, resources: { vanilla: { consent: false, enabled: true, dir: null }, packs: [{ id: 'folder:6b6b6b6b-0000-4000-8000-000000000001', name: 'sounds', source: { kind: 'folder', path: pack }, enabled: true }] } }),
    );
  }
  return dir;
}

async function waitReady(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => window.__allayTest!.status().kind), { timeout: 15_000 }).toBe('ready');
  await expect.poll(() => page.evaluate(() => window.__allayTest!.previewUpToDate()), { timeout: 15_000 }).toBe(true);
}

const audio = (page: Page) => page.evaluate(() => window.__allayTest!.audioState());
const cues = (page: Page) => page.evaluate(() => window.__allayTest!.audioCues());

async function messages(page: Page) {
  const lang = await page.evaluate(() => document.documentElement.lang);
  return lang.startsWith('zh') ? zhCN : en;
}

test.describe('M6b 预览的声音', () => {
  test('M6b 播放：开始时调度 at ≥ t 的全部 cue（变体来自资源包），暂停立刻停，静音时不调度，取消静音接着排', async () => {
    const dir = setup(true);
    const { app, page } = await launchApp(dir);
    try {
      await waitReady(page);
      const all = await cues(page);
      expect(all.length).toBeGreaterThan(2);
      for (const c of all) {
        expect(['minecraft:block.stone.place', 'minecraft:block.stone.break']).toContain(c.sound);
        expect(c.variant?.file).toMatch(/^minecraft:test\/(place1|place2|break)$/);
      }
      // 同一事件的多个 cue 选到了不同的变体（引擎按 random(sound:事件:序号) 选）
      expect(new Set(all.filter((c) => c.sound === 'minecraft:block.stone.place').map((c) => c.variant?.file)).size).toBe(2);

      await page.evaluate(() => window.__allayTest!.setTime(0));
      await page.getByTestId('transport-play').click();
      await expect.poll(async () => (await audio(page)).scheduled).toBeGreaterThan(0);
      const s = await audio(page);
      // 从开始调度时时间轴所在的时刻排：at ≥ from 的 cue 全部排上（机器忙时 from 会比按下播放晚一点，不假设具体值）
      expect(s.from!).toBeGreaterThanOrEqual(0);
      expect(s.scheduled).toBe(all.filter((c) => c.at >= s.from!).length);
      expect(s.sampleRate).toBe(48_000);
      expect(s.missing).toEqual([]);

      await page.getByTestId('transport-play').click();
      await expect.poll(async () => (await audio(page)).scheduled).toBe(0);

      // 静音：播放时不调度
      await page.getByTestId('transport-mute').click();
      await page.evaluate(() => window.__allayTest!.setTime(0));
      await page.getByTestId('transport-play').click();
      await expect.poll(() => page.evaluate(() => window.__allayTest!.transport().playing)).toBe(true);
      await page.waitForTimeout(150);
      expect((await audio(page)).scheduled).toBe(0);
      // 播放中取消静音：从当前时刻接着排（只排还没到的 cue）
      await page.getByTestId('transport-mute').click();
      await expect.poll(async () => (await audio(page)).scheduled).toBeGreaterThan(0);
      const from = (await audio(page)).from!;
      expect((await audio(page)).scheduled).toBe(all.filter((c) => c.at >= from).length);
      await page.getByTestId('transport-play').click();
    } finally {
      await app.close();
      removeUserDataDir(dir);
    }
  });

  test('M6b 循环：回到开头时停掉上一轮的声音、从 0 重新排（不叠音、不拖到下一轮）', async () => {
    const dir = setup(true);
    const { app, page } = await launchApp(dir);
    try {
      await waitReady(page);
      const { duration } = await page.evaluate(() => window.__allayTest!.transport());
      expect(await page.evaluate(() => window.__allayTest!.transport())).toMatchObject({ playing: false });
      await page.evaluate((t) => window.__allayTest!.setTime(t), duration - 0.15);
      await page.getByTestId('transport-play').click();
      // 先排了结尾附近剩下的 cue（可能为 0 个），回到开头后整轮重新排
      await expect.poll(async () => (await audio(page)).from ?? 99, { timeout: 10_000 }).toBeLessThan(0.5);
      const all = await cues(page);
      const s = await audio(page);
      expect(s.scheduled).toBe(all.filter((c) => c.at >= s.from!).length);
      await page.getByTestId('transport-play').click();
      await expect.poll(async () => (await audio(page)).scheduled).toBe(0);
    } finally {
      await app.close();
      removeUserDataDir(dir);
    }
  });

  test('M6b 试听：按钮放选中的事件，多个变体每点一次换下一个；sound 参数改了 cue 立刻跟着变', async () => {
    const dir = setup(true);
    const { app, page } = await launchApp(dir);
    try {
      await waitReady(page);
      await page.getByTestId('param-group-sound').click();
      const button = page.getByTestId('param-placeSound-preview');
      await expect(button).toBeEnabled();
      await button.click();
      await expect.poll(async () => (await audio(page)).lastAudition).toEqual({ sound: 'minecraft:block.stone.place', file: 'minecraft:test/place1' });
      await button.click();
      await expect.poll(async () => (await audio(page)).lastAudition).toEqual({ sound: 'minecraft:block.stone.place', file: 'minecraft:test/place2' });

      await page.evaluate(() => window.__allayTest!.setParams({ placeSound: 'minecraft:ui.toast.in' }));
      await expect
        .poll(async () => (await cues(page)).filter((c) => c.sound === 'minecraft:ui.toast.in').map((c) => c.variant?.file))
        .toEqual(expect.arrayContaining(['minecraft:test/toast']));
      expect((await cues(page)).some((c) => c.sound === 'minecraft:block.stone.place')).toBe(false);
      await page.evaluate(() => window.__allayTest!.setParams({ placeSound: null }));
      await expect.poll(async () => (await cues(page)).every((c) => c.sound === 'minecraft:block.stone.break')).toBe(true);
    } finally {
      await app.close();
      removeUserDataDir(dir);
    }
  });

  test('M6b 缺失的音效：播放时静音并给一条提示，不报错；试听缺失的事件同样只提示', async () => {
    const dir = setup(false);
    const { app, page } = await launchApp(dir);
    try {
      await waitReady(page);
      // 没有原版层也没有资源包：cue 照常声明，变体为 null
      const all = await cues(page);
      expect(all.length).toBeGreaterThan(0);
      for (const c of all) expect(c.variant).toBeNull();
      await page.evaluate(() => window.__allayTest!.setTime(0));
      await page.getByTestId('transport-play').click();
      await expect.poll(async () => (await audio(page)).missing.sort()).toEqual(['minecraft:block.stone.break', 'minecraft:block.stone.place']);
      const notice = page.getByTestId('notice');
      const m = await messages(page);
      await expect(notice).toContainText(m.audio.missing.split('{{')[0]!);
      await expect(notice).toHaveAttribute('data-kind', 'info');
      expect((await audio(page)).scheduled).toBe(0);
      expect(await page.evaluate(() => window.__allayTest!.status().kind)).toBe('ready');
      await page.getByTestId('transport-play').click();

      // 没有素材层：选择器的库是空的，显示引导（没有任何自制或合成音效可选）
      await page.getByTestId('param-group-sound').click();
      await page.getByTestId('param-placeSound-trigger').click();
      await expect(page.getByTestId('sound-library-empty')).toBeVisible();
      await expect(page.getByTestId('sound-list').locator('[data-testid^="sound-minecraft:"]')).toHaveCount(0);
      await page.keyboard.press('Escape');

      await page.evaluate(() => window.__allayTest!.auditionSound('minecraft:entity.player.levelup'));
      expect((await audio(page)).lastAudition).toEqual({ sound: 'minecraft:entity.player.levelup', file: null });
    } finally {
      await app.close();
      removeUserDataDir(dir);
    }
  });

  test('M6b 离线混音在应用里：同一工程混两次逐字节相同，长度与视频相等', async () => {
    const dir = setup(true);
    const { app, page } = await launchApp(dir);
    try {
      await waitReady(page);
      const r = await page.evaluate(() => window.__allayTest!.mixTwice(67, 60));
      expect(r.hashes[0]).not.toBeNull();
      expect(r.hashes[1]).toBe(r.hashes[0]);
      expect(r.bytes).toBe(44 + Math.round((67 / 60) * 48_000) * 4);
      expect(r.missing).toEqual([]);
    } finally {
      await app.close();
      removeUserDataDir(dir);
    }
  });
});

/** 文件里所有流的类型、编码、采样率、声道、时长 */
function streams(path: string): Record<string, string | number>[] {
  const ffprobe = join(ROOT, 'resources', 'ffmpeg', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  const r = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,sample_rate,channels,duration', '-of', 'json', path], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`ffprobe failed: ${r.stderr}`);
  return (JSON.parse(r.stdout) as { streams: Record<string, string | number>[] }).streams;
}

test.describe('T-EXP-4 端到端', () => {
  for (const withPack of [true, false]) {
    test(`T-EXP-4 T1 默认参数导出 ProRes 4444，${withPack ? '有 cue 且有音效：有 48 kHz 立体声音轨，时长与视频相差不到 1 帧' : '音效全部缺失：没有音轨'}`, async () => {
      const dir = setup(withPack);
      const out = join(dir, 'exports');
      mkdirSync(out);
      const { app, page } = await launchApp(dir, { ALLAY_E2E_EXPORT_TARGET: out, ALLAY_FFMPEG: requirePinnedFfmpeg() });
      try {
        await waitReady(page);
        await page.getByTestId('topbar-export').click();
        await expect(page.getByTestId('export-dialog')).toBeVisible();
        await page.getByTestId('export-quality-draft').click();
        await page.getByTestId('export-start').click();
        await expect(page.getByTestId('export-result')).toHaveAttribute('data-kind', 'done', { timeout: await renderBoundTimeout(page, 60_000) });
        const path = (await page.getByTestId('export-path').textContent())!;
        expect(readdirSync(out)).toHaveLength(1);
        const s = streams(path);
        const video = s.find((x) => x.codec_type === 'video')!;
        const audioStreams = s.filter((x) => x.codec_type === 'audio');
        if (withPack) {
          expect(audioStreams).toHaveLength(1);
          expect(audioStreams[0]).toMatchObject({ codec_name: 'pcm_s16le', sample_rate: '48000', channels: 2 });
          expect(Math.abs(Number(audioStreams[0]!.duration) - Number(video.duration))).toBeLessThan(1 / 60);
        } else {
          expect(audioStreams).toEqual([]);
        }
      } finally {
        await app.close();
        removeUserDataDir(dir);
      }
    });
  }
});

test.describe('M6b 音效库', () => {
  test('M6b 选择器：库是资源包 sounds.json 里的全部事件，常用置顶、按分类分组、可搜索；选中后参数和 cue 跟着变', async () => {
    const dir = setup(true);
    const { app, page } = await launchApp(dir);
    try {
      await waitReady(page);
      await page.getByTestId('param-group-sound').click();
      await page.getByTestId('param-placeSound-trigger').click();
      const list = page.getByTestId('sound-list');
      await expect(list.getByTestId('sound-minecraft:ui.toast.in').first()).toBeVisible();
      // 常用（3.8 的事件、库里有的）在最前面，其后是分组
      const labels = await list.locator('div.h-6').allTextContents();
      expect(labels[0]).toBe((await messages(page)) === zhCN ? '常用' : 'Common');
      // 2026-11 反馈：分组改按分类（方块、界面……），不再是“命名空间 · 类别”
      const cats = (await messages(page)).editor.sound.categories;
      expect(labels).toEqual(expect.arrayContaining([cats.block, cats.ui]));
      await page.getByTestId('sound-search').fill('toast');
      // 常用里一行、分组里一行
      await expect(list.locator('[data-testid^="sound-minecraft:"]')).toHaveCount(2);
      await list.getByTestId('sound-minecraft:ui.toast.in').first().click();
      await expect.poll(() => page.evaluate(() => window.__allayTest!.project().params.placeSound)).toBe('minecraft:ui.toast.in');
      await expect.poll(async () => (await cues(page)).some((c) => c.sound === 'minecraft:ui.toast.in' && c.variant?.file === 'minecraft:test/toast')).toBe(true);
    } finally {
      await app.close();
      removeUserDataDir(dir);
    }
  });

  test('M6b 下载缓存的原版层：下载时只取常用事件的音效；选中别的音效时才按需取回；导出设置页提示没取回的音效，可一键取回，导出中途不联网', async () => {
    const dir = setup(false);
    const out = join(dir, 'exports');
    mkdirSync(out);
    const sounds = {
      'block.stone.place': { sounds: ['test/place'] },
      'block.stone.break': { sounds: ['test/break'] },
      'block.anvil.land': { sounds: ['test/anvil'] },
      'block.bell.use': { sounds: ['test/bell'] },
    };
    const assets: Record<string, Buffer> = { 'minecraft/sounds.json': Buffer.from(JSON.stringify(sounds)) };
    // 正弦波 WAV 放在 .ogg 的键下（解码按内容识别格式）；测试数据，不是游戏文件
    const tones: [string, number][] = [
      ['place', 440],
      ['break', 330],
      ['anvil', 220],
      ['bell', 880],
    ];
    for (const [name, freq] of tones) assets[`minecraft/sounds/test/${name}.ogg`] = Buffer.from(sine(freq, 0.2));
    const server = await startFakeMojang('9.9.9', [{ name: tex('stone'), data: solidPng('#00ff00') }], assets);
    const objectPath = (key: string) => {
      const h = createHash('sha1').update(assets[key]!).digest('hex');
      return `/${h.slice(0, 2)}/${h}`;
    };
    const { app, page } = await launchApp(dir, { ALLAY_E2E_MOJANG_ORIGIN: server.origin, ALLAY_E2E_EXPORT_TARGET: out, ALLAY_FFMPEG: requirePinnedFfmpeg() });
    try {
      await waitReady(page);
      await page.getByTestId('vanilla-download').click();
      await expect.poll(() => page.evaluate(() => window.__allayTest!.resourceState()!.vanilla.active), { timeout: 20_000 }).toBe('cached');
      // 下载时：sounds.json 和常用事件（放置、破坏）的文件；铁砧、钟不取
      expect(server.requests).toEqual(expect.arrayContaining([objectPath('minecraft/sounds.json'), objectPath('minecraft/sounds/test/place.ogg'), objectPath('minecraft/sounds/test/break.ogg')]));
      expect(server.requests).not.toContain(objectPath('minecraft/sounds/test/anvil.ogg'));
      expect(server.requests).not.toContain(objectPath('minecraft/sounds/test/bell.ogg'));
      await waitReady(page);

      // 选择器里铁砧是 remote；选中它时才取回
      await page.getByTestId('param-group-sound').click();
      await page.getByTestId('param-placeSound-trigger').click();
      const anvil = page.getByTestId('sound-list').getByTestId('sound-minecraft:block.anvil.land');
      await expect(anvil).toHaveAttribute('data-state', 'remote');
      await expect(page.getByTestId('sound-list').getByTestId('sound-minecraft:block.stone.place').first()).toHaveAttribute('data-state', 'local');
      const before = server.requests.length;
      await anvil.click();
      await expect.poll(() => server.requests.slice(before)).toContain(objectPath('minecraft/sounds/test/anvil.ogg'));
      await expect.poll(() => page.evaluate(() => window.__allayTest!.project().params.placeSound)).toBe('minecraft:block.anvil.land');
      await page.getByTestId('param-placeSound-trigger').click();
      await expect(page.getByTestId('sound-list').getByTestId('sound-minecraft:block.anvil.land')).toHaveAttribute('data-state', 'local');
      await page.keyboard.press('Escape');

      // 工程里的音效（钟）没取回：导出前提示。先模拟离线：取不到，提示失败、留在这一步
      await page.evaluate(() => window.__allayTest!.setParams({ placeSound: 'minecraft:block.bell.use' }));
      await expect.poll(async () => (await cues(page)).some((c) => c.variant?.file === 'minecraft:test/bell')).toBe(true);
      await waitReady(page);
      // 经命令直接启动任务（MCP 等）：没取回的音效静音导出，不联网、不卡住
      const before2 = server.requests.length;
      const started = await page.evaluate(() => window.__allayTest!.dispatch('exportTask.start', { preset: 'prores4444', quality: 'draft' }));
      expect(started.ok).toBe(true);
      const taskId = (started as { ok: true; output: { taskId: string } }).output.taskId;
      await expect
        .poll(async () => ((await page.evaluate((id) => window.__allayTest!.dispatch('exportTask.get', { taskId: id }), taskId)) as { output: { status: string } }).output.status, { timeout: 60_000 })
        .toBe('done');
      expect(server.requests.slice(before2)).toEqual([]);
      const viaCommand = ((await page.evaluate((id) => window.__allayTest!.dispatch('exportTask.get', { taskId: id }), taskId)) as { output: { result: { path: string; audio: boolean } } }).output.result;
      // 破坏音效在本地，照常有音轨；钟静音
      expect(viaCommand.audio).toBe(true);
      expect(streams(viaCommand.path).filter((x) => x.codec_type === 'audio')).toHaveLength(1);

      server.objectMode = 'fail';
      await page.getByTestId('topbar-export').click();
      await page.getByTestId('export-quality-draft').click();
      // 设置页上提示有没取回的音效（导出前检查，M7 的设置页里）
      await expect(page.getByTestId('export-sounds-remote')).toHaveAttribute('data-count', '1');
      await page.getByTestId('export-sounds-fetch').click();
      await expect(page.getByTestId('export-sounds-failed')).toBeVisible();
      server.objectMode = 'ok';
      await page.getByTestId('export-sounds-fetch').click();
      await expect(page.getByTestId('export-sounds-remote')).toHaveCount(0);
      await page.getByTestId('export-start').click();
      await expect(page.getByTestId('export-result')).toHaveAttribute('data-kind', 'done', { timeout: await renderBoundTimeout(page, 60_000) });
      const path = (await page.getByTestId('export-path').textContent())!;
      expect(streams(path).filter((x) => x.codec_type === 'audio')).toHaveLength(1);
      // 同名的第二个文件加了 “ (2)”
      expect(path).toMatch(/ \(2\)\.mov$/);
      // 导出过程中没有再联网：钟的文件只在确认取回时请求过（失败一次、成功一次）
      expect(server.requests.filter((p) => p === objectPath('minecraft/sounds/test/bell.ogg'))).toHaveLength(2);
      expect(readdirSync(out)).toHaveLength(2);
      expect(server.identifyingHeaders).toEqual([]);
    } finally {
      await app.close();
      await server.close();
      removeUserDataDir(dir);
    }
  });
});
