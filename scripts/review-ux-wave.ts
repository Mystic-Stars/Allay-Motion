// pnpm review:ux-wave：界面增强（首次启动引导、下载进度、设置页、快捷键、默认文件夹）的评审截图，写进 docs/review/ux-wave/。
// 需要先 pnpm build。窗口不显示，用 capturePage 截页面。
// 素材只有测试脚本生成的假原版层（纯色色块）和本机假 Mojang 服务器给的假 jar；悦灵指向一个空目录，界面用 CSS 占位。
// 截图里没有任何 Mojang 素材。
//
//   --only=<名字片段>   只截名字含这个片段的场景
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { requiredTextures } from '../packages/assets/src/index';
import { startFakeMojang, type FakeMojang } from '../tests/e2e/fake-mojang';
import { catalogJarEntries, makeCatalogGame } from '../tests/unit/helpers/resource-fixtures';

const ROOT = resolve(import.meta.dirname, '..');
const DESKTOP = join(ROOT, 'apps/desktop');
const OUT = join(ROOT, 'docs/review/ux-wave');
const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length) ?? '';

type Theme = 'dark' | 'light';
type Lang = 'zh-CN' | 'en';

interface Scene {
  name: string;
  theme: Theme;
  language: Lang;
  /** 首次启动（显示引导） */
  firstRun?: boolean;
  /** 有一个假的本机游戏（纯色色块的 jar） */
  fakeGame?: boolean;
  /** 设置文件里额外的字段 */
  seed?: Record<string, unknown>;
  /** 文件夹对话框“选中”的路径 */
  pick?: 'ok' | 'missing';
  act?(page: Page, ctx: { server: FakeMojang }): Promise<void>;
}

const next = async (p: Page, n = 1) => {
  for (let i = 0; i < n; i++) {
    await p.getByTestId('onboarding-next').click();
    await p.waitForTimeout(200);
  }
};

const tourNext = async (p: Page, n: number) => {
  for (let i = 0; i < n; i++) {
    await p.getByTestId('tour-next').click();
    await p.waitForTimeout(150);
  }
  // 等聚光口和气泡的过渡走完
  await p.waitForTimeout(500);
};

async function startDownload(p: Page, server: FakeMojang, mode: 'slow' | 'fail'): Promise<void> {
  server.jarMode = mode;
  await next(p, 2);
  await p.getByTestId('onboarding-asset-download').getByRole('radio').click();
  await p.getByTestId('onboarding').getByTestId('vanilla-download').click();
  // 限速时等到读数里有速度（约 9 秒下完，截在一半左右）
  if (mode === 'slow') await p.getByTestId('onboarding').getByTestId('download-numbers').filter({ hasText: '/s' }).waitFor({ timeout: 15_000 });
  else await p.getByTestId('onboarding').getByTestId('download-error').waitFor();
  await p.waitForTimeout(mode === 'slow' ? 2500 : 900);
}

async function openSettings(p: Page, page: string): Promise<void> {
  await p.keyboard.press('Control+Comma');
  await p.getByTestId(`settings-tab-${page}`).click();
  await p.waitForTimeout(400);
}

