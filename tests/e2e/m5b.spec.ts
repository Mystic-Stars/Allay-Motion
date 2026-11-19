import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { requiredTextures } from '../../packages/assets/src/index';
import { brandMessages } from '../../packages/ui/src/brand/messages';
import { catalogJarEntries, makeCatalogGame } from '../unit/helpers/resource-fixtures';
import { writeFakeMascot } from './fake-mascot';
import { DESKTOP_DIR, ELECTRON_PATH, launchApp, makeUserDataDir, readMainLog, removeUserDataDir, requirePinnedFfmpeg, seedSettings } from './helpers';

// M5 后半（docs/07-allay-mascot.md 7.10）：T-ALY-3、T-ALY-4、T-ALY-5（图集版）、T-ALY-6，启动画面，产物缺失时的占位。
// T-ALY-1、T-ALY-7 在 tests/unit/T-ALY.mascot-bake.test.ts（烘焙）；T-ALY-2 在 tests/unit/T-ALY-2.loader-timing.test.ts 和 m4.spec.ts。
// 悦灵的图集用测试时生成的假产物（纯色色块，fake-mascot.ts），不读这台机器上烘焙过的真实产物，也不读真装的游戏。

interface Ctx {
  app: ElectronApplication;
  page: Page;
  dir: string;
}

function seed(dir: string, ui: Record<string, unknown>): string {
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
  return appData;
}

async function start(opts: { ui?: Record<string, unknown>; atlas?: boolean; env?: Record<string, string> } = {}): Promise<Ctx> {
  const dir = makeUserDataDir();
  const appData = seed(dir, opts.ui ?? {});
  const env: Record<string, string> = { ALLAY_E2E_GAME_APPDATA: appData, ...opts.env };
  if (opts.atlas !== false) {
    writeFakeMascot(join(dir, 'mascot'));
    env.ALLAY_E2E_MASCOT_DIR = join(dir, 'mascot');
  }
  const { app, page } = await launchApp(dir, env);
  await upToDate(page);
  await expect.poll(() => page.evaluate(() => window.__allayTest!.resourceState()?.detecting === false && window.__allayTest!.resourceState()?.hasAssets === true)).toBe(true);
  await upToDate(page);
  return { app, page, dir };
}

async function upToDate(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__allayTest?.previewUpToDate() === true, undefined, { timeout: 30_000 });
}

async function coversReady(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="template-list"] img').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('gallery-loader')).toHaveAttribute('data-allay-loader-phase', 'idle');
}

async function stop(ctx: Ctx): Promise<void> {
  await ctx.app.close();
  removeUserDataDir(ctx.dir);
}

/** 在页面里模拟把文件拖进窗口再放下（7.6 D）。文件是页面里造的，主进程拿不到路径，安装会失败并出通知，这正好不改动任何状态 */
async function dragAndDrop(page: Page, name: string, hold = 300): Promise<void> {
  await page.evaluate(
    async ([fileName, ms]) => {
      const dt = new DataTransfer();
      dt.items.add(new File(['x'], fileName as string));
      window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
      window.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, ms as number));
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    },
    [name, hold] as const,
  );
}

const THROWING_TEMPLATE = `export default {
  manifest: { id: 'test.m5b.throws', name: { en: 'Throws' }, version: '1.0.0', category: 'transition', params: [] },
  setup() { throw new Error('m5b: setup failed on purpose'); },
};`;

