// 官网验收冒烟测试（T-WEB-1 至 T-WEB-7）：覆盖剪辑时间轴导航、3D 体素世界、首屏舞台、剪辑点转场、1:1 真实桌面编辑器试玩台、8 个精选模板、合规声明与窄屏/减动效表现。
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { brandMessages } from '../../packages/ui/src/brand/messages';

const ROOT = resolve(import.meta.dirname, '../..');
const ELECTRON = createRequire(join(ROOT, 'apps/desktop/package.json'))('electron') as string;
const SITE = 'http://localhost:4180/';
const SHOWCASE_COUNT = 8;

const DISCLAIMER_EN = 'NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.';
const DISCLAIMER_ZH = '本软件不是 Minecraft 官方产品，未经 Mojang 或 Microsoft 批准，也与它们无关。';

interface Session {
  app: ElectronApplication;
  page: Page;
  errors: string[];
  userData: string;
}

async function closeSession(session: Session | undefined): Promise<void> {
  if (!session) return;
  await session.app.close().catch(() => undefined);
  rmSync(session.userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

async function launch(width = 1440): Promise<Session> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE' && k !== 'NODE_OPTIONS') env[k] = v;
  env.ALLAY_SITE_URL = SITE;
  env.ALLAY_SITE_WIDTH = String(width);
  const userData = mkdtempSync(join(tmpdir(), 'allay-website-test-'));
  env.ALLAY_SITE_USERDATA = userData;
  const app = await electron.launch({ executablePath: ELECTRON, args: [join(import.meta.dirname, 'electron-main.mjs')], env });
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[console] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  await page.reload();
  await expect(page.getByTestId('site-nav')).toBeVisible();
  return { app, page, errors, userData };
}

async function externalRequests(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => (globalThis as unknown as { externalRequests: string[] }).externalRequests);
}

test.describe.configure({ mode: 'serial' });

let s: Session;

test.beforeAll(async () => {
  s = await launch();
});

test.afterAll(async () => {
  await closeSession(s);
});

test('T-WEB-1 页面加载：时间轴导航、3D 世界、首屏实时舞台与 8 个精选模板封面就绪，无报错、无外部请求', async () => {
  const { page } = s;
  await expect(page.getByTestId('nav-timecode')).toHaveText('00:00:00');
  await expect(page.getByTestId('world')).toBeAttached();

  const hero = page.getByTestId('hero-viewer');
  await expect(hero).toHaveAttribute('data-status', 'ready', { timeout: 60_000 });
  await expect(hero.getByTestId('live-chip')).toHaveCount(SHOWCASE_COUNT);
  await expect(page.getByTestId('template-card')).toHaveCount(SHOWCASE_COUNT);
  await expect(page.getByTestId('templates-more')).toHaveCount(1);

  await expect.poll(() => page.getByTestId('template-sheet').count(), { timeout: 60_000 }).toBe(SHOWCASE_COUNT);

  const mcIndex = join(ROOT, 'apps/website/public/mc/index.json');
  if (existsSync(mcIndex)) {
    const { gameVersion } = JSON.parse(readFileSync(mcIndex, 'utf8')) as { gameVersion: string };
    const note = hero.getByTestId('assets-note');
    await expect(note).toContainText('Mojang');
    await expect(note).toContainText(gameVersion);
  }
  expect(s.errors).toEqual([]);
  expect(await externalRequests(s.app)).toEqual([]);
});

