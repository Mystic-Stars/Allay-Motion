import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { decodeAllRgba, probe, processAlive } from '../export/ffmpeg';
import { frameCount } from '../../packages/engine/src/frames';
import { ROOT, SOFTWARE_TIMEOUT_FACTOR, launchApp, makeUserDataDir, readMainLog, removeUserDataDir, rendererOf, requirePinnedFfmpeg, type Launched, renderBoundTimeout } from './helpers';
import { isSoftwareRenderer } from '../engine/software';

// M7 导出完善的端到端测试（docs/05-export.md 5.10、docs/08-milestones.md M7）：
// - 六个内置模板各以 1080p60 标准画质导出一次并通过自动检查；
// - T-EXP-7 用其余三个预设经真实界面各导一次（ProRes 的那次在 m1.spec.ts）；
// - 导出任务的命令（启动、查询、取消）经 dispatch，对话框只是观察者；
// - H.264 编码器全部失败时预设禁用；T-EXP-8 自定义分辨率；失败时“复制诊断信息”；遮盖检查。
// 窗口不显示、不抢焦点；导出产物写在测试自己的临时目录里，用完即删。

type Snapshot = {
  id: string;
  status: string;
  written: number;
  total: number;
  progress: number;
  result: { jobId: string; path: string; frames: number; fps: number; duration: number; cutFrame: number | null; cutMinAlpha: number | null; encoder: string | null; seconds: number } | null;
  error: { code: string; detail: string; frame: number | null } | null;
};

type Locale = { export: Record<string, unknown> & { blockers: Record<string, string>; errors: Record<string, string> } };
const locale = (name: string): Locale => JSON.parse(readFileSync(join(ROOT, 'apps/desktop/src/renderer/i18n/locales', name), 'utf8')) as Locale;

async function waitReady(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => window.__allayTest!.previewUpToDate()), { timeout: 30_000 }).toBe(true);
}

async function messages(page: Page): Promise<Locale> {
  const lang = await page.evaluate(() => document.documentElement.lang);
  return locale(lang.startsWith('zh') ? 'zh-CN.json' : 'en.json');
}

/** 经测试钩子的 dispatch 执行命令：成功时返回命令的结果，失败时返回 { error: 错误码 } */
async function command<T>(page: Page, id: string, input?: unknown): Promise<T> {
  const r = await page.evaluate(({ id, input }) => window.__allayTest!.dispatch(id, input), { id, input });
  return (r.ok ? r.output : { error: r.code }) as T;
}

async function waitTask(page: Page, taskId: string, timeout = 60_000): Promise<Snapshot> {
  await expect
    .poll(async () => (await command<Snapshot | null>(page, 'exportTask.get', { taskId }))?.status, { timeout })
    .toMatch(/^(done|failed|canceled)$/);
  return (await command<Snapshot>(page, 'exportTask.get', { taskId }))!;
}

/** 每帧的最小、最大 alpha */
async function alphaStats(path: string, width: number, height: number, pre: string[] = []): Promise<{ min: number; max: number }[]> {
  const stats: { min: number; max: number }[] = [];
  await decodeAllRgba(
    path,
    width * height * 4,
    (frame) => {
      let min = 255;
      let max = 0;
      for (let i = 3; i < frame.length; i += 4) {
        const a = frame[i]!;
        if (a < min) min = a;
        if (a > max) max = a;
      }
      stats.push({ min, max });
    },
    pre,
  );
  return stats;
}

const TAGS = { color_space: 'bt709', color_transfer: 'bt709', color_primaries: 'bt709', color_range: 'tv' };

