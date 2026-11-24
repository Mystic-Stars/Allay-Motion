// 官网的冒烟测试（T-WEB-*，docs/decisions.md 官网）。在 Electron 自带的 Chromium 里打开 vite preview 起的构建产物，窗口不显示。
// 仿真器 iframe 带 ?e2e，里面装着桌面版同一套测试钩子（window.__allayTest），用它读预览画布的像素。
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Frame, type Locator, type Page } from '@playwright/test';
import { brandMessages } from '../../packages/ui/src/brand/messages';
import { isSoftwareRenderer } from '../engine/software';

const ROOT = resolve(import.meta.dirname, '../..');
const ELECTRON = createRequire(join(ROOT, 'apps/desktop/package.json'))('electron') as string;
const SITE = 'http://localhost:4180/?e2e';
/** docs/09-compliance.md 9.5 的原文 */
const DISCLAIMER_EN = 'NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.';
const DISCLAIMER_ZH = '本软件不是 Minecraft 官方产品，未经 Mojang 或 Microsoft 批准，也与它们无关。';

/** packages/templates 下的内置模板个数（仿真器的模板库、预览的模板按钮要一个不少） */
const TEMPLATE_COUNT = readdirSync(join(ROOT, 'packages/templates')).filter((d) => existsSync(join(ROOT, 'packages/templates', d, 'manifest.json'))).length;
/** 落地页的模板一节只展示精选的前几个（apps/website/src/site/components/TemplatesSection.tsx 的 SHOWCASE_MAX） */
const SHOWCASE_MAX = 5;
const SHOWN = Math.min(TEMPLATE_COUNT, SHOWCASE_MAX);

interface Session {
  app: ElectronApplication;
  page: Page;
  errors: string[];
  userData: string;
}

/** 关掉 Electron 并删掉这一次的用户数据目录（每次约 25 MB，不能留在临时目录里） */
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
  // 页面和 iframe 里的报错都算（Worker 里的错误会经 EngineHost 变成页面上的报错或警告）
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[console] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  // 监听装上之后从头再载一次，开头的报错也收得到
  await page.reload();
  await expect(page.getByTestId('site-nav')).toBeVisible();
  return { app, page, errors, userData };
}

async function externalRequests(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => (globalThis as unknown as { externalRequests: string[] }).externalRequests);
}

/** 慢慢滚到页底（让懒加载的部分、过场、出场都走一遍） */
async function scrollThrough(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const step = Math.round(window.innerHeight * 0.6);
    for (let y = 0; y <= document.documentElement.scrollHeight; y += step) {
      window.scrollTo({ top: y, behavior: 'instant' });
      await new Promise((r) => setTimeout(r, 180));
    }
  });
}

async function simulator(page: Page): Promise<Frame> {
  await page.evaluate(() => document.getElementById('try')?.scrollIntoView({ behavior: 'instant' }));
  await expect(page.getByTestId('sim-frame')).toBeVisible({ timeout: 30_000 });
  let frame: Frame | undefined;
  await expect.poll(() => (frame = page.frames().find((f) => f.url().includes('simulator.html'))) !== undefined).toBe(true);
  await expect.poll(() => frame!.evaluate(() => window.__allayTest?.status().kind ?? 'none'), { timeout: 60_000 }).toBe('ready');
  // iframe 里的元素 Playwright 只会在 iframe 内滚动：先把整个窗口外框滚到视口中间
  await page.getByTestId('sim-window').evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  return frame!;
}

async function upToDate(frame: Frame): Promise<void> {
  await expect.poll(() => frame.evaluate(() => window.__allayTest!.previewUpToDate() && window.__allayTest!.status().kind === 'ready'), { timeout: 30_000 }).toBe(true);
}

/** 预览画布在整段里几个时刻的像素摘要 */
async function sample(frame: Frame): Promise<string> {
  const tr = await frame.evaluate(() => window.__allayTest!.transport());
  const times = [0.2, 0.35, 0.5, 0.65, 0.8].map((k) => k * tr.duration);
  return frame.evaluate(async (ts) => (await Promise.all(ts.map((t) => window.__allayTest!.previewHash(t)))).join(','), times);
}

test.describe.configure({ mode: 'serial' });

let s: Session;
let wideClosed = false;

async function closeWideSession(): Promise<void> {
  if (wideClosed) return;
  await closeSession(s);
  wideClosed = true;
}

test.beforeAll(async () => {
  s = await launch();
});

test.afterAll(async () => {
  await closeWideSession();
});