test('T-WEB-2 交互链路：首屏与分镜切换、1:1 真实桌面编辑器试玩台就绪与选模板联动、特性卡交互正常', async () => {
  const { page } = s;
  const hero = page.getByTestId('hero-viewer');
  await expect(hero).toHaveAttribute('data-status', 'ready', { timeout: 60_000 });

  // 1. 首屏切换模板芯片
  const chunkChip = hero.locator('[data-testid="live-chip"][data-template="allay.builtin.chunk-rise"]');
  await chunkChip.dispatchEvent('click');
  await expect(chunkChip).toHaveAttribute('aria-pressed', 'true');

  // 2. 分镜三步标签可手动切换
  const storyTabs = page.getByTestId('story-tab');
  await storyTabs.nth(1).scrollIntoViewIfNeeded();
  await storyTabs.nth(1).click();
  await expect(page.getByTestId('tune-panel')).toBeVisible();
  await storyTabs.nth(2).click();
  await chunkChip.click();
  await expect(chunkChip).toHaveAttribute('aria-pressed', 'true');

  // 3. 1:1 真实桌面编辑器试玩台：滚入视口后自动装载桌面渲染进程并就绪，支持上方快捷切模板
  const simWindow = page.getByTestId('sim-window');
  await simWindow.scrollIntoViewIfNeeded();
  await expect(page.getByTestId('sim-frame')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('sim-skeleton')).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId('sim-quick-pick')).toHaveCount(SHOWCASE_COUNT);

  const simRoot = page.frameLocator('[data-testid="sim-frame"]').locator('#root');
  await expect(simRoot).not.toBeEmpty();

  const iceQuick = page.locator('[data-testid="sim-quick-pick"][data-template="allay.builtin.ice-shatter"]');
  await iceQuick.click();
  await expect(iceQuick).toHaveAttribute('aria-pressed', 'true');

  // 4. 模板精选卡片点击右上角按钮同步将模板送入上方真实桌面编辑器试玩台
  const punchOpen = page.locator('[data-testid="template-card"][data-template="allay.builtin.block-punch"] [data-testid="template-open"]');
  await punchOpen.scrollIntoViewIfNeeded();
  await punchOpen.click();
  await expect(page.locator('[data-testid="sim-quick-pick"][data-template="allay.builtin.block-punch"]')).toHaveAttribute('aria-pressed', 'true');

  // 5. 特性卡交互：透明对比滑块 & 资源栈图层点击锁定
  const alphaSplit = page.getByTestId('alpha-split');
  await alphaSplit.scrollIntoViewIfNeeded();
  await alphaSplit.fill('28');
  await expect(alphaSplit).toHaveValue('28');

  const layerZero = page.locator('[data-testid="stack-layer"][data-layer="0"]');
  await layerZero.click();
  await expect(layerZero).toHaveAttribute('aria-pressed', 'true');
});

test('T-WEB-3 剪辑点接缝：快速滚过剪辑点后自动落定终态并显露开场白，不遮挡后续点击', async () => {
  const { page } = s;
  const cut = page.locator('#cut');
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.waitForTimeout(100);
  await page.locator('#templates').scrollIntoViewIfNeeded();
  await expect(cut).toHaveAttribute('data-settled', 'true', { timeout: 10_000 });
  await expect(page.locator('#cut-title')).toBeVisible();
  const overlay = page.getByTestId('cut-overlay');
  await expect(overlay).toHaveAttribute('data-active', 'false');
});

test('T-WEB-4 中英文和深浅色主题（含 View Transitions 光圈擦除）切换正常，无缺失文案键', async () => {
  const { page } = s;
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  const lang0 = await page.evaluate(() => document.documentElement.lang);
  const title0 = await page.locator('h1').innerText();
  for (let round = 0; round < 2; round++) {
    await page.getByTestId('toggle-language').click();
    const lang = round === 0 ? (lang0 === 'en' ? 'zh-CN' : 'en') : lang0;
    await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe(lang);
    if (round === 0) expect(await page.locator('h1').innerText()).not.toBe(title0);
  }
  expect(await page.evaluate(() => (window as unknown as { __siteMissingKeys: Set<string> }).__siteMissingKeys.size)).toBe(0);

  const theme0 = await page.evaluate(() => document.documentElement.dataset.theme);
  const bg0 = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  for (let round = 0; round < 2; round++) {
    await page.getByTestId('toggle-theme').click();
    const theme = round === 0 ? (theme0 === 'dark' ? 'light' : 'dark') : theme0;
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
    if (round === 0) await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe(bg0);
  }
});