test.describe('六个内置模板：1080p60 标准画质导出', () => {
  let dir: string;
  let out: string;
  let launched: Launched;
  test.beforeAll(async () => {
    dir = makeUserDataDir();
    out = join(dir, 'exports');
    mkdirSync(out);
    launched = await launchApp(dir, { ALLAY_E2E_EXPORT_TARGET: out, ALLAY_FFMPEG: requirePinnedFfmpeg() });
  });
  test.afterAll(async () => {
    await launched.app.close();
    removeUserDataDir(dir);
  });

  for (const id of ['block-wipe', 'block-fall', 'item-stinger', 'loading-screen', 'pixel-dissolve', 'advancement-toast']) {
    test(`allay.builtin.${id}：时长、帧数、首末帧透明、剪辑点不透明、色彩标记`, async () => {
      const { page } = launched;
      // 软件渲染（CI 的 WARP）下同样的帧数慢得多：测试时限和等导出结束的时限按 docs/decisions.md M8 的做法乘 SOFTWARE_TIMEOUT_FACTOR，
      // 判定不变。进度提示按游戏还原以后（1191592）默认长 5.6 秒、337 帧，原来的 3 秒只有 181 帧，CI 上 90 秒不够
      const slow = isSoftwareRenderer(await rendererOf(page)) ? SOFTWARE_TIMEOUT_FACTOR : 1;
      test.setTimeout(120_000 * slow);
      const templates = (await page.evaluate(() => window.__allayTest!.templates())) as { id: string; version: string }[];
      const entry = templates.find((t) => t.id === `allay.builtin.${id}`)!;
      expect(entry, id).toBeTruthy();
      expect(await page.evaluate(({ id, version }) => window.__allayTest!.selectTemplate(id, version), entry)).toBe(true);
      await waitReady(page);

      const started = Date.now();
      const { taskId } = await command<{ taskId: string }>(page, 'exportTask.start', { preset: 'prores4444', quality: 'standard' });
      const task = await waitTask(page, taskId, 90_000 * slow);
      const seconds = (Date.now() - started) / 1000;
      expect(task.status, JSON.stringify(task.error)).toBe('done');
      const r = task.result!;
      const frames = frameCount(r.duration, 60);
      expect(r.frames).toBe(frames);
      expect(r.fps).toBe(60);

      const info = probe(r.path, 'stream=codec_name,width,height,color_range,color_space,color_transfer,color_primaries,r_frame_rate,nb_read_frames,duration:format_tags=comment');
      expect(info).toMatchObject({ codec_name: 'prores', width: '1920', height: '1080', r_frame_rate: '60/1', nb_read_frames: String(frames), ...TAGS });
      // 时长：帧数 / 60（首尾两帧都渲染，比 duration 长一帧，5.1）
      expect(Math.abs(Number(info.duration) - frames / 60)).toBeLessThan(0.001);
      expect(info['TAG:comment']).toBe(r.cutFrame === null ? undefined : `cut_frame=${r.cutFrame}`);

      const stats = await alphaStats(r.path, 1920, 1080);
      expect(stats).toHaveLength(frames);
      expect(stats[0]!.max, 'first frame').toBe(0);
      expect(stats[frames - 1]!.max, 'last frame').toBe(0);
      if (r.cutFrame !== null) {
        expect(stats[r.cutFrame]!.min, 'cut frame').toBe(255);
        expect(r.cutMinAlpha).toBe(255);
      } else {
        // 叠加层：中间确实有画面
        expect(Math.max(...stats.map((s) => s.max))).toBeGreaterThan(0);
      }
      test.info().annotations.push({ type: `${id} seconds`, description: `${seconds.toFixed(2)} (${frames} frames)` });
      // 产物用完即删（C 盘紧）
      rmSync(r.path, { force: true });
    });
  }
});