test('T-WEB-1 页面能加载：首屏实时预览就绪，模板按钮一个不少、模板一节只放精选，滚完全页无报错、无外部请求', async () => {
  const { page } = s;
  await expect(page.getByTestId('hero-viewer')).toHaveAttribute('data-status', 'ready', { timeout: 60_000 });
  await expect(page.getByTestId('template-card')).toHaveCount(SHOWN);
  await expect(page.getByTestId('templates-more')).toHaveCount(1);
  await expect(page.getByTestId('live-chip')).toHaveCount(TEMPLATE_COUNT);
  await scrollThrough(page);
  // 小格里的帧由封面服务渲染（不是截图）；精选的大格由引擎实时渲染（离开视口远了就销毁、退回封面的帧，所以这里至少 SHOWN − 1 个）
  await expect.poll(() => page.getByTestId('template-sheet').count(), { timeout: 90_000 }).toBeGreaterThanOrEqual(SHOWN - 1);
  await page.evaluate(() => document.getElementById('templates')?.scrollIntoView({ behavior: 'instant' }));
  await expect(page.getByTestId('template-live')).toHaveAttribute('data-live', 'true', { timeout: 30_000 });
  // 用了官网专用的原版贴图时，页面上写明来源和版权（docs/decisions.md 官网 · 原版素材）
  const mcIndex = join(ROOT, 'apps/website/public/mc/index.json');
  if (existsSync(mcIndex)) {
    const { gameVersion } = JSON.parse(readFileSync(mcIndex, 'utf8')) as { gameVersion: string };
    const note = page.getByTestId('assets-note').first();
    await expect(note).toContainText('Mojang');
    await expect(note).toContainText(gameVersion);
  }
  expect(s.errors).toEqual([]);
  expect(await externalRequests(s.app)).toEqual([]);
});

test('T-WEB-2 仿真器挂载桌面版编辑器，预览画布由真实引擎渲染出非空画面', async () => {
  const frame = await simulator(s.page);
  await upToDate(frame);
  // 桌面版的界面：顶栏、模板库、属性面板、时间轴都在
  for (const id of ['topbar', 'param-panel', 'topbar-export']) await expect(frame.getByTestId(id)).toBeVisible();
  const tr = await frame.evaluate(() => window.__allayTest!.transport());
  let maxAlpha = 0;
  for (const k of [0.25, 0.5, 0.75]) maxAlpha = Math.max(maxAlpha, (await frame.evaluate((t) => window.__allayTest!.previewStats(t), k * tr.duration)).maxAlpha);
  expect(maxAlpha).toBeGreaterThan(0);
  // 模板库里也是全部内置模板
  const builtins = (await frame.evaluate(() => window.__allayTest!.templates())).filter((e) => e.source === 'builtin');
  expect(builtins).toHaveLength(TEMPLATE_COUNT);
});

test('T-WEB-11 仿真器进入视口就从剪辑点循环播放，画面不是空的；鼠标在预览区上滚轮，落地页照常滚动', async () => {
  const { page } = s;
  const frame = await simulator(page);
  await upToDate(frame);
  await expect.poll(() => frame.evaluate(() => window.__allayTest!.transport().playing), { timeout: 10_000 }).toBe(true);
  const tr = await frame.evaluate(() => window.__allayTest!.transport());
  expect(tr.time).toBeGreaterThan(0);
  expect((await frame.evaluate((t) => window.__allayTest!.previewStats(t), tr.cutTime ?? tr.duration / 2)).maxAlpha).toBeGreaterThan(0);

  // 预览区中央滚两格：落地页往下走，不被 iframe 吃掉
  const stage = frame.getByTestId('preview-stage');
  const box = await stage.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  const y0 = await page.evaluate(() => window.scrollY);
  await page.mouse.wheel(0, 240);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(y0 + 100);
  await page.mouse.wheel(0, -240);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(y0 + 100);

  // 滚出视口就暂停（不占显卡），滚回来接着播
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await expect.poll(() => frame.evaluate(() => window.__allayTest!.transport().playing)).toBe(false);
  await simulator(page);
  await expect.poll(() => frame.evaluate(() => window.__allayTest!.transport().playing)).toBe(true);
});

test('T-WEB-3 切换模板、拖动参数后画面变化（仿真器与首屏预览）', async () => {
  const { page } = s;
  const frame = await simulator(page);
  await upToDate(frame);
  const before = await sample(frame);

  // 在模板库里点另一个模板
  const target = 'allay.builtin.pixel-dissolve';
  await frame.getByTestId(`template-${target}`).click();
  await expect.poll(() => frame.evaluate(() => window.__allayTest!.project().ref?.id)).toBe(target);
  await upToDate(frame);
  const switched = await sample(frame);
  expect(switched).not.toBe(before);

  // 在属性面板里按住一个数值框往右拖（数值框即滑块）
  const inputs = frame.locator('[data-testid="param-panel"] input[inputmode]');
  expect(await inputs.count()).toBeGreaterThan(0);
  let changed = false;
  for (let i = 0; i < Math.min(await inputs.count(), 4) && !changed; i++) {
    const input = inputs.nth(i);
    await input.scrollIntoViewIfNeeded();
    const box = await input.boundingBox();
    if (!box) continue;
    const rev = await frame.evaluate(() => window.__allayTest!.project().revision);
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width * 0.3, y);
    await page.mouse.down();
    for (let k = 1; k <= 8; k++) await page.mouse.move(box.x + box.width * 0.3 + k * 12, y);
    await page.mouse.up();
    await expect.poll(() => frame.evaluate(() => window.__allayTest!.project().revision)).toBeGreaterThan(rev);
    await upToDate(frame);
    changed = (await sample(frame)) !== switched;
  }
  expect(changed).toBe(true);

  // 首屏的实时预览：点模板按钮，换成那个模板（面板在首屏斜躺着、按钮可能在折线以下：直接派发点击，不让测试替它滚动）
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  const chip = page.locator(`[data-testid="hero-viewer"] [data-testid="live-chip"][data-template="allay.builtin.block-fall"]`).first();
  await chip.evaluate((el) => (el as HTMLButtonElement).click());
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('live-template-name').first()).toHaveText(/方块坠落|Block fall/);
});