const SCENES: Scene[] = [
  // ---- 首次启动引导（6.10）----
  { name: 'onboarding-language-dark-zh', theme: 'dark', language: 'zh-CN', firstRun: true },
  { name: 'onboarding-language-light-en', theme: 'light', language: 'en', firstRun: true },
  { name: 'onboarding-appearance-dark-en', theme: 'dark', language: 'en', firstRun: true, act: (p) => next(p) },
  { name: 'onboarding-appearance-light-zh', theme: 'light', language: 'zh-CN', firstRun: true, act: (p) => next(p) },
  {
    name: 'onboarding-assets-found-dark-zh',
    theme: 'dark',
    language: 'zh-CN',
    firstRun: true,
    fakeGame: true,
    act: async (p) => {
      await next(p, 2);
      await p.getByTestId('onboarding-asset-local').getByRole('radio').click();
      await p.waitForTimeout(300);
    },
  },
  { name: 'onboarding-download-running-dark-zh', theme: 'dark', language: 'zh-CN', firstRun: true, act: (p, { server }) => startDownload(p, server, 'slow') },
  { name: 'onboarding-download-running-light-en', theme: 'light', language: 'en', firstRun: true, act: (p, { server }) => startDownload(p, server, 'slow') },
  { name: 'onboarding-download-failed-dark-en', theme: 'dark', language: 'en', firstRun: true, act: (p, { server }) => startDownload(p, server, 'fail') },
  {
    name: 'onboarding-folders-light-zh',
    theme: 'light',
    language: 'zh-CN',
    firstRun: true,
    pick: 'ok',
    act: async (p) => {
      await next(p, 3);
      await p.getByTestId('folder-project-choose').click();
      await p.waitForTimeout(300);
    },
  },
  {
    name: 'onboarding-done-dark-zh',
    theme: 'dark',
    language: 'zh-CN',
    firstRun: true,
    fakeGame: true,
    act: async (p) => {
      await next(p, 2);
      await p.getByTestId('onboarding-asset-local').getByRole('radio').click();
      await p.getByTestId('onboarding').getByTestId('vanilla-use-local').click();
      await p.waitForTimeout(600);
      await next(p, 2);
    },
  },
  // ---- 新手引导（6.14）：首次启动引导之后、还没看过 ----
  { name: 'tour-welcome-dark-zh', theme: 'dark', language: 'zh-CN', fakeGame: true, seed: { tourCompleted: false } },
  { name: 'tour-templates-light-en', theme: 'light', language: 'en', fakeGame: true, seed: { tourCompleted: false }, act: (p) => tourNext(p, 1) },
  { name: 'tour-template-vs-preset-dark-zh', theme: 'dark', language: 'zh-CN', fakeGame: true, seed: { tourCompleted: false }, act: (p) => tourNext(p, 2) },
  { name: 'tour-template-vs-preset-light-en', theme: 'light', language: 'en', fakeGame: true, seed: { tourCompleted: false }, act: (p) => tourNext(p, 2) },
  { name: 'tour-preview-dark-en', theme: 'dark', language: 'en', fakeGame: true, seed: { tourCompleted: false }, act: (p) => tourNext(p, 3) },
  { name: 'tour-params-light-zh', theme: 'light', language: 'zh-CN', fakeGame: true, seed: { tourCompleted: false }, act: (p) => tourNext(p, 4) },
  { name: 'tour-timeline-dark-zh', theme: 'dark', language: 'zh-CN', fakeGame: true, seed: { tourCompleted: false }, act: (p) => tourNext(p, 5) },
  { name: 'tour-export-dark-zh', theme: 'dark', language: 'zh-CN', fakeGame: true, seed: { tourCompleted: false }, act: (p) => tourNext(p, 7) },
  { name: 'tour-help-light-zh', theme: 'light', language: 'zh-CN', fakeGame: true, seed: { tourCompleted: false }, act: (p) => tourNext(p, 8) },
  // ---- 设置（6.11）----
  { name: 'settings-general-dark-zh', theme: 'dark', language: 'zh-CN', fakeGame: true, act: (p) => openSettings(p, 'general') },
  { name: 'settings-appearance-light-en', theme: 'light', language: 'en', fakeGame: true, act: (p) => openSettings(p, 'appearance') },
  { name: 'settings-assets-dark-en', theme: 'dark', language: 'en', fakeGame: true, act: (p) => openSettings(p, 'assets') },
  {
    name: 'settings-assets-failed-light-zh',
    theme: 'light',
    language: 'zh-CN',
    act: async (p, { server }) => {
      server.jarMode = 'fail';
      await openSettings(p, 'assets');
      const settings = p.getByTestId('settings-dialog');
      await settings.getByTestId('resources-download-options').click();
      await settings.getByTestId('vanilla-download').click();
      await settings.getByTestId('download-error').waitFor();
      await p.waitForTimeout(400);
    },
  },
  {
    name: 'settings-folders-light-zh',
    theme: 'light',
    language: 'zh-CN',
    fakeGame: true,
    pick: 'missing',
    act: async (p) => {
      await openSettings(p, 'folders');
      await p.getByTestId('folder-export-choose').click();
      await p.waitForTimeout(300);
    },
  },
  {
    name: 'settings-folders-dark-en',
    theme: 'dark',
    language: 'en',
    fakeGame: true,
    pick: 'ok',
    act: async (p) => {
      await openSettings(p, 'folders');
      await p.getByTestId('folder-project-choose').click();
      await p.waitForTimeout(300);
    },
  },
  { name: 'settings-export-dark-zh', theme: 'dark', language: 'zh-CN', fakeGame: true, act: (p) => openSettings(p, 'export') },
  { name: 'settings-shortcuts-dark-zh', theme: 'dark', language: 'zh-CN', fakeGame: true, seed: { shortcuts: { guides: 'G', loop: 'Ctrl+Shift+L' } }, act: (p) => openSettings(p, 'shortcuts') },
  {
    name: 'settings-shortcuts-conflict-light-en',
    theme: 'light',
    language: 'en',
    fakeGame: true,
    act: async (p) => {
      await openSettings(p, 'shortcuts');
      await p.getByTestId('shortcut-edit-guides').click();
      await p.keyboard.press('KeyL');
      await p.waitForTimeout(300);
    },
  },
  { name: 'settings-about-light-zh', theme: 'light', language: 'zh-CN', fakeGame: true, act: (p) => openSettings(p, 'about') },
  // ---- 从资源栈弹层进入素材设置，查看下载进度（6.12）----
  {
    name: 'resources-download-dark-zh',
    theme: 'dark',
    language: 'zh-CN',
    act: async (p, { server }) => {
      server.jarMode = 'slow';
      await p.getByTestId('resources-button').click();
      await p.getByTestId('resources-popover').getByTestId('resources-manage').click();
      const settings = p.getByTestId('settings-dialog');
      await settings.getByTestId('resources-download-options').click();
      await settings.getByTestId('vanilla-download').click();
      await settings.getByTestId('download-numbers').filter({ hasText: '/s' }).waitFor({ timeout: 15_000 });
      await p.waitForTimeout(2500);
    },
  },
];