test('T-WEB-5 非官方声明逐字醒目、正文不写模板数量、开发者头像均为同源实图且页尾字标可读', async () => {
  const { page } = s;
  for (let round = 0; round < 2; round++) {
    const lang = (await page.evaluate(() => document.documentElement.lang)) as 'zh-CN' | 'en';
    const text = await page.locator('main').innerText();
    expect(text).not.toMatch(/\d+\s*个(内置)?模板|\d+\s+(built-in\s+)?templates/i);

    const box = page.getByTestId('disclaimer');
    await box.scrollIntoViewIfNeeded();
    await expect(box).toBeVisible();
    const disc = await box.innerText();
    expect(disc).toBe(brandMessages[lang].disclaimer);
    expect(disc).toContain(DISCLAIMER_EN);
    if (lang === 'zh-CN') expect(disc).toContain(DISCLAIMER_ZH);
    expect(await box.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(13);

    await page.getByTestId('toggle-language').click();
    await expect.poll(() => page.evaluate(() => document.documentElement.lang)).not.toBe(lang);
  }

  await expect(page.locator('[data-voxel-wordmark]')).toContainText('Allay Motion');

  const avatars = page.getByTestId('avatar');
  await expect(avatars).toHaveCount(3);
  await page.getByTestId('team').scrollIntoViewIfNeeded();
  for (const img of await avatars.all()) {
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThanOrEqual(128);
    expect(await img.evaluate((el) => new URL((el as HTMLImageElement).src).origin === location.origin)).toBe(true);
  }
});

test('T-WEB-6 窄屏（390px）单行顶栏无横向溢出，自动切换紧凑试玩台、模板卡片能送模板进紧凑预览，无报错、无外部请求', async () => {
  const narrow = await launch(390);
  try {
    const { page } = narrow;
    const hero = page.getByTestId('hero-viewer');
    await expect(hero).toHaveAttribute('data-status', 'ready', { timeout: 60_000 });
    const chip = hero.locator('[data-testid="live-chip"][data-template="allay.builtin.item-stinger"]');
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('sim-compact')).toBeVisible();
    // 窄屏没有仿真器窗口：模板卡片的按钮把模板送进紧凑预览，并滚到预览
    const punchOpen = page.locator('[data-testid="template-card"][data-template="allay.builtin.block-punch"] [data-testid="template-open"]');
    await punchOpen.scrollIntoViewIfNeeded();
    await punchOpen.click();
    const compact = page.getByTestId('compact-viewer');
    await expect(compact.locator('[data-testid="live-chip"][data-template="allay.builtin.block-punch"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(compact).toBeInViewport();
    await page.getByTestId('site-footer').scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    expect(narrow.errors).toEqual([]);
    expect(await externalRequests(narrow.app)).toEqual([]);
  } finally {
    await closeSession(narrow);
  }
});

test('T-WEB-7 减少动效与字体拦截、rAF 停跑时，无剪辑盖层且各级标题立即可见', async () => {
  const bad = await launch();
  try {
    const { page } = bad;
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.route(/\.woff2?(\?|$)/, (r) => r.abort());
    await page.addInitScript(() => {
      window.requestAnimationFrame = () => 0;
    });
    await page.reload();
    await expect(page.getByTestId('site-nav')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.dataset.reducedMotion)).toBe('true');
    await expect(page.getByTestId('cut-overlay')).toHaveCount(0);

    await expect(page.locator('h1')).toBeVisible();
    for (const h of await page.locator('h1, h2').all()) {
      await h.scrollIntoViewIfNeeded();
      await expect(h).toBeVisible();
      const hidden = await h.evaluate((el) => {
        const cs = getComputedStyle(el);
        return cs.opacity === '0' || cs.visibility === 'hidden' || el.closest('[data-armed="true"][data-shown="false"]') !== null;
      });
      expect(hidden).toBe(false);
    }
    expect(bad.errors.filter((e) => !/woff2?|Failed to load resource|net::ERR_FAILED/.test(e))).toEqual([]);
  } finally {
    await closeSession(bad);
  }
});