test('M5b 图集：有产物时从图集画帧（canvas），头像用烘焙的头像；缺产物时退回 CSS 占位', async () => {
  const withAtlas = await start();
  try {
    const { page } = withAtlas;
    await coversReady(page);
    const head = page.locator('[data-allay="head"]');
    await expect(head).toHaveAttribute('data-source', 'atlas');
    await expect.poll(() => head.locator('img').first().evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    await page.evaluate(() => window.__allayTest!.simulateLoading(true));
    const body = page.getByTestId('preview-loader').locator('[data-allay="body"]');
    await expect(body).toHaveAttribute('data-source', 'atlas');
    // 画布上真的画了图集里的帧（假图集是不透明的色块）
    await expect
      .poll(() =>
        body.locator('canvas').evaluate((c: HTMLCanvasElement) => {
          const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
          let opaque = 0;
          for (let i = 3; i < d.length; i += 4) if (d[i]! > 0) opaque++;
          return opaque;
        }),
      )
      .toBeGreaterThan(50);
    await page.evaluate(() => window.__allayTest!.simulateLoading(false));
  } finally {
    await stop(withAtlas);
  }

  const without = await start({ atlas: false });
  try {
    const { page } = without;
    await coversReady(page);
    await expect(page.locator('[data-allay="head"]')).toHaveAttribute('data-source', 'placeholder');
    await page.evaluate(() => window.__allayTest!.simulateLoading(true));
    await expect(page.getByTestId('preview-loader').locator('[data-allay="body"]')).toHaveAttribute('data-source', 'placeholder');
    await expect(page.locator('canvas[data-allay], [data-allay] canvas')).toHaveCount(0);
    await page.evaluate(() => window.__allayTest!.simulateLoading(false));
  } finally {
    await stop(without);
  }
});

test('T-ALY-3 端到端跑完一整套操作：任意时刻 DOM 里的全身悦灵不超过一只', async () => {
  const dir = makeUserDataDir();
  const out = join(dir, 'exports');
  mkdirSync(out);
  const ctx = await start({ env: { ALLAY_E2E_EXPORT_TARGET: out, ALLAY_FFMPEG: requirePinnedFfmpeg() } });
  const { page } = ctx;
  try {
    // 每次 DOM 变化都数一遍全身悦灵（顶栏头像不算）；记最大值和出现过的出场位置
    await page.evaluate(() => {
      const w = window as unknown as { __aly: { max: number; samples: number; where: Set<string> } };
      w.__aly = { max: 0, samples: 0, where: new Set() };
      const count = () => {
        const bodies = document.querySelectorAll('[data-allay="body"]');
        w.__aly.samples++;
        w.__aly.max = Math.max(w.__aly.max, bodies.length);
        for (const b of bodies) {
          const host = b.closest('[data-testid]') as HTMLElement | null;
          w.__aly.where.add(host?.dataset.testid ?? 'unknown');
        }
      };
      new MutationObserver(count).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-allay'] });
    });
    const result = () => page.evaluate(() => {
      const a = (window as unknown as { __aly: { max: number; samples: number; where: Set<string> } }).__aly;
      return { max: a.max, samples: a.samples, where: [...a.where].sort() };
    });

    // 1. 资源栈变化：模板库重建封面（7.5 第 2 项）的同时，预览视口在装载（第 3 项）
    await page.evaluate(() => window.__allayTest!.simulateLoading(true));
    await page.evaluate(() => window.allay.resources.setVanilla({ enabled: false }));
    await page.waitForTimeout(600);
    await page.evaluate(() => window.allay.resources.setVanilla({ enabled: true }));
    await page.waitForTimeout(600);
    // 2. 方块选择器（第 4 项）叠在上面
    await page.getByTestId('param-blocks').getByRole('button').first().click();
    await page.waitForTimeout(600);
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.__allayTest!.simulateLoading(false));
    await coversReady(page);
    await upToDate(page);

    // 3. 关于页（第 11 项）
    await page.getByTestId('topbar-settings').click();
    await page.getByTestId('settings-tab-about').click();
    await expect(page.getByTestId('about-disclaimer')).toBeVisible();
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('settings-dialog')).toHaveCount(0);

    // 4. 导出：进度、封装、完成后的舞蹈（第 5 项）
    await page.getByTestId('topbar-export').click();
    await page.getByTestId('export-start').click();
    await expect(page.getByTestId('export-result')).toHaveAttribute('data-kind', 'done', { timeout: 60_000 });
    await page.waitForTimeout(800);
    await page.getByTestId('export-close').click();

    // 5. “我的”为空（第 7 项），同时预览出错（第 10 项）：两只静止的悦灵争一个位置
    await page.getByTestId('gallery-tab-mine').click();
    await expect(page.getByTestId('allay-empty')).toBeVisible();
    await page.evaluate((code) => window.__allayTest!.loadTemplate(code), THROWING_TEMPLATE);
    await expect(page.getByTestId('preview-error')).toBeVisible();
    await page.waitForTimeout(300);
    expect(await page.locator('[data-allay="body"]').count()).toBe(1);
    expect(await page.locator('[data-allay="reserved"]').count()).toBeGreaterThanOrEqual(1);

    // 6. 拖放（第 6 项）：有效的包送到归宿，无效的 sad
    await dragAndDrop(page, 'pack.zip');
    await page.waitForTimeout(700);
    await dragAndDrop(page, 'notes.txt');
    await page.waitForTimeout(700);

    const r = await result();
    expect(r.samples).toBeGreaterThan(20);
    // 出场位置确实轮换过（不是因为悦灵根本没出现才“不超过一只”）
    expect(r.where).toEqual(expect.arrayContaining(['allay-flyer-bird', 'settings-dialog', 'allay-progress-bird', 'allay-empty', 'allay-delivery', 'drop-overlay']));
    expect(r.max).toBe(1);
  } finally {
    await stop(ctx);
    removeUserDataDir(dir);
  }
});

