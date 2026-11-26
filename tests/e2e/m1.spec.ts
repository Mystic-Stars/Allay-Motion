import type * as NodeFs from 'node:fs';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import type * as NodePath from 'node:path';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { decodeAllRgba, probe, processAlive } from '../export/ffmpeg';
import { ROOT, SOFTWARE_TIMEOUT_FACTOR, launchApp, makeUserDataDir, readFixture, readMainLog, removeUserDataDir, rendererOf, requirePinnedFfmpeg, type Launched } from './helpers';
import { isSoftwareRenderer } from '../engine/software';

type Locale = { preview: { unresponsive: string }; export: { errors: Record<string, string> } };
const locale = (name: string): Locale => JSON.parse(readFileSync(join(ROOT, 'apps/desktop/src/renderer/i18n/locales', name), 'utf8')) as Locale;
const en = locale('en.json');
const zhCN = locale('zh-CN.json');

// M1 的端到端测试：预览与播放条、引擎 Worker 的隔离（T-ARC-3 Worker 部分、T-ARC-4）、看门狗（T-ARC-5）、
// 导出（T-EXP-5、T-EXP-6 的界面部分、T-EXP-7）。窗口不显示、不抢焦点。

async function waitStatus(page: Page, kind: string, timeout = 15_000): Promise<void> {
  await expect.poll(() => page.evaluate(() => window.__allayTest!.status().kind), { timeout }).toBe(kind);
}

/** 当前界面语言的文案 */
async function messages(page: Page) {
  const lang = await page.evaluate(() => document.documentElement.lang);
  return lang.startsWith('zh') ? zhCN : en;
}

