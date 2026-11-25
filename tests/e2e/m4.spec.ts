import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { requiredTextures } from '../../packages/assets/src/index';
import { catalogJarEntries, makeCatalogGame } from '../unit/helpers/resource-fixtures';
import { extendTimeoutPerTemplate, launchApp, makeUserDataDir, removeUserDataDir, ROOT } from './helpers';

// M4 界面的验收测试（docs/06-ui-design.md 6.10、07-allay-mascot.md 7.10）：T-UI-1 至 T-UI-5、T-UI-7，T-ALY-2、T-ALY-5，
// 以及工程的保存和打开。T-UI-6、T-UI-8 在 layout.spec.ts、titlebar.spec.ts。
// 窗口不显示、不抢焦点；键盘、鼠标都是 Playwright 经 CDP 发给页面的，不动真实的鼠标键盘。

const FLAGSHIP = 'allay.builtin.block-wipe';

interface Ctx {
  app: ElectronApplication;
  page: Page;
  dir: string;
}

/** 假原版层（纯色色块，测试数据）；seed 写进 settings.json 的 ui 部分 */
async function start(ui: Record<string, unknown> = {}, extraEnv: Record<string, string> = {}): Promise<Ctx> {
  const dir = makeUserDataDir();
  const appData = join(dir, 'appdata');
  const paths = requiredTextures().map((r) => ({ id: r.id, path: r.anyOf[0]! }));
  makeCatalogGame(join(appData, '.minecraft'), '9.9.9', '2030-01-01T00:00:00+00:00', catalogJarEntries(paths, {}));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify({
      formatVersion: 1,
      ui: { theme: 'dark', language: 'zh-CN', reducedMotion: 'off', layout: { left: { size: 280, collapsed: false }, right: { size: 320, collapsed: false } }, ...ui },
      resources: { vanilla: { consent: true, enabled: true, dir: null }, packs: [] },
    }),
  );
  const { app, page } = await launchApp(dir, { ALLAY_E2E_GAME_APPDATA: appData, ...extraEnv });
  await upToDate(page);
  // 原版层在后台探测，探测完会重新装载一次
  await expect.poll(() => page.evaluate(() => window.__allayTest!.resourceState()?.detecting === false && window.__allayTest!.resourceState()?.hasAssets === true)).toBe(true);
  await upToDate(page);
  return { app, page, dir };
}

/** 模板库的封面生成完（杂务 Worker 和主线程上的 PNG 编码不再和测试抢时间，模板库的加载编排也结束了） */
async function coversReady(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="template-list"] img').first()).toBeVisible({ timeout: 30_000 });
  // 第一屏和上下各一屏的封面都做完，加载编排才结束；排在最前面的模板（第 3、4 批的方块类）比原来的重，机器忙时超过默认的 5 秒
  await expect(page.getByTestId('gallery-loader')).toHaveAttribute('data-allay-loader-phase', 'idle', { timeout: 30_000 });
}

async function stop(ctx: Ctx): Promise<void> {
  await ctx.app.close();
  removeUserDataDir(ctx.dir);
}

async function upToDate(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__allayTest?.previewUpToDate() === true, undefined, { timeout: 30_000 });
}

const params = (page: Page) => page.evaluate(() => window.__allayTest!.project().params);