test('T-ALY-4 开启 prefers-reduced-motion：悦灵相关元素上没有 transform 动画', async () => {
  const dir = makeUserDataDir();
  const out = join(dir, 'exports');
  mkdirSync(out);
  const ctx = await start({ ui: { reducedMotion: 'system' }, env: { ALLAY_E2E_EXPORT_TARGET: out, ALLAY_FFMPEG: requirePinnedFfmpeg() } });
  const { page } = ctx;
  try {
    await coversReady(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.reducedMotion)).toBe('true');
    // 每 30 ms 采样：悦灵的帧循环没有订阅者（没有脚本驱动的位移和帧动画），悦灵相关元素上没有改 transform 的 CSS 动画或过渡
    await page.evaluate(() => {
      const w = window as unknown as { __rm: { subs: number; anims: string[]; samples: number } };
      w.__rm = { subs: 0, anims: [], samples: 0 };
      const MASCOT = '[data-allay], [data-allay-fx], [data-testid^="allay-"], [data-testid="drop-overlay"]';
      setInterval(() => {
        w.__rm.samples++;
        w.__rm.subs = Math.max(w.__rm.subs, window.__allayTest!.mascotStats().subscribers);
        for (const a of document.getAnimations()) {
          const target = (a.effect as KeyframeEffect | null)?.target as Element | null;
          if (!target?.closest(MASCOT)) continue;
          const frames = (a.effect as KeyframeEffect).getKeyframes();
          if (frames.some((k) => 'transform' in k || 'translate' in k || 'rotate' in k || 'scale' in k)) w.__rm.anims.push(`${target.tagName}.${target.className}`);
        }
      }, 30);
    });
    // 飞舞（第 3 项）
    await page.evaluate(() => window.__allayTest!.simulateLoading(true));
    await expect(page.getByTestId('preview-loader').getByTestId('allay-flyer')).toHaveAttribute('data-reduced', 'true');
    await page.waitForTimeout(1200);
    await page.evaluate(() => window.__allayTest!.simulateLoading(false));
    await page.waitForTimeout(400);
    // 拖放（第 6 项）
    await dragAndDrop(page, 'pack.zip', 500);
    await page.waitForTimeout(700);
    // 导出（第 5 项）
    await page.getByTestId('topbar-export').click();
    await page.getByTestId('export-start').click();
    await expect(page.getByTestId('export-result')).toHaveAttribute('data-kind', 'done', { timeout: 60_000 });
    await page.waitForTimeout(800);
    // 顶栏头像：点击不转圈
    await page.getByTestId('export-close').click();
    await page.locator('[data-allay="head"]').click();
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => (window as unknown as { __rm: { subs: number; anims: string[]; samples: number } }).__rm);
    expect(r.samples).toBeGreaterThan(50);
    expect(r.subs).toBe(0);
    expect([...new Set(r.anims)]).toEqual([]);
  } finally {
    await stop(ctx);
    removeUserDataDir(dir);
  }
});