test('T-WEB-4 两种语言、两种主题都能切换，仿真器跟着变，没有缺失的文案', async () => {
  const { page } = s;
  const frame = await simulator(page);
  const lang0 = await page.evaluate(() => document.documentElement.lang);
  const title0 = await page.locator('h1').innerText();
  for (let round = 0; round < 2; round++) {
    await page.getByTestId('toggle-language').click();
    const lang = round === 0 ? (lang0 === 'en' ? 'zh-CN' : 'en') : lang0;
    await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe(lang);
    if (round === 0) expect(await page.locator('h1').innerText()).not.toBe(title0);
    // 仿真器里桌面版的界面也换了语言
    await expect(frame.getByTestId('topbar-export')).toHaveText(lang === 'en' ? /Export/ : /导出/);
  }
  expect(await page.evaluate(() => (window as unknown as { __siteMissingKeys: Set<string> }).__siteMissingKeys.size)).toBe(0);
  expect(await frame.evaluate(() => window.__allayTest!.missingKeys())).toEqual([]);

  const theme0 = await page.evaluate(() => document.documentElement.dataset.theme);
  const bg0 = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  for (let round = 0; round < 2; round++) {
    await page.getByTestId('toggle-theme').click();
    const theme = round === 0 ? (theme0 === 'dark' ? 'light' : 'dark') : theme0;
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
    await expect.poll(() => frame.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
    if (round === 0) expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe(bg0);
  }
});

test('T-WEB-5 非官方声明逐字、醒目地出现（两种语言）', async () => {
  const { page } = s;
  for (let round = 0; round < 2; round++) {
    const lang = (await page.evaluate(() => document.documentElement.lang)) as 'zh-CN' | 'en';
    const box = page.getByTestId('disclaimer');
    await box.scrollIntoViewIfNeeded();
    await expect(box).toBeVisible();
    const text = await box.innerText();
    expect(text).toBe(brandMessages[lang].disclaimer);
    expect(text).toContain(DISCLAIMER_EN);
    if (lang === 'zh-CN') expect(text).toContain(DISCLAIMER_ZH);
    // 醒目：不是缩成很小的字
    expect(await box.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(13);
    await page.getByTestId('toggle-language').click();
    await expect.poll(() => page.evaluate(() => document.documentElement.lang)).not.toBe(lang);
  }
});

test('T-WEB-6 仿真导出：走一遍真实的导出对话框和进度，结束时给出下载桌面版的引导', async () => {
  const { page } = s;
  const frame = await simulator(page);
  await upToDate(frame);
  await frame.getByTestId('topbar-export').click();
  await frame.getByTestId('export-start').click();
  const card = page.getByTestId('sim-export-done');
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card.locator('a[href="https://github.com/Mystic-Stars/Allay-Motion"]')).toBeVisible();
  // 应用自己的完成页如实说明没有写出文件
  await expect(frame.getByTestId('export-path')).toBeVisible();
  await card.getByRole('button').first().click();
  await expect(card).toBeHidden();
});

test('T-WEB-8 减少动效：没有出场动画和剪辑点的转场，悦灵不飞，内容一开始就完整可读', async () => {
  const { page } = s;
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await expect(page.getByTestId('site-nav')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.dataset.reducedMotion)).toBe('true');
  await scrollThrough(page);
  // 没有剪辑点的整幅转场，没有武装着的出场动画；剪辑点的开场白一直可见
  await expect(page.getByTestId('cut-overlay')).toHaveCount(0);
  await expect(page.locator('[data-armed="true"][data-shown="false"]')).toHaveCount(0);
  for (const h of await page.locator('h1, h2').all()) await expect(h).toBeVisible();
  // 悦灵静止（跟着页面走，不在固定层里飞）
  const guide = page.getByTestId('allay-guide');
  if ((await guide.count()) > 0) expect(await guide.evaluate((el) => getComputedStyle(el).position)).toBe('absolute');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
});

/** 剪辑点这一节的状态：idle（等着）/ playing（在播）/ done（播完） */
const cutState = (page: Page) => page.evaluate(() => document.getElementById('cut')?.dataset.cutState ?? 'none');

