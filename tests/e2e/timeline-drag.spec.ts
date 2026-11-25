import { expect, test, type Page } from '@playwright/test';
import { launchApp, makeUserDataDir, removeUserDataDir, type Launched } from './helpers';

// 时间轴的指针拖动（docs/06-ui-design.md 6.4、docs/04-templates.md 4.3）：一串小步 pointermove 之后，
// 被拖的东西停在“按下时的起点 + 总位移”上（吸附到帧），过程中被拖的元素一直挂在页面上、一直持有指针捕获，
// 整个拖动只记一条撤销记录且松手后撤销记录恢复正常。
// 回归：拖分界线时参数先变、引擎回来的时长后变，中间那一刻“各段之和 ≠ 时长”让色段和分界线被卸载，
// 指针捕获随之丢失，拖动只走了一帧就停住、松手也收不到（撤销记录一直暂停）。见 docs/decisions.md“时间轴拖动”。

const STEP_PX = 2;
const STEPS = 40;

async function waitReady(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => window.__allayTest!.status().kind), { timeout: 15_000 }).toBe('ready');
  await page.waitForFunction(() => window.__allayTest?.previewUpToDate() === true, undefined, { timeout: 30_000 });
}

/**
 * 模板库的封面做完：队列空、没有在做的。启动后模板库按需给第一屏和上下各一屏生成封面，每张在主线程上编码 PNG；
 * 软件渲染（CI 的 WARP）下要做十几秒以上，正好和拖动重叠，长任务观察器会把它们记成拖动的长任务。
 * 同 T-UI-7（m4.spec.ts 的 coversReady）、T-ARC-5（m1.spec.ts）：先等它做完再装观察器
 */
async function coversIdle(page: Page): Promise<void> {
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
}

/** 在页面里记录每一次 pointermove：被拖元素是否还在页面上、是否还持有捕获，以及处理这次移动的同步耗时 */
async function instrument(page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel)!;
    const log = { moves: 0, detached: 0, uncaptured: 0, lost: 0, handlerMs: [] as number[], longTasks: [] as number[], loaf: [] as string[] };
    let t0 = 0;
    window.addEventListener('pointermove', () => (t0 = performance.now()), true);
    window.addEventListener('pointermove', (e) => {
      // 只数按住时的移动（按下前把指针移到起点的那一次不算）
      if ((e.buttons & 1) === 0) return;
      log.moves++;
      log.handlerMs.push(performance.now() - t0);
      if (!el.isConnected) log.detached++;
      else if (!el.hasPointerCapture(e.pointerId)) log.uncaptured++;
    });
    document.addEventListener('lostpointercapture', () => log.lost++, true);
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) log.longTasks.push(e.duration);
    }).observe({ type: 'longtask' });
    // 只用来诊断（不断言）：超过 50 ms 的动画帧里跑了哪些脚本，长任务出现时看是不是拖动自己的处理
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as (PerformanceEntry & { blockingDuration: number; scripts: { invoker: string; sourceFunctionName: string; duration: number }[] })[]) {
        if (e.blockingDuration > 0) log.loaf.push(`${Math.round(e.duration)}ms[${e.scripts.map((x) => `${x.invoker}|${x.sourceFunctionName}:${Math.round(x.duration)}`).join(' ')}]`);
      }
    }).observe({ type: 'long-animation-frame' });
    (window as unknown as { __drag: typeof log & { el: HTMLElement } }).__drag = Object.assign(log, { el });
  }, selector);
}

interface DragLog {
  moves: number;
  detached: number;
  uncaptured: number;
  lost: number;
  handlerMs: number[];
  longTasks: number[];
  loaf: string[];
}
const readLog = (page: Page) =>
  page.evaluate(() => {
    const d = (window as unknown as { __drag: DragLog }).__drag;
    return { moves: d.moves, detached: d.detached, uncaptured: d.uncaptured, lost: d.lost, handlerMs: d.handlerMs, longTasks: d.longTasks, loaf: d.loaf };
  });

function summarize(ms: number[]): string {
  const sorted = [...ms].sort((a, b) => a - b);
  const p = (q: number) => (sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0).toFixed(2);
  return `n=${ms.length} p50=${p(0.5)}ms p95=${p(0.95)}ms max=${p(1)}ms`;
}

function annotate(a: { type: string; description: string }): void {
  test.info().annotations.push(a);
  console.log(`[${a.type}] ${a.description}`);
}

/** 元素包围盒的水平中心 */
async function centerX(page: Page, testId: string): Promise<number> {
  const b = (await page.getByTestId(testId).boundingBox())!;
  return b.x + b.width / 2;
}