test('T-ALY-5 飞舞时在悦灵（图集）所在位置点击：点击落到下面的元素上', async () => {
  const ctx = await start();
  const { page } = ctx;
  try {
    await coversReady(page);
    await page.evaluate(() => window.__allayTest!.simulateLoading(true));
    const bird = page.getByTestId('preview-loader').getByTestId('allay-flyer-bird');
    await expect(bird.locator('canvas')).toBeVisible();
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
          w.__clicked = el.closest('[data-testid="preview-loading-layer"]') ? 'loader' : ((el.closest('[data-testid]') as HTMLElement | null)?.dataset.testid ?? el.tagName);
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
    // 悦灵的每一层都不接收指针
    const blocking = await page.evaluate(() =>
      [...document.querySelectorAll('[data-allay], [data-allay] *, [data-allay-fx], [data-testid="allay-flyer"], [data-testid="allay-flyer-bird"]')].filter((el) => getComputedStyle(el).pointerEvents !== 'none').length,
    );
    expect(blocking).toBe(0);
    await page.evaluate(() => window.__allayTest!.simulateLoading(false));
  } finally {
    await stop(ctx);
  }
});

interface TraceEvent {
  name: string;
  ph: string;
  ts: number;
  dur?: number;
  pid: number;
  tid: number;
}

test('T-ALY-6 性能跟踪：飞舞期间每帧用于悦灵的时间 p95 ≤ 1 ms，rAF 回调里零次强制重排', async () => {
  const ctx = await start();
  const { page } = ctx;
  try {
    await coversReady(page);
    await page.evaluate(() => window.__allayTest!.simulateLoading(true));
    await expect(page.getByTestId('preview-loader').getByTestId('allay-flyer-bird').locator('canvas')).toBeVisible();
    await page.waitForTimeout(500);
    await page.evaluate(() => window.__allayTest!.mascotStats(true));

    const cdp = await page.context().newCDPSession(page);
    const events: TraceEvent[] = [];
    cdp.on('Tracing.dataCollected', (e) => events.push(...(e.value as unknown as TraceEvent[])));
    const done = new Promise<void>((r) => cdp.once('Tracing.tracingComplete', () => r()));
    await cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline', transferMode: 'ReportEvents' });
    await page.waitForTimeout(3000);
    await cdp.send('Tracing.end');
    await done;

    const stats = await page.evaluate(() => window.__allayTest!.mascotStats());
    await page.evaluate(() => window.__allayTest!.simulateLoading(false));

    test.info().annotations.push({ type: 'mascot-frame', description: `frames=${stats.frames} p95=${stats.p95.toFixed(3)}ms max=${stats.max.toFixed(3)}ms` });
    expect(stats.frames).toBeGreaterThan(60);
    expect(stats.p95).toBeLessThanOrEqual(1);

    // 强制重排：rAF 回调（FireAnimationFrame）执行期间同一线程上发生的 Layout
    const raf = events.filter((e) => e.name === 'FireAnimationFrame' && e.ph === 'X' && e.dur !== undefined);
    expect(raf.length).toBeGreaterThan(60);
    const layouts = events.filter((e) => e.name === 'Layout' && (e.ph === 'X' || e.ph === 'B'));
    const forced = layouts.filter((l) => raf.some((f) => f.pid === l.pid && f.tid === l.tid && l.ts >= f.ts && l.ts <= f.ts + f.dur!));
    test.info().annotations.push({ type: 'trace', description: `rAF=${raf.length} layouts=${layouts.length} forcedInRaf=${forced.length}` });
    expect(forced).toEqual([]);
  } finally {
    await stop(ctx);
  }
});