test('T-WEB-12 剪辑点：往下越过分界线时自动完整播一遍（引擎实时渲染，剪辑点那一帧铺满），停手也播完；快速跳过直接落到终态', async () => {
  const { page } = s;
  // 从一次干净的载入开始（前一条测试切换过减少动效）
  await page.reload();
  await expect(page.getByTestId('site-nav')).toBeVisible();
  const scrollToCut = (offset: number) => page.locator('#cut').evaluate((section, offset) => {
    window.scrollTo({ top: section.getBoundingClientRect().top + window.scrollY + window.innerHeight * offset, behavior: 'instant' });
  }, offset);
  const overlay = page.getByTestId('cut-overlay');
  const title = page.locator('#cut-title');
  // 提前三屏启动引擎
  await scrollToCut(-3);
  await expect.poll(() => page.evaluate(() => 'coverage' in ((window as unknown as { __siteCut?: object }).__siteCut ?? {})), { timeout: 60_000 }).toBe(true);
  // 剪辑点那一帧画面铺满（读引擎像素，不透明比例 > 97%）
  const coverage = await page.evaluate(async () => {
    const c = (window as unknown as { __siteCut: { cutTime: number; coverage: (t: number) => Promise<number> } }).__siteCut;
    return c.coverage(c.cutTime);
  });
  expect(coverage).toBeGreaterThan(0.97);
  // 停在分界线前，用滚轮滚一格越过它，然后停手：自动开始播，约 1.5 秒内播完，开场白显示出来
  await scrollToCut(-0.85);
  await expect.poll(() => cutState(page)).toBe('idle');
  await page.mouse.move(700, 450);
  // 播放状态只有约 1.5 秒；在滚轮输入前监听，避免软件渲染时跨进程轮询漏掉中间状态。
  await page.locator('#cut').evaluate((section) => {
    const overlay = section.querySelector('[data-testid="cut-overlay"]')!;
    const observed = new Set<string>();
    const observer = new MutationObserver((records) => {
      for (const record of records) if (record.oldValue !== null) observed.add(`${record.attributeName}:${record.oldValue}`);
      observed.add(`data-cut-state:${section.getAttribute('data-cut-state')}`);
      observed.add(`data-active:${overlay.getAttribute('data-active')}`);
      if (section.getAttribute('data-cut-state') === 'done') observer.disconnect();
    });
    observer.observe(section, { attributes: true, attributeFilter: ['data-cut-state', 'data-active'], attributeOldValue: true, subtree: true });
    (window as unknown as { __cutObserved: Set<string> }).__cutObserved = observed;
  });
  await page.mouse.wheel(0, 120);
  await expect.poll(() => cutState(page), { timeout: 10_000 }).toBe('done');
  expect(await page.evaluate(() => [...(window as unknown as { __cutObserved: Set<string> }).__cutObserved])).toEqual(
    expect.arrayContaining(['data-cut-state:playing', 'data-active:true']),
  );
  await expect(overlay).toHaveAttribute('data-active', 'false');
  await expect(title).toBeVisible();
  // 往回滚到这一节完全在视口下方：复位；再一步跳过整节（像拖滚动条）：不补播，直接是终态
  await scrollToCut(-1.5);
  await expect.poll(() => cutState(page)).toBe('idle');
  await scrollToCut(1.2);
  await expect.poll(() => cutState(page)).toBe('done');
  await expect(overlay).toHaveAttribute('data-active', 'false');
  await expect(title).toBeVisible();
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
});

async function worldUsesSoftwareRenderer(world: Locator): Promise<boolean> {
  const renderer = await world.evaluate((canvas: HTMLCanvasElement) => {
    const gl = canvas.getContext('webgl2');
    if (!gl) return '';
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    return String(gl.getParameter(debugInfo?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER));
  });
  return isSoftwareRenderer(renderer);
}

test('T-WEB-15 滚动手感：滚轮一格一格地滚、连按 PageDown、点导航锚点跳转，每次停手后各段都落到完整的终态', async () => {
  const { page } = s;
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await expect(page.getByTestId('hero-viewer')).toHaveAttribute('data-status', 'ready', { timeout: 60_000 });
  const software = await worldUsesSoftwareRenderer(page.getByTestId('world'));
  // 软件渲染下每次输入与取样都更慢，同时保留实际落定的断言。
  if (software) test.setTimeout(300_000);
  const settleTimeout = software ? 12_000 : 3000;
  /** 页面上所有带 data-motion 的段落（首屏到分镜的主视觉、剪辑点、导航的播放头）都已落到终态 */
  const unsettled = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-motion]')].filter((e) => e.dataset.settled !== 'true').map((e) => e.dataset.motion));
  await page.mouse.move(700, 450);
  // 滚轮：每次 100 px、间隔 250 ms，每滚 4 格停一下。
  const total = await page.evaluate(() => document.documentElement.scrollHeight);
  let y = 0;
  for (let i = 1; y < total * 0.55; i++) {
    await page.mouse.wheel(0, 100);
    await page.waitForTimeout(250);
    if (i % 4 === 0) {
      if (software) await expect.poll(unsettled, { timeout: settleTimeout, message: `滚轮 scrollY ${y}` }).toEqual([]);
      else {
        await page.waitForTimeout(2000);
        expect(await unsettled(), `滚轮 scrollY ${y}`).toEqual([]);
      }
    }
    y = await page.evaluate(() => window.scrollY);
  }
  // PageDown 连按：大步跳过若干节，停手后全部落定（不排队补播）。
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.waitForTimeout(1500);
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('PageDown');
    await page.waitForTimeout(80);
  }
  await expect.poll(unsettled, { timeout: settleTimeout, message: '连按 PageDown 后仍在播放的段落' }).toEqual([]);
  // 导航锚点跳转（从页首直接跳到模板一节，越过分镜和剪辑点）：落到终态，剪辑点是“播完”而不是在播
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.waitForTimeout(2000);
  await page.locator('a[data-clip-link][href="#templates"]').click();
  // 先等锚点的平滑滚动停下（“停手后”从这里算起），再看各段是不是终态
  await expect
    .poll(
      async () => {
        const a = await page.evaluate(() => window.scrollY);
        await page.waitForTimeout(250);
        return a > 0 && a === (await page.evaluate(() => window.scrollY));
      },
      { timeout: 6000 },
    )
    .toBe(true);
  await expect.poll(unsettled, { timeout: settleTimeout, message: '导航跳转后仍在播放的段落' }).toEqual([]);
  expect(await cutState(page)).toBe('done');
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
});