test.describe('导出对话框与任务', () => {
  test('T-EXP-7 其余三个预设经真实界面：PNG 序列、透明 WebM、绿幕 MP4', async () => {
    test.setTimeout(180_000);
    const dir = makeUserDataDir();
    const out = join(dir, 'exports');
    mkdirSync(out);
    const { app, page } = await launchApp(dir, { ALLAY_E2E_EXPORT_TARGET: out, ALLAY_FFMPEG: requirePinnedFfmpeg() });
    try {
      await waitReady(page);
      const cutFrame = Math.round(0.55 * 60);
      const gpu = await rendererOf(page);
      const software = isSoftwareRenderer(gpu);
      const timings: string[] = [];

      const exportVia = async (preset: string) => {
        await page.getByTestId('topbar-export').click();
        await expect(page.getByTestId('export-dialog')).toHaveAttribute('data-page', 'settings');
        const card = page.getByTestId(`export-preset-${preset}`);
        await expect(card).toHaveAttribute('data-state', 'ok', { timeout: 30_000 });
        await card.click();
        await expect(card.locator('input')).toBeChecked();
        const started = Date.now();
        await page.getByTestId('export-start').click();
        const result = page.getByTestId('export-result');
        // 测试时限在 launchApp 里已按软件渲染放宽；等这一次导出结束的时限同样放宽（判定不变，docs/decisions.md M8）
        await expect(result).toHaveAttribute('data-kind', 'done', { timeout: 60_000 * (software ? SOFTWARE_TIMEOUT_FACTOR : 1) });
        const seconds = (Date.now() - started) / 1000;
        timings.push(`${preset} ${seconds.toFixed(2)}`);
        // 预算：1080p60、标准画质 ≤ 20 秒（2.11）。软件渲染（CI 的 WARP）不是参考机器，只记数字、不判定（同 T-ARC-7，docs/decisions.md M8）
        if (!software) expect(seconds).toBeLessThanOrEqual(20);
        await expect(page.getByTestId('export-cutpoint')).toContainText(String(cutFrame));
        const path = (await page.getByTestId('export-path').textContent())!;
        await page.getByTestId('export-close').click();
        await expect(page.getByTestId('export-dialog')).toHaveCount(0);
        return path;
      };

      // ② PNG 序列：67 张，首末帧全透明，剪辑点不透明
      const seq = await exportVia('png-sequence');
      expect(seq).toMatch(/_1920x1080_60fps$/);
      const files = readdirSync(seq).sort();
      expect(files).toHaveLength(67);
      const one = async (f: string) => (await alphaStats(join(seq, f), 1920, 1080))[0]!;
      expect((await one(files[0]!)).max).toBe(0);
      expect((await one(files[66]!)).max).toBe(0);
      expect((await one(files[cutFrame]!)).min).toBe(255);

      // ③ 透明 WebM：回读要用 libvpx-vp9 解码器
      const webm = await exportVia('webm-vp9');
      expect(webm).toMatch(/_1920x1080_60fps\.webm$/);
      expect(probe(webm, 'stream=codec_name,color_range,color_space,color_transfer,color_primaries,r_frame_rate,nb_read_frames')).toMatchObject({ codec_name: 'vp9', r_frame_rate: '60/1', nb_read_frames: '67', ...TAGS });
      const ws = await alphaStats(webm, 1920, 1080, ['-c:v', 'libvpx-vp9']);
      expect(ws).toHaveLength(67);
      expect(ws[0]!.max).toBe(0);
      // VP9 的 alpha 是有损的（T-EXP-1 ③ 允许 alpha 误差 16）。末帧紧跟在有画面的帧后面，帧间预测留下几级残差
      // （M8 修了方块 alpha 的插值误差之后实测 2；之前恰好是 0），按 T-EXP-1 ③ 的容差判。首帧前面没有帧，仍要求 0
      expect(ws[66]!.max).toBeLessThanOrEqual(16);
      // 剪辑点实测 254
      expect(ws[cutFrame]!.min).toBeGreaterThanOrEqual(255 - 16);

      // ④ 绿幕 MP4：不透明，首末帧是纯底色
      const mp4 = await exportVia('greenscreen-mp4');
      expect(mp4).toMatch(/_1920x1080_60fps\.mp4$/);
      expect(probe(mp4, 'stream=codec_name,pix_fmt,color_range,color_space,color_transfer,color_primaries,r_frame_rate,nb_read_frames')).toMatchObject({ codec_name: 'h264', pix_fmt: 'yuv420p', r_frame_rate: '60/1', nb_read_frames: '67', ...TAGS });
      // 首末帧应是纯底色。有损编码：末帧紧跟在有运动的帧后面，残差会让个别像素偏几级（实测 nvenc 最多 8），
      // 所以按“平坦区域”判：99.9% 的像素误差 ≤ 4，且没有任何像素超过 16
      const firstLast: { i: number; over4: number; worst: number }[] = [];
      await decodeAllRgba(mp4, 1920 * 1080 * 4, (frame, i) => {
        if (i !== 0 && i !== 66) return;
        let worst = 0;
        let over4 = 0;
        for (let p = 0; p < frame.length; p += 4) {
          const e = Math.max(Math.abs(frame[p]! - 0), Math.abs(frame[p + 1]! - 255), Math.abs(frame[p + 2]! - 0));
          if (e > 4) over4++;
          if (e > worst) worst = e;
        }
        firstLast.push({ i, over4, worst });
      });
      // 数字先打出来再判定：判定不过时 CI 的日志里也看得到用的哪个编码器、误差多大
      const encoder = /h264 encoders probed .*"encoder":"([^"]+)"/.exec(readMainLog(dir))?.[1];
      const summary = `${gpu}; ${timings.join(', ')}; h264=${encoder}; key error ${firstLast.map((f) => `#${f.i} max ${f.worst}, >4: ${f.over4}`).join(' / ')}`;
      test.info().annotations.push({ type: 'T-EXP-7 seconds', description: summary });
      console.log(`[T-EXP-7] ${summary}`);
      expect(encoder).toBeTruthy();
      expect(firstLast.map((f) => f.i)).toEqual([0, 66]);
      for (const f of firstLast) {
        expect(f.over4 / (1920 * 1080), `frame ${f.i}`).toBeLessThan(0.001);
        expect(f.worst, `frame ${f.i}`).toBeLessThanOrEqual(16);
      }
      expect(readdirSync(out).filter((f) => f.includes('.partial'))).toEqual([]);
    } finally {
      await app.close();
      removeUserDataDir(dir);
    }
  });

  test('导出任务的命令：start / get / cancel 经 dispatch；对话框只是观察者；导出期间阻止休眠', async () => {
    test.setTimeout(120_000);
    const dir = makeUserDataDir();
    const out = join(dir, 'exports');
    mkdirSync(out);
    const { app, page } = await launchApp(dir, { ALLAY_E2E_EXPORT_TARGET: out, ALLAY_FFMPEG: requirePinnedFfmpeg() });
    try {
      await waitReady(page);
      // 畸形参数被 dispatch 拦下，不接受路径
      expect(await command(page, 'exportTask.start', { preset: 'gif' })).toEqual({ error: 'invalid-input' });
      expect(await command(page, 'exportTask.start', { path: 'C:\\Windows\\x.mov' })).toEqual({ error: 'invalid-input' });
      expect(await command(page, 'exportTask.get', { taskId: 'nope' })).toEqual({ error: 'invalid-input' });

      // 在第 5 帧停住，对话框关着时启动
      await page.evaluate(() => window.__allayTest!.pauseExportAfter(5));
      const { taskId } = await command<{ taskId: string }>(page, 'exportTask.start', { preset: 'webm-vp9', quality: 'draft', fileName: 'from-command' });
      await expect.poll(() => page.evaluate(() => window.__allayTest!.exportPausedAt()), { timeout: 30_000 }).toBe(5);
      const mid = await command<Snapshot>(page, 'exportTask.get', { taskId });
      expect(mid).toMatchObject({ id: taskId, status: 'rendering', written: 5, total: 67, result: null, error: null });
      // 一次只跑一个
      expect(await command(page, 'exportTask.start')).toEqual({ error: 'disabled' });
      // 状态栏显示导出中；打开对话框，接上这个任务的进度页
      await expect(page.getByTestId('statusbar')).toContainText(/导出中|Exporting/);
      await page.keyboard.press('Control+KeyE');
      await expect(page.getByTestId('export-dialog')).toHaveAttribute('data-page', 'progress');
      await expect(page.getByTestId('export-progress')).toContainText('5');
      await expect(page.getByTestId('export-percent')).toHaveText('7%');
      expect(readdirSync(out)).toEqual(['from-command.webm.partial']);
      const log = readMainLog(dir);
      expect(log).toMatch(/job started .*"sleepBlocked":true/);
      const pid = Number(/job started .*"pid":(\d+)/.exec(log)?.[1]);
      expect(processAlive(pid)).toBe(true);

      // 经命令取消：对话框跟着变成“已取消”，没有残留
      expect(await command(page, 'exportTask.cancel', { taskId })).toEqual({ status: 'canceled' });
      await expect(page.getByTestId('export-result')).toHaveAttribute('data-kind', 'canceled');
      await expect.poll(() => readdirSync(out)).toEqual([]);
      expect(processAlive(pid)).toBe(false);
      expect(await command(page, 'exportTask.cancel', { taskId })).toEqual({ status: 'canceled' });
      await page.evaluate(() => window.__allayTest!.pauseExportAfter(null));

      // 再导出一个：经对话框启动，查询能看到同一个任务完成
      await page.getByTestId('export-again').click();
      await expect(page.getByTestId('export-dialog')).toHaveAttribute('data-page', 'settings');
      await page.getByTestId('export-preset-prores4444').click();
      await page.getByTestId('export-quality-draft').click();
      await page.getByTestId('export-start').click();
      await expect(page.getByTestId('export-result')).toHaveAttribute('data-kind', 'done', { timeout: await renderBoundTimeout(page, 60_000) });
      expect(await command(page, 'exportTask.get', { taskId: '00000000-0000-4000-8000-000000000000' })).toBeNull();
      const path = (await page.getByTestId('export-path').textContent())!;
      expect(readdirSync(out)).toEqual([path.split(/[\\/]/).at(-1)]);
      await expect(page.getByTestId('statusbar')).not.toContainText(/导出中|Exporting/);
    } finally {
      await app.close();
      removeUserDataDir(dir);
    }
  });

  test('H.264 编码器全部失败：绿幕 MP4 禁用并说明原因；设置里“重新检测”可用；结果缓存在设置里', async () => {
    const dir = makeUserDataDir();
    // h264_vaapi 在 Windows 上一定打不开；allay_bogus 不在 -encoders 里
    const { app, page } = await launchApp(dir, { ALLAY_E2E_EXPORT_TARGET: join(dir, 'exports'), ALLAY_FFMPEG: requirePinnedFfmpeg(), ALLAY_E2E_H264: 'allay_bogus,h264_vaapi' });
    try {
      const msg = await messages(page);
      await waitReady(page);
      await page.getByTestId('topbar-export').click();
      const card = page.getByTestId('export-preset-greenscreen-mp4');
      await expect(card).toHaveAttribute('data-state', 'no-h264', { timeout: 30_000 });
      await expect(card.locator('input')).toBeDisabled();
      await expect(page.getByTestId('export-preset-greenscreen-mp4-reason')).toHaveText(msg.export.blockers.noH264!);
      // 其他预设不受影响
      await expect(page.getByTestId('export-preset-webm-vp9')).toHaveAttribute('data-state', 'ok');
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('export-dialog')).toHaveCount(0);

      // 顶栏的格式下拉：四个都列出，绿幕置灰并说明
      await page.getByTestId('topbar-export-format').click();
      for (const p of ['prores4444', 'png-sequence', 'webm-vp9']) await expect(page.getByTestId(`topbar-export-${p}`)).toHaveAttribute('data-state', 'ok');
      const item = page.getByTestId('topbar-export-greenscreen-mp4');
      await expect(item).toHaveAttribute('data-state', 'no-h264');
      await expect(item).toHaveAttribute('data-disabled', '');
      await expect(item).toContainText(msg.export.blockers.noH264!);
      await page.keyboard.press('Escape');

      // 结果连同 FFmpeg 版本缓存在设置里
      const settingsFile = join(dir, 'settings.json');
      await expect.poll(() => (JSON.parse(readFileSync(settingsFile, 'utf8')) as { export?: { h264?: { encoder: unknown; ffmpegVersion: string } } }).export?.h264?.ffmpegVersion ?? '').toMatch(/^ffmpeg version n9/);
      const cached = (JSON.parse(readFileSync(settingsFile, 'utf8')) as { export: { h264: { encoder: unknown; attempts: { encoder: string; result: string }[] } } }).export.h264;
      expect(cached.encoder).toBeNull();
      expect(cached.attempts.map((a) => [a.encoder, a.result])).toEqual([
        ['allay_bogus', 'unlisted'],
        ['h264_vaapi', 'failed'],
      ]);
      const probesBefore = (readMainLog(dir).match(/h264 encoders probed/g) ?? []).length;
      expect(probesBefore).toBe(1);

      // 设置 → 导出：“重新检测”真的重新试编码
      await page.evaluate(() => window.__allayTest!.dispatch('settings', { page: 'export' }));
      await expect(page.getByTestId('h264-encoder')).toHaveText(/没有可用的|None works/);
      await page.getByTestId('redetect-encoders').click();
      await expect.poll(() => (readMainLog(dir).match(/h264 encoders probed/g) ?? []).length).toBe(2);
      await expect(page.getByTestId('redetect-encoders')).toBeEnabled();
    } finally {
      await app.close();
      removeUserDataDir(dir);
    }
  });

  test('T-EXP-8（界面）自定义分辨率 1001×563 被修正为 1000×562，绿幕 MP4 导出成功；文件名可改', async () => {
    test.setTimeout(120_000);
    const dir = makeUserDataDir();
    const out = join(dir, 'exports');
    mkdirSync(out);
    const { app, page } = await launchApp(dir, { ALLAY_E2E_EXPORT_TARGET: out, ALLAY_FFMPEG: requirePinnedFfmpeg() });
    try {
      await waitReady(page);
      await page.getByTestId('topbar-export').click();
      await page.getByTestId('export-resolution').click();
      await page.getByRole('option', { name: /自定义|Custom/ }).click();
      await page.getByTestId('export-width').fill('1001');
      await page.getByTestId('export-height').fill('563');
      await page.getByTestId('export-height').press('Enter');
      await expect(page.getByTestId('export-width')).toHaveValue('1000');
      await expect(page.getByTestId('export-height')).toHaveValue('562');
      await page.getByTestId('export-preset-greenscreen-mp4').click();
      // 蓝色底
      await page.getByTestId('export-key-blue').click();
      await page.getByTestId('export-filename').fill('odd size');
      await expect(page.getByTestId('export-estimate')).toContainText(/MB/);
      await page.getByTestId('export-quality-draft').click();
      await page.getByTestId('export-start').click();
      await expect(page.getByTestId('export-result')).toHaveAttribute('data-kind', 'done', { timeout: await renderBoundTimeout(page, 60_000) });
      const path = (await page.getByTestId('export-path').textContent())!;
      expect(path).toBe(join(out, 'odd size.mp4'));
      expect(probe(path, 'stream=codec_name,width,height,nb_read_frames')).toMatchObject({ codec_name: 'h264', width: '1000', height: '562', nb_read_frames: '67' });
      let worst = 0;
      await decodeAllRgba(path, 1000 * 562 * 4, (frame, i) => {
        if (i !== 0) return;
        for (let p = 0; p < frame.length; p += 4) worst = Math.max(worst, frame[p]!, frame[p + 1]!, Math.abs(frame[p + 2]! - 255));
      });
      expect(worst).toBeLessThanOrEqual(4);
      // 重名时不覆盖
      await page.getByTestId('export-again').click();
      await page.getByTestId('export-start').click();
      await expect(page.getByTestId('export-result')).toHaveAttribute('data-kind', 'done', { timeout: await renderBoundTimeout(page, 60_000) });
      await expect(page.getByTestId('export-path')).toHaveText(join(out, 'odd size (2).mp4'));
    } finally {
      await app.close();
      removeUserDataDir(dir);
    }
  });

  test('失败时“复制诊断信息”：剪贴板里有版本、设置、错误码；返回设置可以再来', async () => {
    const dir = makeUserDataDir();
    const file = join(dir, 'a-file');
    writeFileSync(file, 'x');
    const { app, page } = await launchApp(dir, { ALLAY_E2E_EXPORT_TARGET: join(file, 'sub'), ALLAY_FFMPEG: requirePinnedFfmpeg() });
    try {
      const msg = await messages(page);
      await waitReady(page);
      await page.getByTestId('topbar-export').click();
      await page.getByTestId('export-start').click();
      const result = page.getByTestId('export-result');
      await expect(result).toHaveAttribute('data-code', 'output-not-writable', { timeout: 30_000 });
      await expect(result).toContainText(msg.export.errors.outputNotWritable!);
      await app.evaluate(({ clipboard }) => clipboard.writeText(''));
      await page.getByTestId('export-copy-diagnostics').click();
      await expect(page.getByTestId('export-copy-diagnostics')).toHaveText(/已复制|Copied/);
      const text = await app.evaluate(({ clipboard }) => clipboard.readText());
      expect(text).toContain('error: output-not-writable');
      expect(text).toMatch(/ffmpeg: ffmpeg version n9/);
      expect(text).toContain('preset: prores4444');
      expect(text).toContain('output: 1920x1080 @ 60 fps');
      expect(text).toContain('template: allay.builtin.block-wipe');
      await page.getByTestId('export-again').click();
      await expect(page.getByTestId('export-dialog')).toHaveAttribute('data-page', 'settings');
    } finally {
      await app.close();
      removeUserDataDir(dir);
    }
  });

  test('遮盖检查：T1 的剪辑点完全遮住；没盖满的模板给出警告但不阻止导出', async () => {
    const dir = makeUserDataDir();
    const { app, page } = await launchApp(dir, { ALLAY_E2E_EXPORT_TARGET: join(dir, 'exports'), ALLAY_FFMPEG: requirePinnedFfmpeg() });
    try {
      await waitReady(page);
      await page.getByTestId('topbar-export').click();
      await expect(page.getByTestId('export-cover')).toHaveAttribute('data-state', 'ok', { timeout: 30_000 });
      await page.keyboard.press('Escape');
      // 剪辑点只有一个小方块的测试模板
      const code = `export default { setup(ctx) { const { THREE, scene } = ctx; scene.add(new THREE.Mesh(new THREE.PlaneGeometry(100, 100), new THREE.MeshBasicMaterial({ color: '#ff0000' }))); return { duration: 1, cutTime: 0.5, update() {} }; } };`;
      await page.evaluate((c) => window.__allayTest!.loadTemplate(c), code);
      await waitReady(page);
      await page.getByTestId('topbar-export').click();
      const cover = page.getByTestId('export-cover');
      await expect(cover).toHaveAttribute('data-state', 'warn', { timeout: 30_000 });
      await expect(cover).toHaveAttribute('data-min-alpha', '0');
      await expect(page.getByTestId('export-start')).toBeEnabled();
    } finally {
      await app.close();
      removeUserDataDir(dir);
    }
  });
});