test('T-UI-1 依次选中每个内置模板，改一个参数：预览画布非空，改参数后画面变化', async () => {
  const ctx = await start();
  const { page } = ctx;
  try {
    const builtins = (await page.evaluate(() => window.__allayTest!.templates())).filter((e) => e.source === 'builtin' && !e.baseMissing);
    expect(builtins.length).toBeGreaterThan(0);
    extendTimeoutPerTemplate(builtins.length, 8_000);
    for (const e of builtins) {
      await page.getByTestId(`template-${e.id}`).click();
      await expect.poll(() => page.evaluate(() => window.__allayTest!.project().ref?.id)).toBe(e.id);
      await upToDate(page);
      const tr = await page.evaluate(() => window.__allayTest!.transport());
      // 取样时刻：整段里均匀的几帧加剪辑点。只看剪辑点不够——转场在剪辑点“完全盖住画面”，
      // 平涂填充时很多参数（节奏、图案、方向）不改变这一帧，变化出现在进入、退出阶段（decisions.md M4）
      const times = [0.2, 0.35, 0.5, 0.65, 0.8].map((k) => k * tr.duration).concat(tr.cutTime ?? []);
      const sample = () => page.evaluate(async (ts) => (await Promise.all(ts.map((x) => window.__allayTest!.previewHash(x)))).join(','), times);
      let maxAlpha = 0;
      for (const t of times) maxAlpha = Math.max(maxAlpha, (await page.evaluate((x) => window.__allayTest!.previewStats(x), t)).maxAlpha);
      expect(maxAlpha, `${e.id} 的预览画布非空`).toBeGreaterThan(0);
      const before = await sample();
      // 经属性面板改一个数字参数：保留键盘步进，跳过处于边界、无法步进的控件。
      const inputs = page.locator('[data-testid="param-panel"] input[aria-roledescription="Number field"]:visible:enabled');
      const count = await inputs.count();
      expect(count, `${e.id} 的属性面板里有数字参数`).toBeGreaterThan(0);
      let changed = false;
      let which = '';
      for (let i = 0; i < Math.min(count, 6) && !changed; i++) {
        const input = inputs.nth(i);
        which = (await input.getAttribute('aria-label')) ?? String(i);
        await input.focus();
        const rev = await page.evaluate(() => window.__allayTest!.project().revision);
        for (let k = 0; k < 3; k++) await input.press('ArrowUp');
        if ((await page.evaluate(() => window.__allayTest!.project().revision)) === rev) {
          for (let k = 0; k < 3; k++) await input.press('ArrowDown');
        }
        if ((await page.evaluate(() => window.__allayTest!.project().revision)) === rev) continue;
        await upToDate(page);
        changed = (await sample()) !== before;
      }
      expect(changed, `${e.id} 改参数后画面变化`).toBe(true);
      test.info().annotations.push({ type: 'T-UI-1', description: `${e.id}：改“${which}”后画面变化（${builtins.length} 个内置模板）` });
    }
  } finally {
    await stop(ctx);
  }
});

test('T-UI-2 连续改 5 个参数再撤销 5 次回到初始；拖动一次滑块只算一步', async () => {
  const ctx = await start();
  const { page } = ctx;
  try {
    await expect.poll(() => page.evaluate(() => window.__allayTest!.project().ref?.id)).toBe(FLAGSHIP);
    await coversReady(page);
    const initial = await params(page);
    expect(await page.evaluate(() => window.__allayTest!.history())).toEqual({ past: 0, future: 0 });
    const patches = [{ cols: 16 }, { style: 'flat' }, { inPattern: 'diagonal' }, { overlap: 0.7 }, { seed: 42 }];
    for (const p of patches) await page.evaluate((x) => window.__allayTest!.setParams(x), p);
    expect((await page.evaluate(() => window.__allayTest!.history())).past).toBe(5);
    await page.locator('body').focus();
    for (let i = 0; i < 5; i++) await page.keyboard.press('Control+KeyZ');
    expect(await params(page)).toEqual(initial);
    // 重做一步再撤销
    await page.keyboard.press('Control+Shift+KeyZ');
    expect((await params(page)).cols).toBe(16);
    await page.keyboard.press('Control+KeyZ');
    expect(await params(page)).toEqual(initial);

    // 拖动一次“重叠”的滑块：按下、移动多次、松开
    const pastBefore = (await page.evaluate(() => window.__allayTest!.history())).past;
    const slider = page.locator('[data-testid="param-overlap"] > div').first();
    const box = (await slider.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + box.width * (0.2 + i * 0.05), box.y + box.height / 2);
    await page.mouse.up();
    const dragged = (await params(page)).overlap;
    expect(dragged).not.toBe(initial.overlap);
    await expect.poll(async () => (await page.evaluate(() => window.__allayTest!.history())).past - pastBefore, { message: '一次拖动只算一步' }).toBe(1);
    await page.keyboard.press('Control+KeyZ');
    expect(await params(page)).toEqual(initial);
  } finally {
    await stop(ctx);
  }
});

/** 当前焦点元素（或它所在的控件）有 2 px 的焦点环 */
async function focusRingVisible(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    let el = document.activeElement as HTMLElement | null;
    for (let i = 0; el && i < 3; i++, el = el.parentElement) {
      const cs = getComputedStyle(el);
      if (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2) return true;
    }
    return false;
  });
}