async function launch(userData: string, extra: Record<string, string>): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE' && k !== 'NODE_OPTIONS') env[k] = v;
  Object.assign(env, { ALLAY_USER_DATA_DIR: userData, ALLAY_E2E_HIDDEN: '1', ALLAY_E2E_HOOKS: '1', ALLAY_E2E_MASCOT_DIR: join(userData, 'no-mascot'), ...extra });
  const electronPath = createRequire(join(DESKTOP, 'package.json'))('electron') as string;
  const app = await electron.launch({ executablePath: electronPath, args: [DESKTOP], env, cwd: DESKTOP });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900));
  await page.waitForFunction(() => window.__allayTest?.previewUpToDate() === true, undefined, { timeout: 30_000 });
  await page.waitForTimeout(1200);
  return { app, page };
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'allay-review-ux-'));
  const paths = requiredTextures().map((r) => ({ id: r.id, path: r.anyOf[0]! }));
  const jar = catalogJarEntries(paths, { 'minecraft:block/diamond_block': '#3fbfa0' });
  const server = await startFakeMojang('9.9.9', jar);
  try {
    // 假的本机游戏（纯色色块），以及一个空的“没有游戏”的目录
    const appData = join(work, 'appdata');
    makeCatalogGame(join(appData, '.minecraft'), '9.9.9', '2030-01-01T00:00:00+00:00', jar);
    const empty = join(work, 'no-game');
    mkdirSync(empty);
    const okFolder = join(work, 'Videos', 'Allay exports');
    mkdirSync(okFolder, { recursive: true });
    for (const scene of SCENES.filter((s) => s.name.includes(only))) {
      const data = join(work, scene.name);
      mkdirSync(data, { recursive: true });
      const ui = { theme: scene.theme, language: scene.language, reducedMotion: 'off', onboardingCompleted: !scene.firstRun, ...scene.seed };
      writeFileSync(
        join(data, 'settings.json'),
        JSON.stringify({ formatVersion: 1, ui, resources: { vanilla: { consent: scene.fakeGame && !scene.firstRun ? true : null, enabled: true, dir: null }, packs: [] } }),
      );
      server.jarMode = 'ok';
      const extra: Record<string, string> = {
        ALLAY_E2E_GAME_APPDATA: scene.fakeGame ? appData : empty,
        ALLAY_E2E_MOJANG_ORIGIN: server.origin,
      };
      if (scene.pick) extra.ALLAY_E2E_PICK_FOLDER = scene.pick === 'ok' ? okFolder : join(work, 'Removable drive', 'Exports');
      const { app, page } = await launch(data, extra);
      try {
        if (scene.pick === 'missing') {
          // 先选一个能用的，再让它“消失”：设置页标出问题
          const tmp = join(work, 'Removable drive', 'Exports');
          mkdirSync(tmp, { recursive: true });
          await scene.act?.(page, { server });
          rmSync(join(work, 'Removable drive'), { recursive: true, force: true });
          await page.keyboard.press('Escape');
          await openSettings(page, 'folders');
        } else await scene.act?.(page, { server });
        await page.mouse.move(0, 0);
        await page.waitForTimeout(300);
        const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG().toString('base64'));
        writeFileSync(join(OUT, `${scene.name}.png`), Buffer.from(png, 'base64'));
        console.log(`[review:ux-wave] ${scene.name}.png`);
      } finally {
        await app.close();
      }
    }
  } finally {
    await server.close();
    rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}

await main();