test('T-WEB-13 悦灵：首屏是方块拼成的体素悦灵，往下由带路的悦灵（应用的烘焙图集）接着飞；滚完全页任何时刻页面上最多一只全身悦灵', async () => {
  const { page } = s;
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await expect(page.getByTestId('hero-viewer')).toHaveAttribute('data-status', 'ready', { timeout: 60_000 });
  const guide = page.getByTestId('allay-guide');
  await expect(guide).toHaveAttribute('data-granted', 'true', { timeout: 15_000 });
  // 3D 世界装好图集后，带路的悦灵由世界来画（应用同一份烘焙图集）；世界没起来时是 DOM 里的 <Allay>
  await expect(guide).toHaveAttribute('data-render', '3d', { timeout: 20_000 });
  /** 页面上画着的全身悦灵：DOM 里的 + 世界里带路的那一只（出场时）+ 首屏方块拼成的体素悦灵（拼着或拼好时） */
  const count = () =>
    page.evaluate(() => {
      const g = document.querySelector<HTMLElement>('[data-testid="allay-guide"]');
      const in3d = g?.dataset.render === '3d' && g.dataset.shown === 'true' ? 1 : 0;
      const voxel = document.querySelector<HTMLElement>('[data-testid="world"]')?.dataset.sculpture === 'true' ? 1 : 0;
      const dom = [...document.querySelectorAll('[data-allay="body"]')]
        .filter((e) => {
          if (!e.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
          const { top, bottom, left, right } = e.getBoundingClientRect();
          return bottom > 0 && top < innerHeight && right > 0 && left < innerWidth;
        })
        .map((e) => e.closest<HTMLElement>('[data-testid]')?.dataset.testid ?? '?');
      return { n: dom.length + in3d + voxel, what: `y=${Math.round(window.scrollY)} dom=[${dom.join(',')}] guide3d=${in3d} voxel=${voxel}` };
    });
  let max = 0;
  let worst = '';
  const total = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < total; y += 450) {
    await page.evaluate((v) => window.scrollTo({ top: v, behavior: 'instant' }), y);
    await page.waitForTimeout(120);
    const c = await count();
    if (c.n > max) {
      max = c.n;
      worst = c.what;
    }
  }
  expect(max, worst).toBeLessThanOrEqual(1);
  // 悦灵不挡点击
  expect(await guide.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
});

/**
 * 体素悦灵的颜色逐像素取自原版悦灵贴图（官网的 public/mc/ 里有才拼）。测试不依赖它：没有时先检查退路，
 * 再在页面里画一张合成的 32×32 贴图（不是原版文件）交给世界，把体素悦灵这条路走一遍。
 */
async function ensureVoxelAllay(page: Page): Promise<void> {
  const world = page.getByTestId('world');
  await expect(world).toHaveAttribute('data-allay-voxels', /ready|missing/, { timeout: 20_000 });
  if ((await world.getAttribute('data-allay-voxels')) === 'ready') return;
  const ok = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 32;
    c.height = 32;
    const g = c.getContext('2d')!;
    for (let i = 0; i < 1024; i++) {
      g.fillStyle = `hsl(${(i * 47) % 360} 60% ${40 + (i % 5) * 8}%)`;
      g.fillRect(i % 32, Math.floor(i / 32), 1, 1);
    }
    const b64 = c.toDataURL('image/png').split(',')[1]!;
    return (window as unknown as { __siteWorld: { setAllayTexture: (b: string) => Promise<boolean> } }).__siteWorld.setAllayTexture(b64);
  });
  expect(ok).toBe(true);
}