async function tabTo(page: Page, match: (el: { testid: string | null; inside: string | null }) => boolean, max = 120): Promise<void> {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return { testid: el?.dataset.testid ?? null, inside: (el?.closest('[data-testid]') as HTMLElement | null)?.dataset.testid ?? null };
    });
    if (match(info)) return;
  }
  throw new Error('Tab 走不到目标');
}

test('T-UI-3 只用键盘：选模板、改参数、打开导出对话框、取消；焦点环可见', async () => {
  const ctx = await start();
  const { page } = ctx;
  try {
    // 等模板库装载完（卡片出现）再开始按 Tab：装载期间卡片还不可聚焦
    await coversReady(page);
    await page.locator('body').focus();
    // 选模板
    await tabTo(page, (x) => x.testid === `template-${FLAGSHIP}`);
    expect(await focusRingVisible(page), '模板卡片的焦点环').toBe(true);
    await page.keyboard.press('Enter');
    await upToDate(page);
    // 改参数：列数的数字框
    await tabTo(page, (x) => x.inside === 'param-cols');
    expect(await focusRingVisible(page), '数字框的焦点环').toBe(true);
    const cols = (await params(page)).cols as number;
    await page.keyboard.press('ArrowUp');
    await expect.poll(async () => (await params(page)).cols).toBe(cols + 1);
    // 打开导出对话框（Ctrl+E），Tab 到“关闭”，回车
    await page.keyboard.press('Control+KeyE');
    await expect(page.getByTestId('export-dialog')).toBeVisible();
    await tabTo(page, (x) => x.testid === 'export-dismiss', 20);
    expect(await focusRingVisible(page), '对话框按钮的焦点环').toBe(true);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('export-dialog')).toHaveCount(0);
  } finally {
    await stop(ctx);
  }
});

/** 文字溢出：元素的内容比盒子宽，又没有用 truncate（带 title 的有意截断）兜住 */
async function overflowing(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('button, [role="tab"], [role="menuitem"], [role="option"], label, h2, h3, th, td, p, [data-testid="transport-time"], [data-testid="transport-frame"]')) {
      if (el.getClientRects().length === 0 || el.closest('[aria-hidden="true"], .sr-only')) continue;
      if (el.classList.contains('truncate') || el.querySelector('.truncate') || el.closest('.truncate')) continue;
      if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) out.push(`${el.tagName.toLowerCase()}[${el.dataset.testid ?? ''}] “${el.textContent?.trim().slice(0, 40)}” ${el.scrollWidth}>${el.clientWidth}`);
    }
    return out;
  });
}

const RAW_KEY = /\b(?:topbar|gallery|templates|preview|transport|params|export|resources|settings|command|editor|project|output|common|shortcuts|layout)\.[a-zA-Z][\w.-]*\b/;