test.describe('预览', () => {
  let dir: string;
  let launched: Launched;
  test.beforeAll(async () => {
    dir = makeUserDataDir();
    launched = await launchApp(dir);
  });
  test.afterAll(async () => {
    await launched.app.close();
    removeUserDataDir(dir);
  });

  test('内置 T1 装载后预览画布有画面：首帧全透明，剪辑点完全盖住', async () => {
    const { page } = launched;
    await waitStatus(page, 'ready');
    const tr = await page.evaluate(() => window.__allayTest!.transport());
    expect(tr.duration).toBeCloseTo(1.1, 6);
    expect(tr.cutTime).toBeCloseTo(0.55, 6);
    await expect(page.getByTestId('preview-canvas')).toBeVisible();
    const first = await page.evaluate(() => window.__allayTest!.previewStats(0));
    expect(first.width).toBeGreaterThan(100);
    expect(first.maxAlpha).toBe(0);
    const cut = await page.evaluate(() => window.__allayTest!.previewStats(0.55));
    expect(cut.minAlpha).toBe(255);
  });

  test('播放、暂停、拖动（键盘）', async () => {
    const { page } = launched;
    await waitStatus(page, 'ready');
    await page.getByTestId('transport-play').click();
    await expect.poll(() => page.evaluate(() => window.__allayTest!.transport().time), { timeout: 5000 }).toBeGreaterThan(0.05);
    await page.getByTestId('transport-play').click();
    const paused = await page.evaluate(() => window.__allayTest!.transport());
    expect(paused.playing).toBe(false);
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => window.__allayTest!.transport().time)).toBe(paused.time);

    const track = page.getByTestId('transport-track');
    await track.focus();
    await page.keyboard.press('Home');
    expect(await page.evaluate(() => window.__allayTest!.transport().time)).toBe(0);
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('ArrowRight');
    expect(await page.evaluate(() => window.__allayTest!.transport().time)).toBeCloseTo(11 / 60, 6);
    // 当前帧号在播放头的小牌上，总时长在时间码旁（第四版界面）
    await expect(page.getByTestId('timeline-playhead-frame')).toHaveText('11');
    await expect(page.getByTestId('transport-duration')).toHaveText('/ 00:01:06');
    await page.keyboard.press('End');
    await expect(page.getByTestId('timeline-playhead-frame')).toHaveText('66');
  });

  test('拖动（指针）：按下即暂停，时间吸附到帧', async () => {
    const { page } = launched;
    const track = page.getByTestId('transport-track');
    const box = (await track.boundingBox())!;
    await track.dispatchEvent('pointerdown', { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2, pointerId: 1, isPrimary: true, button: 0 });
    const t = await page.evaluate(() => window.__allayTest!.transport().time);
    expect(t).toBeGreaterThan(0.45);
    expect(t).toBeLessThan(0.65);
    expect(Math.abs(t * 60 - Math.round(t * 60))).toBeLessThan(1e-6);
  });

  test('T-ARC-4 模板拿不到 window、self.allay、fetch、indexedDB；动态 import() 被拒绝（应用内，带真实的 CSP）', async () => {
    const { page } = launched;
    await page.evaluate((code) => window.__allayTest!.loadTemplate(code), readFixture('escape-attempts.js'));
    await waitStatus(page, 'ready');
    const status = await page.evaluate(() => window.__allayTest!.status());
    const got = Object.fromEntries((status as { warnings: string[] }).warnings.map((w) => w.split('=') as [string, string]));
    expect(got).toMatchObject({ window: 'undefined', allay: 'undefined', selfAllay: 'undefined', fetch: 'undefined', indexedDB: 'undefined' });
    expect(got.dynamicImport).toMatch(/^blocked/);
    expect(got.eval).toMatch(/^blocked/);

    await page.evaluate((code) => window.__allayTest!.loadTemplate(code), readFixture('uses-import.js'));
    await waitStatus(page, 'error');
    const err = await page.evaluate(() => window.__allayTest!.status());
    expect((err as { message: string }).message).toMatch(/^has-import/);
    await expect(page.getByTestId('preview-error')).toBeVisible();
    await page.evaluate(() => window.__allayTest!.loadBuiltin());
    await waitStatus(page, 'ready');
  });

  test('T-ARC-5 update 死循环：看门狗在时限内终止并重建 Worker，主线程没有 > 100 ms 的卡顿，界面给出“模板无响应”', async () => {
    // 前面多等封面做完、杂务 Worker 销毁（见下，三步最多 30 + 60 + 45 秒），时限多给两分钟
    test.setTimeout(test.info().timeout + 120_000);
    const { page } = launched;
    const engineWorkers = () => page.workers().filter((w) => /engine\.worker/.test(w.url())).length;
    // 下面数引擎 Worker 时只该有预览的那一个。模板库的封面由杂务 Worker 生成，封面做完、空闲 15 秒后它才销毁
    // （covers.ts 的 WORKER_IDLE_MS；按需生成封面以前是做完一批立刻销毁）。所以先等第一屏的封面做完、它销毁，
    // 再装主线程的探针：探针一直占着主线程，装上以后封面会做得很慢；测试中途开始做封面的话，后面就会多数出一个
    await expect(page.locator('[data-testid="template-list"] img').first()).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const s = window.__allayTest!.coverStats();
            return s.queue.length === 0 && s.running === null;
          }),
        { timeout: 60_000 },
      )
      .toBe(true);
    await expect.poll(engineWorkers, { timeout: 45_000 }).toBe(1);
    const msg = await messages(page);
    const generation = await page.evaluate(() => window.__allayTest!.workerGeneration());
    // 主线程卡顿，三种量法，全部在页面里、不经过计时器（docs/decisions.md M2b“T-ARC-5 的 1 秒空洞”）：
    // - 长任务观察器：主线程上任何超过 50 ms 的任务；
    // - 探针 Worker：每 10 ms 给页面发一条消息，主线程立刻回，Worker 记下往返时间（Worker 的计时器不受隐藏页面节流）；
    // - MessageChannel 自循环：主线程连续给自己发消息，记下相邻两次回调的间隔。
    // 后两种量的是主线程“多久没有处理消息”，不管是 JS 任务还是渲染流水线里的等待都算。
    // CDP 往返时间只记录不断言：它还经过浏览器进程和 Playwright 自己的事件循环。
    await page.evaluate(() => {
      const longTasks: number[] = [];
      const obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) longTasks.push(e.duration);
      });
      obs.observe({ type: 'longtask' });
      const src = `const sent = new Map(); let seq = 0; let worst = 0;
        onmessage = (e) => {
          if (e.data === 'report') { postMessage({ worst }); return; }
          const t = sent.get(e.data);
          if (t !== undefined) { worst = Math.max(worst, performance.now() - t); sent.delete(e.data); }
        };
        setInterval(() => { const id = ++seq; sent.set(id, performance.now()); postMessage(id); }, 10);`;
      const probe = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      let report: (worst: number) => void = () => undefined;
      probe.onmessage = (e: MessageEvent<number | { worst: number }>) => {
        if (typeof e.data === 'number') probe.postMessage(e.data);
        else report(e.data.worst);
      };
      let maxGap = 0;
      let looping = true;
      let last = performance.now();
      const ch = new MessageChannel();
      ch.port1.onmessage = () => {
        const now = performance.now();
        maxGap = Math.max(maxGap, now - last);
        last = now;
        if (looping) ch.port2.postMessage(0);
      };
      ch.port2.postMessage(0);
      (window as unknown as { __jank: unknown }).__jank = {
        longTasks,
        async stop() {
          obs.disconnect();
          looping = false;
          const worst = await new Promise<number>((resolve) => {
            report = resolve;
            probe.postMessage('report');
          });
          probe.terminate();
          ch.port1.close();
          return { longTasks, workerRoundTrip: worst, channelGap: maxGap };
        },
      };
    });
    let probing = true;
    let maxCdpRoundTrip = 0;
    const cdpProbe = (async () => {
      while (probing) {
        const t0 = performance.now();
        await page.evaluate(() => 0);
        maxCdpRoundTrip = Math.max(maxCdpRoundTrip, performance.now() - t0);
        await new Promise((r) => setTimeout(r, 20));
      }
    })();
    const started = Date.now();
    await page.evaluate((code) => window.__allayTest!.loadTemplate(code), readFixture('hang-update.js'));
    await waitStatus(page, 'unresponsive', 10_000);
    const elapsed = Date.now() - started;
    // 预览单帧 5 秒的看门狗（2.3），加上装载的时间
    expect(elapsed).toBeLessThan(5000 + 2500);
    await expect(page.getByTestId('preview-error')).toContainText(msg.preview.unresponsive);
    // Worker 已重建（新的一代），而且是空闲的（没有再装载那个模板）
    await expect.poll(() => page.evaluate(() => window.__allayTest!.workerGeneration())).toBe(generation + 1);
    await expect.poll(engineWorkers).toBe(1);
    await page.waitForTimeout(300);
    probing = false;
    await cdpProbe;
    const jank = await page.evaluate(() =>
      (window as unknown as { __jank: { stop(): Promise<{ longTasks: number[]; workerRoundTrip: number; channelGap: number }> } }).__jank.stop(),
    );
    test.info().annotations.push({
      type: 'T-ARC-5 主线程',
      description: `longtasks=${JSON.stringify(jank.longTasks)} workerRoundTrip=${jank.workerRoundTrip.toFixed(1)}ms channelGap=${jank.channelGap.toFixed(1)}ms cdpRoundTrip=${maxCdpRoundTrip.toFixed(1)}ms`,
    });
    expect(jank.longTasks.filter((d) => d > 100)).toEqual([]);
    expect(jank.workerRoundTrip).toBeLessThan(100);
    expect(jank.channelGap).toBeLessThan(100);

    // 点“重试”换回正常模板
    await page.evaluate(() => window.__allayTest!.loadBuiltin());
    await waitStatus(page, 'ready');
    await expect(page.getByTestId('preview-error')).toHaveCount(0);
  });
});