test.describe('启动画面（7.5 第 1 项、7.6 C）', () => {
  async function launchWithSplash(dir: string, mascotDir: string): Promise<{ app: ElectronApplication; splash: Page }> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RENDERER_URL' && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
    Object.assign(env, {
      ALLAY_USER_DATA_DIR: dir,
      ALLAY_E2E_HIDDEN: '1',
      ALLAY_E2E_HOOKS: '1',
      ALLAY_E2E_SPLASH: '1',
      ALLAY_E2E_GAME_APPDATA: join(dir, 'no-game'),
      ALLAY_E2E_MOJANG_ORIGIN: 'http://127.0.0.1:9',
      ALLAY_E2E_MASCOT_DIR: mascotDir,
    });
    seedSettings(dir);
    const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [DESKTOP_DIR], env, cwd: DESKTOP_DIR });
    const find = () => app.windows().find((p) => p.url().includes('/splash/'));
    await expect.poll(() => !!find(), { timeout: 15_000 }).toBe(true);
    return { app, splash: find()! };
  }

  test('静态页面、安全设置与主窗口相同、底部有非官方声明、至少显示 600 ms、主窗口就绪后关闭', async () => {
    const dir = makeUserDataDir();
    seed(dir, {});
    writeFakeMascot(join(dir, 'mascot'));
    const { app, splash } = await launchWithSplash(dir, join(dir, 'mascot'));
    try {
      expect(splash.url()).toMatch(/^app:\/\/renderer\/splash\/zh-CN-dark\.html$/);
      // 启动画面只活到“显示满 600 ms 且主窗口就绪”（产品行为，下面按日志核对）。慢机器上（CI 的软件渲染）逐项去问它，
      // 问到一半它就按设计关了（docs/decisions.md M8）。所以先从主进程取 webPreferences，再在页面里一次取齐要看的东西
      // 1.6 第 1 条：与主窗口相同的 webPreferences，只是没有 preload
      const prefs = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((w) => {
          // getLastWebPreferences 不在 Electron 的公开类型里（同 security.spec.ts 的 T-ARC-2）
          const p = (w.webContents as unknown as { getLastWebPreferences(): Record<string, unknown> | null }).getLastWebPreferences();
          return { url: w.webContents.getURL(), contextIsolation: p?.contextIsolation, sandbox: p?.sandbox, nodeIntegration: p?.nodeIntegration, webSecurity: p?.webSecurity, webviewTag: p?.webviewTag, nodeIntegrationInWorker: p?.nodeIntegrationInWorker, nodeIntegrationInSubFrames: p?.nodeIntegrationInSubFrames };
        }),
      );
      await splash.waitForLoadState('domcontentloaded');
      const facts = await splash.evaluate(async () => ({
        wordmark: document.querySelector('.wordmark')?.textContent ?? null,
        disclaimer: document.querySelector('[data-testid="splash-disclaimer"]')?.textContent ?? null,
        font: getComputedStyle(document.body).fontFamily,
        fontFaces: document.fonts.size,
        // 没有脚本、拿不到 Node
        scripts: document.scripts.length,
        require: typeof (globalThis as { require?: unknown }).require,
        process: typeof (globalThis as { process?: unknown }).process,
        // 帧来自图集（CSS steps() 播帧），图集取得到
        background: getComputedStyle(document.querySelector('.sprite')!).backgroundImage,
        atlasOk: (await fetch('../mascot/allay-288.png')).ok,
      }));
      const brand = brandMessages['zh-CN'];
      expect(facts.wordmark).toBe(brand.wordmark);
      expect(facts.disclaimer).toBe(brand.disclaimer);
      expect([facts.font, facts.fontFaces]).toEqual(['system-ui, sans-serif', 0]);
      expect([facts.scripts, facts.require, facts.process]).toEqual([0, 'undefined', 'undefined']);
      expect(facts.background).toContain('/mascot/allay-288.png');
      expect(facts.atlasOk).toBe(true);
      const s = prefs.find((p) => p.url.includes('/splash/'));
      expect(s).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, webviewTag: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false });
      // 主窗口就绪后关闭；从显示到关闭至少 600 ms
      await expect.poll(() => readMainLog(dir), { timeout: 30_000 }).toMatch(/splash.*closed/);
      const m = /splash[^\n]*closed[^\n]*"visibleMs":(\d+)/.exec(readMainLog(dir));
      expect(Number(m?.[1])).toBeGreaterThanOrEqual(600);
      await expect.poll(() => app.windows().filter((p) => p.url().includes('/splash/')).length).toBe(0);
    } finally {
      await app.close();
      removeUserDataDir(dir);
    }
  });

  test('缺烘焙产物时用 CSS 占位（#p），减少动效时静态（#s）', async () => {
    const dir = makeUserDataDir();
    seed(dir, { reducedMotion: 'on', theme: 'light', language: 'en' });
    const { app, splash } = await launchWithSplash(dir, join(dir, 'no-mascot'));
    try {
      expect(splash.url()).toMatch(/\/splash\/en-light\.html#ps$/);
      await expect(splash.locator('.ph')).toBeVisible();
      await expect(splash.locator('.sprite')).toBeHidden();
      // 静态：任何元素都没有动画
      expect(await splash.evaluate(() => document.getAnimations().length)).toBe(0);
      expect(await splash.evaluate(() => [getComputedStyle(document.body).fontFamily, document.fonts.size])).toEqual(['system-ui, sans-serif', 0]);
      await expect(splash.getByTestId('splash-disclaimer')).toHaveText(brandMessages.en.disclaimer);
    } finally {
      await app.close();
      removeUserDataDir(dir);
    }
  });
});