for (const language of ['zh-CN', 'en'] as const) {
  test(`T-UI-4 ${language}：最小窗口下没有缺失的文案键，没有文字溢出`, async () => {
    const ctx = await start({ language });
    const { app, page } = ctx;
    try {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1120, 700));
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1120);
      await upToDate(page);
      const check = async (where: string) => {
        await page.waitForTimeout(300);
        expect(await overflowing(page), `${where}：文字溢出`).toEqual([]);
        const text = await page.evaluate(() => document.body.innerText);
        expect(text.match(RAW_KEY)?.[0] ?? null, `${where}：界面上出现了文案键`).toBeNull();
      };
      await check('主界面');
      // 每个内置模板：卡片有封面、悬停时播放预览，选中后属性面板（各模板用到的参数类型）不溢出。
      // 封面只给滚到可见范围附近的卡片生成、悬停预览停够了才生成（docs/decisions.md“模板库撑到一百个模板”）：先滚到它
      await coversReady(page);
      const builtins = (await page.evaluate(() => window.__allayTest!.templates())).filter((e) => e.source === 'builtin' && !e.baseMissing);
      extendTimeoutPerTemplate(builtins.length, 10_000);
      for (const e of builtins) {
        const card = page.getByTestId(`template-${e.id}`);
        await card.scrollIntoViewIfNeeded();
        await expect(card.locator('img'), `${e.id} 的封面`).toBeVisible({ timeout: 30_000 });
        await card.hover();
        await expect(card.locator('canvas'), `${e.id} 的悬停预览`).toBeVisible({ timeout: 30_000 });
        await card.click();
        await expect.poll(() => page.evaluate(() => window.__allayTest!.project().ref?.id)).toBe(e.id);
        await upToDate(page);
        // 把属性面板的分组全部展开再查
        const collapsed = page.locator('[data-testid^="param-group-"][aria-expanded="false"]');
        const groupIds = await collapsed.evaluateAll((groups) => groups.map((group) => group.getAttribute('data-testid')!));
        for (const id of groupIds) await page.getByTestId(id).click();
        await check(`属性面板/${e.id}`);
      }
      await page.mouse.move(0, 0);
      // 后面的方块选择器用 T1 的“方块”参数
      await page.getByTestId(`template-${FLAGSHIP}`).click();
      await upToDate(page);
      // 设置对话框的每一页
      await page.keyboard.press('Control+Comma');
      for (const p of ['general', 'appearance', 'assets', 'folders', 'export', 'shortcuts', 'about']) {
        await page.getByTestId(`settings-tab-${p}`).click();
        await check(`设置/${p}`);
      }
      await page.keyboard.press('Escape');
      // 命令面板
      await page.keyboard.press('Control+KeyK');
      await expect(page.getByTestId('command-palette')).toBeVisible();
      await check('命令面板');
      await page.keyboard.press('Escape');
      // 资源栈弹层
      await page.getByTestId('resources-button').click();
      await expect(page.getByTestId('resources-popover')).toBeVisible();
      await check('资源栈弹层');
      await page.keyboard.press('Escape');
      // 方块选择器
      await page.getByTestId('param-blocks').getByRole('button').first().click();
      await check('方块选择器');
      await page.keyboard.press('Escape');
      // 导出对话框
      await page.keyboard.press('Control+KeyE');
      await expect(page.getByTestId('export-dialog')).toBeVisible();
      await check('导出对话框');
      await page.keyboard.press('Escape');
      // “我的”空状态
      await page.getByTestId('gallery-tab-mine').click();
      await check('我的');
      expect(await page.evaluate(() => window.__allayTest!.missingKeys())).toEqual([]);
    } finally {
      await stop(ctx);
    }
  });
}

for (const theme of ['dark', 'light'] as const) {
  test(`T-UI-5 ${theme}：截图与基线一致；axe-core 没有对比度问题`, async () => {
    const ctx = await start({ theme, language: 'zh-CN' });
    const { page } = ctx;
    try {
      // 内容区定成 1440×900（6.3 的默认尺寸）。不设时按默认外框尺寸建窗，内容区随系统缩放有 1–3 px 的取整误差
      // （window.ts、docs/decisions.md M4“窗口大小记的是内容区尺寸”）：原来的基线是在 150% 缩放的机器上截的，高 902；CI 是 100%，900
      await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900));
      await expect.poll(() => page.evaluate(() => [window.innerWidth, window.innerHeight])).toEqual([1440, 900]);
      // 封面生成完（可见范围里的卡片都有了）、预览在第 0 帧
      await coversReady(page);
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="template-list"] [data-in-view="true"] [data-cover="loading"]').length === 0);
      await page.evaluate(() => window.__allayTest!.setTime(0));
      await upToDate(page);
      await page.waitForTimeout(500);
      // 引擎画出来的东西（预览画布、封面、方块缩略图）随显卡不同，蒙住；悦灵头像会眨眼，也蒙住。
      // 状态栏的版本号每次发版都变（基线停在 v0.2.0，发 v0.3.0 后就对不上），也蒙住。
      // 模板库的封面不用蒙版：蒙版按元素的方框画、不管滚动容器的裁切，面板下边缘露出一半的卡片会盖到时间轴上。
      // 改成把卡片里的图藏起来，只留界面自己画的棋盘格底、选中框、名称和时长
      await page.addStyleTag({ content: '[data-testid="template-list"] img, [data-testid="template-list"] canvas { visibility: hidden !important; }' });
      await expect(page).toHaveScreenshot(`ui-${theme}.png`, {
        animations: 'disabled',
        caret: 'hide',
        mask: [page.locator('canvas:not([data-testid="template-list"] canvas)'), page.locator('img:not([data-testid="template-list"] img)'), page.locator('[data-allay]'), page.getByTestId('status-version')],
        maxDiffPixelRatio: 0.01,
        timeout: 30_000,
      });

      const axeSource = readFileSync(createRequire(join(ROOT, 'package.json')).resolve('axe-core/axe.min.js'), 'utf8');
      // CSP 不允许内联脚本；经 DevTools 协议求值（CSP 管不到）把 axe 装进页面
      await page.evaluate(axeSource);
      const result = await page.evaluate(async () => {
        const axe = (window as unknown as { axe: { run(ctx: unknown, opts: unknown): Promise<{ violations: { id: string; impact: string; nodes: { target: string[]; failureSummary: string }[] }[] }> } }).axe;
        const r = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } });
        return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 5).map((n) => `${n.target.join(' ')} — ${n.failureSummary.split('\n')[1] ?? ''}`) }));
      });
      expect(result.filter((v) => v.id === 'color-contrast'), '对比度').toEqual([]);
      expect(result.filter((v) => v.impact === 'critical' || v.impact === 'serious'), '严重的无障碍问题').toEqual([]);
    } finally {
      await stop(ctx);
    }
  });
}