test('T-WEB-16 画布：全页一块共用的 3D 方块世界，背景方块在首屏可见；首屏拼成体素悦灵（没有原版贴图时不拼、带路悦灵照常），剪辑点、开源各拼出一件，页尾字标由方块拼好（字仍在只变透明），停手后落定', async () => {
  const { page } = s;
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  const world = page.getByTestId('world');
  await expect(world).toHaveCount(1);
  expect(await world.evaluate((el) => getComputedStyle(el).position)).toBe('fixed');
  expect(await world.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
  expect(Number(await world.getAttribute('data-instances'))).toBeGreaterThan(3000);
  // 背景的方块（用户说“挺不错”的那一版）还在：首屏能看到能抓的方块
  await expect(world).toHaveAttribute('data-settled', 'true', { timeout: 20_000 });
  const visibleBlocks = await page.evaluate(() => (window as unknown as { __siteWorld: { blocks: () => unknown[] } }).__siteWorld.blocks().length);
  expect(visibleBlocks).toBeGreaterThan(0);
  // 没有原版悦灵贴图：不拿近似的颜色凑，首屏散成细尘，带路的悦灵照常飞到首屏的锚点
  await expect(world).toHaveAttribute('data-allay-voxels', /ready|missing/, { timeout: 20_000 });
  if ((await world.getAttribute('data-allay-voxels')) === 'missing') {
    await expect(world).toHaveAttribute('data-form', 'rest');
    await expect(page.getByTestId('allay-guide')).toHaveAttribute('data-shown', 'true', { timeout: 6000 });
  }
  // 有贴图（或换上合成贴图）：方块拼成体素悦灵并落定，它在场时带路的悦灵不出场
  await ensureVoxelAllay(page);
  await expect(world).toHaveAttribute('data-form', 'allay', { timeout: 6000 });
  await expect(world).toHaveAttribute('data-settled', 'true', { timeout: 6000 });
  await expect(page.getByTestId('allay-guide')).toHaveAttribute('data-shown', 'false', { timeout: 3000 });
  // 往下各节：占位框露出来时重组成那一节的那一件（触发后自己播完），停手后落定
  for (const [slot, form] of [
    ['cut', 'cut'],
    ['timeline', 'timeline'],
  ] as const) {
    await page.locator(`[data-voxel-slot="${slot}"]`).evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await expect(world).toHaveAttribute('data-form', form, { timeout: 5000 });
    await expect(world).toHaveAttribute('data-settled', 'true', { timeout: 5000 });
  }
  // 页尾：字标由背景的方块拼好（DOM 里的字仍在，只变透明）
  const mark = page.locator('[data-voxel-wordmark]');
  await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
  await expect(mark).toHaveAttribute('data-voxel-ready', 'true', { timeout: 5000 });
  expect((await mark.textContent())?.trim().length).toBeGreaterThan(0);
  await expect(world).toHaveAttribute('data-settled', 'true', { timeout: 6000 });
  // 回到首屏：重新拼回体素悦灵，字标的字恢复显示
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await expect(mark).toHaveAttribute('data-voxel-ready', 'false');
  await expect(world).toHaveAttribute('data-form', 'allay', { timeout: 5000 });
  await expect(world).toHaveAttribute('data-settled', 'true', { timeout: 6000 });
});

test('T-WEB-17 体素雕塑能玩（真实的鼠标输入）：划过拨开方块、在雕塑上光标可抓、按住拖动转它松手弹回、点空白处放冲击波、点在字上不算', async () => {
  const { page } = s;
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await ensureVoxelAllay(page);
  const world = page.getByTestId('world');
  await expect(world).toHaveAttribute('data-form', 'allay', { timeout: 20_000 });
  await expect(world).toHaveAttribute('data-settled', 'true', { timeout: 6000 });
  type W = { stir: () => number; yaw: () => number };
  const stir = () => page.evaluate(() => (window as unknown as { __siteWorld: W }).__siteWorld.stir());
  const yaw = () => page.evaluate(() => (window as unknown as { __siteWorld: W }).__siteWorld.yaw());
  const shocks = async () => Number((await world.getAttribute('data-shocks')) ?? 0);
  const box = (await page.locator('[data-voxel-slot="allay"]').boundingBox())!;
  const cy = box.y + box.height / 2;
  // 停着不动：只有指针所在处的一点凹陷
  await page.mouse.move(20, 880);
  await page.waitForTimeout(1800);
  const idle = await stir();
  // 快速划过悦灵：留下一道拨开的轨迹（轨迹的总强度明显上去），一秒多以后流回原位
  await page.mouse.move(box.x - 40, cy);
  await page.evaluate(() => {
    const root = window as unknown as { __siteWorld: { stir: () => number }; __stirProbe: { peak: number; frame: number } };
    const probe = { peak: root.__siteWorld.stir(), frame: 0 };
    const sample = () => {
      probe.peak = Math.max(probe.peak, root.__siteWorld.stir());
      probe.frame = requestAnimationFrame(sample);
    };
    root.__stirProbe = probe;
    probe.frame = requestAnimationFrame(sample);
  });
  await page.mouse.move(box.x + box.width + 40, cy + 20, { steps: 14 });
  const peak = await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const probe = (window as unknown as { __stirProbe: { peak: number; frame: number } }).__stirProbe;
    cancelAnimationFrame(probe.frame);
    return probe.peak;
  });
  expect(peak).toBeGreaterThan(idle + 0.4);
  await expect.poll(stir, { timeout: 3000 }).toBeLessThan(idle + 0.2);
  // 指针在雕塑的框里：光标是“可抓”
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.3, { steps: 5 });
  await expect(page.locator('html')).toHaveAttribute('data-world-hover', 'true');
  expect(await page.evaluate(() => getComputedStyle(document.body).cursor)).toBe('grab');
  // 按住拖动：雕塑跟着转（按下的那一下也放出一圈冲击波）；松手后弹回
  await page.waitForTimeout(800);
  const yaw0 = await yaw();
  const n0 = await shocks();
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 240, box.y + box.height * 0.3, { steps: 16 });
  expect(await page.evaluate(() => document.documentElement.dataset.worldDrag)).toBe('true');
  await expect.poll(async () => Math.abs((await yaw()) - yaw0), { timeout: 4000 }).toBeGreaterThan(0.8);
  expect(await shocks()).toBe(n0 + 1);
  await page.mouse.up();
  expect(await page.evaluate(() => document.documentElement.dataset.worldDrag)).toBe('false');
  await expect.poll(async () => Math.abs((await yaw()) - yaw0), { timeout: 4000 }).toBeLessThan(0.4);
  // 点在字上不放冲击波；点在空白处（雕塑的框里，背景方块给它让了位）放
  const h1 = (await page.locator('h1').first().boundingBox())!;
  await page.mouse.click(h1.x + 30, h1.y + 30);
  expect(await shocks()).toBe(n0 + 1);
  await page.mouse.click(box.x + 12, box.y + box.height - 12);
  expect(await shocks()).toBe(n0 + 2);
});