test.describe('时间轴拖动', () => {
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

  test('分界线：一串小步拖动跟手，过程中不丢指针捕获，只记一步撤销', async () => {
    const { page } = launched;
    await waitReady(page);
    await coversIdle(page);
    const before = await page.evaluate(() => ({ params: window.__allayTest!.project().params, tr: window.__allayTest!.transport(), history: window.__allayTest!.history() }));
    const from = before.params.inDuration as number;
    const duration = before.tr.duration;
    const lanes = (await page.getByTestId('transport-track').boundingBox())!;
    const secPerPx = duration / lanes.width;
    const pxPerFrame = lanes.width / (duration * 60);

    await instrument(page, '[data-testid="timeline-boundary-0"]');
    const box = (await page.getByTestId('timeline-boundary-0').boundingBox())!;
    const x0 = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x0, y);
    await page.mouse.down();
    const moveMs: number[] = [];
    for (let i = 1; i <= STEPS; i++) {
      const t = performance.now();
      await page.mouse.move(x0 + i * STEP_PX, y);
      moveMs.push(performance.now() - t);
      await page.waitForTimeout(16);
    }
    // 松手前：分界线停在指针下（冻结的比例尺，误差不超过半帧的宽度加 1 px 的取整）
    await page.waitForTimeout(100);
    const boundaryX = await centerX(page, 'timeline-boundary-0');
    const log = await readLog(page);
    await page.mouse.up();
    await waitReady(page);

    const after = await page.evaluate(() => ({ params: window.__allayTest!.project().params, history: window.__allayTest!.history() }));
    const total = STEPS * STEP_PX;
    const expected = Math.round((from + total * secPerPx) * 60) / 60;
    annotate({
      type: '分界线拖动',
      description: `from=${from} expected=${expected.toFixed(4)} got=${(after.params.inDuration as number).toFixed(4)} pointer=${(x0 + total).toFixed(1)} boundary=${boundaryX.toFixed(1)} pxPerFrame=${pxPerFrame.toFixed(2)} moves=${log.moves} detached=${log.detached} uncaptured=${log.uncaptured} lost=${log.lost} handler: ${summarize(log.handlerMs)} cdpMove: ${summarize(moveMs)} longTasks=${JSON.stringify(log.longTasks)} loaf=${JSON.stringify(log.loaf)}`,
    });
    expect(log.moves).toBeGreaterThanOrEqual(STEPS);
    expect(log.detached, '拖动中分界线被卸载').toBe(0);
    expect(log.uncaptured, '拖动中丢了指针捕获').toBe(0);
    expect(log.lost, 'lostpointercapture').toBe(0);
    expect(after.params.inDuration as number).toBeCloseTo(expected, 6);
    expect(Math.abs(boundaryX - (x0 + total))).toBeLessThanOrEqual(pxPerFrame / 2 + 1);
    expect(log.longTasks).toEqual([]);
    // 整个拖动一步撤销；松手后撤销记录恢复（再改一个参数会多一步）
    expect(after.history.past).toBe(before.history.past + 1);
    await page.evaluate(() => window.__allayTest!.setParams({ hold: 0.2 }));
    await expect.poll(() => page.evaluate(() => window.__allayTest!.history().past)).toBe(before.history.past + 2);
  });

  test('分界线（键盘）：连按方向键逐帧改值，焦点一直留在分界线上', async () => {
    const { page } = launched;
    await waitReady(page);
    const from = (await page.evaluate(() => window.__allayTest!.project().params)).inDuration as number;
    const boundary = page.getByTestId('timeline-boundary-0');
    await boundary.focus();
    await page.evaluate(() => ((window as unknown as { __b0: Element | null }).__b0 = document.activeElement));
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await page.evaluate(() => window.__allayTest!.project().params)).inDuration as number).toBeCloseTo(from + 3 / 60, 6);
    expect(await page.evaluate(() => document.activeElement === (window as unknown as { __b0: Element | null }).__b0 && document.activeElement?.isConnected)).toBe(true);
    await waitReady(page);
    await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => (await page.evaluate(() => window.__allayTest!.project().params)).inDuration as number).toBeCloseTo(from + 2 / 60, 6);
  });

  test('播放头：一串小步擦洗跟手，过程中不丢指针捕获，时间吸附到帧', async () => {
    const { page } = launched;
    await waitReady(page);
    await coversIdle(page);
    const duration = (await page.evaluate(() => window.__allayTest!.transport())).duration;
    const lanes = (await page.getByTestId('transport-track').boundingBox())!;
    const pxPerFrame = lanes.width / (duration * 60);
    await instrument(page, '[data-testid="transport-track"]');
    // 在剪辑点轨上按下（避开阶段轨的分界线）
    const y = lanes.y + lanes.height - 10;
    const x0 = lanes.x + lanes.width * 0.1;
    await page.mouse.move(x0, y);
    await page.mouse.down();
    const moveMs: number[] = [];
    let worstLag = 0;
    for (let i = 1; i <= STEPS; i++) {
      const t = performance.now();
      await page.mouse.move(x0 + i * STEP_PX * 3, y);
      moveMs.push(performance.now() - t);
      await page.waitForTimeout(16);
      if (i % 10 === 0) {
        await page.waitForTimeout(50);
        worstLag = Math.max(worstLag, Math.abs((await centerX(page, 'timeline-playhead')) - (x0 + i * STEP_PX * 3)));
      }
    }
    const log = await readLog(page);
    await page.mouse.up();
    const xEnd = x0 + STEPS * STEP_PX * 3;
    const expected = Math.round(((xEnd - lanes.x) / lanes.width) * duration * 60) / 60;
    const tr = await page.evaluate(() => window.__allayTest!.transport());
    annotate({
      type: '播放头擦洗',
      description: `expected=${expected.toFixed(4)} got=${tr.time.toFixed(4)} worstLag=${worstLag.toFixed(1)}px pxPerFrame=${pxPerFrame.toFixed(2)} moves=${log.moves} detached=${log.detached} uncaptured=${log.uncaptured} lost=${log.lost} handler: ${summarize(log.handlerMs)} cdpMove: ${summarize(moveMs)} longTasks=${JSON.stringify(log.longTasks)} loaf=${JSON.stringify(log.loaf)}`,
    });
    expect(log.detached).toBe(0);
    expect(log.uncaptured).toBe(0);
    expect(log.lost).toBe(0);
    expect(tr.playing).toBe(false);
    expect(tr.time).toBeCloseTo(expected, 6);
    expect(worstLag).toBeLessThanOrEqual(pxPerFrame / 2 + 1);
    expect(log.longTasks).toEqual([]);
  });
});