// 正常启动的测试不建启动画面：第一个窗口就是主窗口（其余 e2e 依赖这一点）
test('后台测试默认不建启动画面', async () => {
  const dir = makeUserDataDir();
  const { app, page } = await launchApp(dir);
  try {
    expect(page.url()).toContain('index.html');
    expect(app.windows().filter((p) => p.url().includes('/splash/'))).toHaveLength(0);
  } finally {
    await app.close();
    removeUserDataDir(dir);
  }
});

test('M5b × M7 导出编排：进度页和结果页共用同一个悦灵进度条（换页不重新挂载）；完成 done、取消 canceled', async () => {
  const dir = makeUserDataDir();
  const out = join(dir, 'exports');
  mkdirSync(out);
  const ctx = await start({ env: { ALLAY_E2E_EXPORT_TARGET: out, ALLAY_FFMPEG: requirePinnedFfmpeg() } });
  const { page } = ctx;
  try {
    for (const finish of ['done', 'canceled'] as const) {
      await page.evaluate(() => window.__allayTest!.pauseExportAfter(3));
      await page.getByTestId('topbar-export').click();
      await page.getByTestId('export-quality-draft').click();
      await page.getByTestId('export-start').click();
      await expect.poll(() => page.evaluate(() => window.__allayTest!.exportPausedAt()), { timeout: 30_000 }).toBe(3);
      const allay = page.getByTestId('export-allay');
      await expect(allay).toHaveAttribute('data-phase', 'rendering');
      // 捧着的东西：T1 的第一个 blockList 第一项的方块缩略图（不是胶片图标）
      await expect(allay.locator('img').first()).toBeAttached({ timeout: 15_000 });
      // 给这个 DOM 节点打个记号：结果页上还是它，说明没有重新挂载
      await allay.evaluate((el) => ((el as HTMLElement & { __mark?: number }).__mark = 1));
      if (finish === 'canceled') await page.getByTestId('export-cancel').click();
      await page.evaluate(() => window.__allayTest!.pauseExportAfter(null));
      await page.evaluate(() => window.__allayTest!.resumeExport());
      await expect(page.getByTestId('export-result')).toHaveAttribute('data-kind', finish, { timeout: 60_000 });
      await expect(allay).toHaveAttribute('data-phase', finish);
      expect(await allay.evaluate((el) => (el as HTMLElement & { __mark?: number }).__mark)).toBe(1);
      await page.getByTestId('export-close').click();
    }
  } finally {
    await stop(ctx);
    removeUserDataDir(dir);
  }
});