test('T-UI-7 持续拖动一个滑块 3 秒：主线程没有超过 50 ms 的长任务', async () => {
  const ctx = await start();
  const { page } = ctx;
  try {
    await coversReady(page);
    await page.evaluate(() => {
      const w = window as unknown as { __longTasks: number[] };
      w.__longTasks = [];
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.__longTasks.push(e.duration);
      }).observe({ type: 'longtask' });
    });
    const slider = page.locator('[data-testid="param-overlap"] > div').first();
    const box = (await slider.boundingBox())!;
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width * 0.5, y);
    await page.mouse.down();
    const t0 = Date.now();
    let i = 0;
    while (Date.now() - t0 < 3000) {
      const k = (Math.sin(i++ / 6) + 1) / 2;
      await page.mouse.move(box.x + box.width * (0.05 + 0.9 * k), y);
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
    await upToDate(page);
    const moves = i;
    const longTasks = await page.evaluate(() => (window as unknown as { __longTasks: number[] }).__longTasks);
    expect(moves).toBeGreaterThan(60);
    expect(longTasks, `长任务（ms）：${longTasks.join(', ')}`).toEqual([]);
    // 整个拖动只算一步
    await expect.poll(async () => (await page.evaluate(() => window.__allayTest!.history())).past).toBe(1);
  } finally {
    await stop(ctx);
  }
});

interface PhaseLog {
  t0: number;
  tReady: number;
  log: { t: number; phase: string; flyer: boolean }[];
}

/** 在页面里模拟一次 ms 长的加载，记下加载编排的每次变化（时间都是页面里的 performance.now） */
async function simulate(page: Page, ms: number): Promise<PhaseLog> {
  return page.evaluate(async (dur) => {
    const el = document.querySelector<HTMLElement>('[data-testid="preview-loader"]')!;
    const log: { t: number; phase: string; flyer: boolean }[] = [];
    const record = () => log.push({ t: performance.now(), phase: el.dataset.allayLoaderPhase ?? '', flyer: !!el.querySelector('[data-testid="allay-flyer"]') });
    const mo = new MutationObserver(record);
    mo.observe(el, { attributes: true, childList: true, subtree: true });
    const t0 = performance.now();
    window.__allayTest!.simulateLoading(true);
    await new Promise((r) => setTimeout(r, dur));
    const tReady = performance.now();
    window.__allayTest!.simulateLoading(false);
    await new Promise((r) => setTimeout(r, 1500));
    mo.disconnect();
    record();
    return { t0, tReady, log };
  }, ms);
}

test('T-ALY-2 加载时序：100 ms 不出现；300 ms 出现并至少停留 500 ms；就绪后 300 ms 内退场完毕', async () => {
  const ctx = await start();
  const { page } = ctx;
  try {
    await coversReady(page);
    const first = (r: PhaseLog, p: string) => r.log.find((e) => e.phase === p)?.t;
    const lastIdle = (r: PhaseLog) => r.log.filter((e) => e.phase === 'idle').at(0)?.t;

    const a = await simulate(page, 100);
    const show = (r: PhaseLog) => JSON.stringify({ t0: r.t0, tReady: r.tReady, log: r.log.map((e) => [Math.round(e.t - r.t0), e.phase, e.flyer]) });
    expect(a.log.some((e) => e.phase === 'shown' || e.phase === 'holding' || e.phase === 'exiting'), `100 ms：骨架不出现 ${show(a)}`).toBe(false);
    expect(a.log.some((e) => e.flyer), '100 ms：悦灵不出现').toBe(false);

    const b = await simulate(page, 300);
    const shown = first(b, 'shown')!;
    expect(shown - b.t0, show(b)).toBeGreaterThanOrEqual(170);
    expect(shown - b.t0, show(b)).toBeLessThan(260);
    expect(b.log.some((e) => e.flyer), '300 ms：悦灵出现').toBe(true);
    expect(first(b, 'exiting')! - shown, '至少停留 500 ms').toBeGreaterThanOrEqual(495);
    const free = Math.max(b.tReady, shown + 500);
    expect(lastIdle(b)! - free, '可以退场后 300 ms 内退场完毕').toBeLessThanOrEqual(300);
    expect(b.log.at(-1)!.flyer).toBe(false);

    const c = await simulate(page, 3000);
    expect(lastIdle(c)! - c.tReady, '3 s：就绪后 300 ms 内退场完毕').toBeLessThanOrEqual(300);
    expect(c.log.at(-1)!.flyer).toBe(false);
  } finally {
    await stop(ctx);
  }
});