test('T-ARC-3 引擎 Worker 对外部地址的请求失败，主进程日志有拦截记录', async () => {
  const dir = makeUserDataDir();
  const { app, page } = await launchApp(dir);
  try {
    await waitStatus(page, 'ready');
    // 第一层：Worker 里联网的全局已删除，CSP 也挡住动态 import
    const worker = page.workers().find((w) => /engine\.worker/.test(w.url()));
    expect(worker, 'engine worker').toBeTruthy();
    const plain = await worker!.evaluate(async () => {
      const g = globalThis as Record<string, unknown>;
      let imported: string;
      try {
        const url = 'https://example.com/allay-t-arc-3-csp.js';
        await import(/* @vite-ignore */ url);
        imported = 'succeeded';
      } catch {
        imported = 'failed';
      }
      return { fetch: typeof g.fetch, xhr: typeof g.XMLHttpRequest, ws: typeof g.WebSocket, imported };
    });
    expect(plain).toEqual({ fetch: 'undefined', xhr: 'undefined', ws: 'undefined', imported: 'failed' });
    expect(readMainLog(dir)).not.toMatch(/\[net\] blocked request .*allay-t-arc-3-csp/);

    // 第二层（真正的保证）：没有 CSP 时，Worker 发出的请求被会话级拦截取消并记日志。
    // Worker 脚本的 CSP 来自它自己的 app:// 响应，Page.setBypassCSP 管不到；这个测试单独启动一个应用，
    // 在主进程里把 app:// 换成提供同样文件、但不带 CSP 头的处理函数（会话级的 onBeforeRequest 不动），再重新加载。
    await app.evaluate(async ({ app: electronApp, protocol }) => {
      const req = (process as unknown as { mainModule: { require(id: string): unknown } }).mainModule.require;
      const fs = req('node:fs') as typeof NodeFs;
      const path = req('node:path') as typeof NodePath;
      const root = path.join(electronApp.getAppPath(), 'out', 'renderer');
      const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json' };
      protocol.unhandle('app');
      protocol.handle('app', (request) => {
        const file = path.normalize(path.join(root, decodeURIComponent(new URL(request.url).pathname)));
        if (!file.startsWith(root) || !fs.existsSync(file)) return new Response('not found', { status: 404 });
        return new Response(fs.readFileSync(file), { headers: { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' } });
      });
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Page.setBypassCSP', { enabled: true });
    await page.reload();
    await waitStatus(page, 'ready');
    const w2 = page.workers().find((w) => /engine\.worker/.test(w.url()));
    expect(w2, 'engine worker after reload').toBeTruthy();
    const bypassed = await w2!.evaluate(async () => {
      const out: string[] = [];
      for (const attempt of [
        () => {
          const url = 'https://example.com/allay-t-arc-3-worker.js';
          return import(/* @vite-ignore */ url);
        },
        () => new FontFace('x', 'url(https://example.com/allay-t-arc-3-worker.woff2)').load(),
      ]) {
        try {
          await attempt();
          out.push('succeeded');
        } catch {
          out.push('failed');
        }
      }
      return out;
    });
    expect(bypassed).toEqual(['failed', 'failed']);
    await expect.poll(() => readMainLog(dir)).toMatch(/blocked request .*example\.com\/allay-t-arc-3-worker/);
  } finally {
    await app.close();
    removeUserDataDir(dir);
  }
});

test.describe('导出', () => {
  /** 打开导出对话框，按默认设置（ProRes 4444、标准画质）导出，返回结果元素 */
  async function exportViaUi(page: Page, quality?: string) {
    await waitStatus(page, 'ready');
    await page.getByTestId('topbar-export').click();
    await expect(page.getByTestId('export-dialog')).toBeVisible();
    if (quality) await page.getByTestId(`export-quality-${quality}`).click();
    await page.getByTestId('export-start').click();
  }

  test('T-EXP-7 端到端：T1 默认参数，1080p60，标准画质，ProRes 4444', async () => {
    const dir = makeUserDataDir();
    const out = join(dir, 'exports');
    mkdirSync(out);
    const ffmpeg = requirePinnedFfmpeg();
    const { app, page } = await launchApp(dir, { ALLAY_E2E_EXPORT_TARGET: out, ALLAY_FFMPEG: ffmpeg });
    try {
      // 软件渲染（CI 的 WARP）不是参考机器：测试时限在 launchApp 里已放宽，等导出结束的时限同样乘 SOFTWARE_TIMEOUT_FACTOR（判定不变，docs/decisions.md M8）
      const gpu = await rendererOf(page);
      const software = isSoftwareRenderer(gpu);
      const started = Date.now();
      await exportViaUi(page);
      const result = page.getByTestId('export-result');
      await expect(result).toHaveAttribute('data-kind', 'done', { timeout: 60_000 * (software ? SOFTWARE_TIMEOUT_FACTOR : 1) });
      const seconds = (Date.now() - started) / 1000;
      // 预算：1080p60、2 秒、标准画质 ≤ 20 秒（2.11）；T1 默认参数只有 1.1 秒，用同一个上限。
      // 软件渲染下只记数字、不判定（同 T-ARC-7，docs/decisions.md M8）
      test.info().annotations.push({ type: 'T-EXP-7 seconds', description: `${gpu}; ${seconds.toFixed(2)}` });
      if (!software) expect(seconds).toBeLessThanOrEqual(20);
      const path = (await page.getByTestId('export-path').textContent())!;
      expect(path.startsWith(out)).toBe(true);
      expect(path).toMatch(/_1920x1080_60fps\.mov$/);
      expect(readdirSync(out)).toHaveLength(1);

      const info = probe(path, 'stream=codec_name,color_range,color_space,color_transfer,color_primaries,r_frame_rate,nb_read_frames:format_tags=comment');
      expect(info).toMatchObject({ codec_name: 'prores', color_space: 'bt709', color_transfer: 'bt709', color_primaries: 'bt709', color_range: 'tv', r_frame_rate: '60/1', nb_read_frames: '67' });
      const cutFrame = Math.round(0.55 * 60);
      expect(info['TAG:comment']).toBe(`cut_frame=${cutFrame}`);

      const stats: { min: number; max: number }[] = [];
      const n = await decodeAllRgba(path, 1920 * 1080 * 4, (frame) => {
        let min = 255;
        let max = 0;
        for (let i = 3; i < frame.length; i += 4) {
          const a = frame[i]!;
          if (a < min) min = a;
          if (a > max) max = a;
        }
        stats.push({ min, max });
      });
      expect(n).toBe(67);
      expect(stats[0]!.max, 'first frame').toBe(0);
      expect(stats[66]!.max, 'last frame').toBe(0);
      expect(stats[cutFrame]!.min, 'cut frame').toBe(255);
      test.info().annotations.push({ type: 'T-EXP-7 seconds', description: seconds.toFixed(2) });
    } finally {
      await app.close();
      removeUserDataDir(dir);
    }
  });

  test('T-EXP-5（界面）导出到一半取消：没有残留文件和 FFmpeg 进程', async () => {
    const dir = makeUserDataDir();
    const out = join(dir, 'exports');
    mkdirSync(out);
    const { app, page } = await launchApp(dir, { ALLAY_E2E_EXPORT_TARGET: out, ALLAY_FFMPEG: requirePinnedFfmpeg() });
    try {
      // 让导出确定地停在第 5 帧（FFmpeg 仍在运行、.partial 已经有内容），不依赖“导出慢到来得及点取消”
      await page.evaluate(() => window.__allayTest!.pauseExportAfter(5));
      await exportViaUi(page);
      await expect.poll(() => page.evaluate(() => window.__allayTest!.exportPausedAt()), { timeout: 30_000 }).toBe(5);
      await expect(page.getByTestId('export-progress')).toContainText('5');
      expect(readdirSync(out).filter((f) => f.endsWith('.partial'))).toHaveLength(1);
      const pid = Number(/job started .*"pid":(\d+)/.exec(readMainLog(dir))?.[1]);
      expect(pid).toBeGreaterThan(0);
      expect(processAlive(pid)).toBe(true);
      await page.getByTestId('export-cancel').click();
      await expect(page.getByTestId('export-result')).toHaveAttribute('data-kind', 'canceled', { timeout: 15_000 });
      await expect.poll(() => readdirSync(out)).toEqual([]);
      const log = readMainLog(dir);
      expect(log).toContain('job canceled');
      expect(processAlive(pid)).toBe(false);
      await page.evaluate(() => window.__allayTest!.pauseExportAfter(null));
    } finally {
      await app.close();
      removeUserDataDir(dir);
    }
  });

  test('T-EXP-6（界面）伪造的坏二进制：界面出现对应文案，没有残留文件', async () => {
    const dir = makeUserDataDir();
    const out = join(dir, 'exports');
    mkdirSync(out);
    const bad = join(dir, 'ffmpeg.exe');
    writeFileSync(bad, Buffer.from('not an executable\n'.repeat(64)));
    const { app, page } = await launchApp(dir, { ALLAY_E2E_EXPORT_TARGET: out, ALLAY_FFMPEG: bad });
    try {
      const msg = await messages(page);
      await waitStatus(page, 'ready');
      await page.getByTestId('topbar-export').click();
      // 打开对话框时就探测出 FFmpeg 不能用：给出文案，“导出”按钮禁用（启动失败的路径在 test:export 里直接测）
      await expect(page.getByTestId('export-dialog').getByRole('alert')).toContainText(msg.export.errors.ffmpegMissing!);
      await expect(page.getByTestId('export-start')).toBeDisabled();
      expect(readdirSync(out)).toEqual([]);
      expect(readMainLog(dir)).toMatch(/ffmpeg probed .*"presets":\{"prores4444":false,"png-sequence":false,"webm-vp9":false,"greenscreen-mp4":false\}/);
    } finally {
      await app.close();
      removeUserDataDir(dir);
    }
  });

  test('T-EXP-6（界面）不可写的路径：界面出现对应文案，没有残留文件', async () => {
    const dir = makeUserDataDir();
    const file = join(dir, 'a-file');
    writeFileSync(file, 'x');
    const { app, page } = await launchApp(dir, { ALLAY_E2E_EXPORT_TARGET: join(file, 'sub'), ALLAY_FFMPEG: requirePinnedFfmpeg() });
    try {
      const msg = await messages(page);
      await exportViaUi(page);
      const result = page.getByTestId('export-result');
      await expect(result).toHaveAttribute('data-code', 'output-not-writable', { timeout: 30_000 });
      await expect(result).toContainText(msg.export.errors.outputNotWritable!);
      expect(readdirSync(dir).filter((f) => f.includes('.partial'))).toEqual([]);
    } finally {
      await app.close();
      removeUserDataDir(dir);
    }
  });
});