test('T-WEB-19 背景方块（真实的鼠标输入）：按住拖到与另一块平齐的旁边，另一块被吸过来贴成一组、拖其中一块另一块随动、双击弹出一块；正文的点击和选中不受影响；拖动中滚轮照常滚页面', async () => {
  const { page } = s;
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  const world = page.getByTestId('world');
  await page.waitForFunction(() => typeof (window as unknown as { __siteWorld?: { blocks?: unknown } }).__siteWorld?.blocks === 'function', undefined, { timeout: 20_000 });
  await expect(world).toHaveAttribute('data-settled', 'true', { timeout: 20_000 });
  // 方块惯性按受限步长积分，软件渲染掉帧时需要更久才能真正停止。
  const settleTimeout = (await worldUsesSoftwareRenderer(world)) ? 20_000 : 6000;
  type Blk = { id: number; x: number; y: number; r: number; group: number | null; size: number };
  type SW = { blocks: () => Blk[]; groupOf: (id: number) => { id: number; size: number } | null; pos: (id: number) => { x: number; y: number } | null };
  const blocks = () => page.evaluate(() => (window as unknown as { __siteWorld: SW }).__siteWorld.blocks());
  const groupOf = (id: number) => page.evaluate((i) => (window as unknown as { __siteWorld: SW }).__siteWorld.groupOf(i), id);
  const pos = (id: number) => page.evaluate((i) => (window as unknown as { __siteWorld: SW }).__siteWorld.pos(i), id);
  const html = page.locator('html');
  // 挑两块露在空白处、彼此离得开的方块
  const free = (await blocks()).filter((b) => b.group === null).sort((a, b) => b.r - a.r);
  expect(free.length).toBeGreaterThanOrEqual(2);
  const A = free[0]!;
  const B = free.find((b) => Math.hypot(b.x - A.x, b.y - A.y) > (A.r + b.r) * 2)!;
  expect(B).toBeTruthy();
  // 按住 A：没移动之前不算拖；移动超过几像素开始拖，光标是“抓紧”
  await page.mouse.move(A.x, A.y);
  await page.mouse.down();
  await expect(html).not.toHaveAttribute('data-world-drag', 'true');
  const tx = B.x - B.r * 2;
  for (let i = 1; i <= 20; i++) {
    await page.mouse.move(A.x + ((tx - A.x) * i) / 20, A.y + ((B.y - A.y) * i) / 20);
    await page.waitForTimeout(25);
  }
  await expect(html).toHaveAttribute('data-world-drag', 'true');
  // 平齐地靠近以后，B 被手里的 A 吸过来，贴成一组（同一个组，至少两块：同一水平带里的别的方块也可能一起被吸上）
  await expect.poll(async () => { const ga = await groupOf(A.id); const gb = await groupOf(B.id); return !!ga && !!gb && ga.id === gb.id && ga.size >= 2; }, { timeout: 4000 }).toBe(true);
  // 拖着整组到空白处松手：留在那里，不弹回原位
  await page.mouse.move(470, 815, { steps: 12 });
  await page.waitForTimeout(250);
  await page.mouse.up();
  await expect(html).toHaveAttribute('data-world-drag', 'false');
  await expect(world).toHaveAttribute('data-settled', 'true', { timeout: settleTimeout });
  const a1 = (await pos(A.id))!;
  const b1 = (await pos(B.id))!;
  expect(Math.hypot(b1.x - B.x, b1.y - B.y)).toBeGreaterThan(80);
  // 拖其中另一块（B）：A 跟着走同样的距离
  await page.mouse.move(b1.x, b1.y);
  await page.mouse.down();
  await page.mouse.move(b1.x + 110, b1.y - 60, { steps: 10 });
  await page.waitForTimeout(350);
  const a2 = (await pos(A.id))!;
  const b2 = (await pos(B.id))!;
  expect(Math.hypot(b2.x - b1.x, b2.y - b1.y)).toBeGreaterThan(60);
  expect(Math.hypot(a2.x - a1.x - (b2.x - b1.x), a2.y - a1.y - (b2.y - b1.y))).toBeLessThan(40);
  await page.mouse.up();
  await expect(world).toHaveAttribute('data-settled', 'true', { timeout: settleTimeout });
  // 双击一块：从组里弹出去，组变小
  const before = (await groupOf(A.id))!.size;
  const target = (await pos(A.id))!;
  await page.mouse.dblclick(target.x, target.y);
  await expect.poll(async () => { const ga = await groupOf(A.id); const gb = await groupOf(B.id); return ga?.id !== gb?.id || (ga?.size ?? 0) < before; }, { timeout: 2000 }).toBe(true);
  // 正文：三击选中一段文字，不敲碎方块、不开始拖
  const breaks = await world.getAttribute('data-breaks');
  const pb = await page.evaluate(() => {
    const el = [...document.querySelectorAll('main p')].find((e) => {
      const r = e.getBoundingClientRect();
      return r.top > 80 && r.bottom < innerHeight - 20 && (e.textContent ?? '').length > 40;
    })!;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top };
  });
  await page.mouse.click(pb.x + 30, pb.y + 8, { clickCount: 3 });
  expect((await page.evaluate(() => getSelection()?.toString() ?? '')).length).toBeGreaterThan(10);
  expect(await world.getAttribute('data-breaks')).toBe(breaks);
  await page.evaluate(() => getSelection()?.removeAllRanges());
  // 拖动中滚轮：页面照常滚，拖的方块还在手上
  const C = (await blocks()).sort((a, b) => b.r - a.r)[0]!;
  await page.mouse.move(C.x, C.y);
  await page.mouse.down();
  await page.mouse.move(C.x - 20, C.y + 8, { steps: 4 });
  await expect(html).toHaveAttribute('data-world-drag', 'true');
  const y0 = await page.evaluate(() => window.scrollY);
  await page.mouse.wheel(0, 400);
  await expect.poll(() => page.evaluate(() => window.scrollY), { timeout: 3000 }).toBeGreaterThan(y0 + 200);
  await expect(html).toHaveAttribute('data-world-drag', 'true');
  await page.mouse.up();
  await expect(html).toHaveAttribute('data-world-drag', 'false');
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
});