test('T-ALY-5 飞舞时在悦灵所在位置点击：点击落到下面的元素上', async () => {
  const ctx = await start();
  const { page } = ctx;
  try {
    await coversReady(page);
    await page.evaluate(() => window.__allayTest!.simulateLoading(true));
    const bird = page.getByTestId('preview-loader').getByTestId('allay-flyer-bird');
    await expect(bird).toBeVisible();
    await page.waitForTimeout(800);
    const box = (await bird.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.evaluate(() => {
      const w = window as unknown as { __clicked: string | null };
      w.__clicked = null;
      document.addEventListener(
        'click',
        (e) => {
          const el = e.target as HTMLElement;
          w.__clicked = el.closest('[data-testid="preview-loading-layer"]') ? 'loader' : (el.closest('[data-testid]') as HTMLElement | null)?.dataset.testid ?? el.tagName;
        },
        { capture: true, once: true },
      );
    });
    const under = await page.evaluate(([px, py]) => {
      const el = document.elementFromPoint(px!, py!) as HTMLElement | null;
      return el?.closest('[data-testid="preview-loading-layer"]') ? 'loader' : ((el?.closest('[data-testid]') as HTMLElement | null)?.dataset.testid ?? el?.tagName ?? null);
    }, [x, y]);
    expect(under).not.toBe('loader');
    await page.mouse.click(x, y);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __clicked: string | null }).__clicked)).toBe(under);
    await page.evaluate(() => window.__allayTest!.simulateLoading(false));
  } finally {
    await stop(ctx);
  }
});

test('工程：保存（Ctrl+S）、新建（Ctrl+N）、打开（Ctrl+O）往返', async () => {
  const projectFile = join(makeUserDataDir(), 'demo.allay');
  const ctx = await start({}, { ALLAY_E2E_PROJECT_PATH: projectFile });
  const { page } = ctx;
  try {
    await page.evaluate(() => window.__allayTest!.setParams({ cols: 20, inPattern: 'diagonal' }));
    await expect(page.getByTestId('project-dirty')).toBeVisible();
    await page.locator('body').focus();
    await page.keyboard.press('Control+KeyS');
    await expect.poll(() => existsSync(projectFile)).toBe(true);
    const saved = JSON.parse(readFileSync(projectFile, 'utf8'));
    expect(saved).toMatchObject({ formatVersion: 1, template: { id: FLAGSHIP }, params: { cols: 20, inPattern: 'diagonal' }, output: { width: 1920, height: 1080, fps: 60 } });
    await expect(page.getByTestId('project-name')).toHaveText('demo');
    await expect(page.getByTestId('project-dirty')).toHaveCount(0);

    await page.keyboard.press('Control+KeyN');
    await expect.poll(async () => (await params(page)).cols).toBe(12);
    await page.keyboard.press('Control+KeyO');
    await expect.poll(async () => (await params(page)).cols).toBe(20);
    expect((await params(page)).inPattern).toBe('diagonal');
    await expect(page.getByTestId('project-name')).toHaveText('demo');
    // 新建时有未保存的改动：先问一句
    await page.evaluate(() => window.__allayTest!.setParams({ cols: 30 }));
    await page.keyboard.press('Control+KeyN');
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await page.getByTestId('confirm-ok').click();
    await expect.poll(async () => (await params(page)).cols).toBe(12);
  } finally {
    await stop(ctx);
    removeUserDataDir(join(projectFile, '..'));
  }
});