test('T-WEB-14 文案不强调模板数量；开发者三张真实头像都是自托管的图片', async () => {
  const { page } = s;
  for (let round = 0; round < 2; round++) {
    const text = await page.locator('main').innerText();
    expect(text).not.toMatch(/\d+\s*个(内置)?模板|\d+\s+(built-in\s+)?templates/i);
    await page.getByTestId('toggle-language').click();
  }
  const avatars = page.getByTestId('avatar');
  await expect(avatars).toHaveCount(3);
  await page.getByTestId('team').scrollIntoViewIfNeeded();
  for (const img of await avatars.all()) {
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThanOrEqual(128);
    expect(await img.evaluate((el) => new URL((el as HTMLImageElement).src).origin === location.origin)).toBe(true);
  }
});

test('T-WEB-9 以上全部操作之后：控制台没有报错，没有外部请求', async () => {
  expect(s.errors).toEqual([]);
  expect(await externalRequests(s.app)).toEqual([]);
});

test('T-WEB-10 标题在任何情况下都很快可见：字体请求全部被拦、requestAnimationFrame 不跑（像后台标签页）', async () => {
  // 窄屏与禁用动画帧的用例各用独立实例，避免多个软件渲染器争抢资源。
  await closeWideSession();
  const bad = await launch();
  try {
    const { page } = bad;
    await page.route(/\.woff2(\?|$)/, (r) => r.abort());
    // 后台标签页里 requestAnimationFrame 不回调：出场动画走不动，盖层必须靠保底计时器撤掉
    await page.addInitScript(() => {
      window.requestAnimationFrame = () => 0;
    });
    await page.reload();
    /** 这个元素（及其里面的字）是不是还处在出场动画的隐藏态：透明、被遮罩移走、或者被武装着等出场 */
    const covered = (selector: string) =>
      page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return true;
        const nodes = [el, ...el.querySelectorAll('*')];
        const hidden = nodes.some((n) => {
          const cs = getComputedStyle(n);
          return cs.opacity === '0' || cs.visibility === 'hidden' || (cs.transform !== 'none' && /matrix\(1, 0, 0, 1, 0, [1-9]/.test(cs.transform));
        });
        return hidden || el.closest('[data-armed="true"][data-shown="false"]') !== null;
      }, selector);
    const t0 = Date.now();
    await expect(page.locator('h1')).toBeVisible();
    await expect(page.locator('html')).not.toHaveClass(/\bmotion-ok\b/);
    await expect.poll(() => covered('h1'), { timeout: 2500 }).toBe(false);
    test.info().annotations.push({ type: 'T-WEB-10', description: `首屏标题 ${Date.now() - t0} ms 内可见（字体被拦、rAF 不跑）` });
    // 滚到页面中段的节标题也一样
    await page.evaluate(() => document.getElementById('features')?.scrollIntoView({ behavior: 'instant' }));
    await expect.poll(() => covered('#features h2'), { timeout: 3500 }).toBe(false);
    expect(bad.errors.filter((e) => !/woff2|Failed to load resource|net::ERR_FAILED/.test(e))).toEqual([]);
    expect(await externalRequests(bad.app)).toEqual([]);
  } finally {
    await closeSession(bad);
  }
});

test('T-WEB-7 窄屏降级：不加载完整编辑器，留实时预览和模板切换，没有横向溢出', async () => {
  await closeWideSession();
  const narrow = await launch(390);
  try {
    const { page } = narrow;
    await page.evaluate(() => document.getElementById('try')?.scrollIntoView({ behavior: 'instant' }));
    const viewer = page.getByTestId('compact-viewer');
    await expect(viewer).toHaveAttribute('data-status', 'ready', { timeout: 60_000 });
    await expect(page.getByTestId('sim-window')).toHaveCount(0);
    expect(page.frames().some((f) => f.url().includes('simulator.html'))).toBe(false);
    const chip = viewer.locator('[data-testid="live-chip"][data-template="allay.builtin.item-stinger"]');
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await scrollThrough(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    expect(narrow.errors).toEqual([]);
    expect(await externalRequests(narrow.app)).toEqual([]);
  } finally {
    await closeSession(narrow);
  }
});

