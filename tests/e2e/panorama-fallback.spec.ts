import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { makeCatalogGame, packMcmeta, solidPng, writeZip } from '../unit/helpers/resource-fixtures';
import { appEnv, ELECTRON_PATH, launchApp, makeUserDataDir, removeUserDataDir } from './helpers';

const LOADING = 'allay.builtin.loading-screen';
const TOAST = 'allay.builtin.advancement-toast';
const faces = Array.from({ length: 6 }, (_, index) => `assets/minecraft/textures/gui/title/background/panorama_${index}.png`);

async function ready(page: Page) {
  await expect.poll(() => page.evaluate(() => window.__allayTest?.previewUpToDate())).toBe(true);
}

test('T-FID 全景回退只提示当前预览，打开素材设置不下载，补齐六面后清除', async () => {
  const dir = makeUserDataDir();
  const appData = join(dir, 'game');
  const pack = join(dir, 'synthetic-panorama.zip');
  try {
    makeCatalogGame(join(appData, '.minecraft'), '26.3', '2026-10-01', faces.map((name) => ({ name, data: solidPng('#202020', 1, 1) })));
    writeZip(pack, [{ name: 'pack.mcmeta', data: packMcmeta('Synthetic panorama') },
      ...faces.map((name) => ({ name, data: solidPng('#4070a0', 16, 16) }))]);
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ formatVersion: 1,
      ui: { language: 'zh-CN', onboardingCompleted: true, tourCompleted: true },
      resources: { vanilla: { enabled: true, consent: true, dir: null }, packs: [] },
    }));
    const env = { ALLAY_E2E_GAME_APPDATA: appData };
    const isolatedApp = process.env.ALLAY_PANORAMA_TEST_APP;
    const app = isolatedApp ? await electron.launch({ executablePath: ELECTRON_PATH, args: [isolatedApp], env: appEnv(dir, env) })
      : (await launchApp(dir, env)).app;
    try {
      const page = await app.firstWindow();
      const hint = page.getByTestId('panorama-fallback-hint');
      await page.getByTestId(`template-${LOADING}`).click();
      await page.evaluate(() => window.__allayTest!.setParams({ loadingStyle: 'generic' }));
      await ready(page);
      await expect(hint).toHaveCount(0);

      await page.evaluate(() => window.__allayTest!.setParams({ loadingStyle: 'javaWorld263' }));
      await ready(page);
      await expect(hint).toContainText('缺少可用的全景贴图，已改用深色背景。');
      await hint.getByRole('button', { name: '打开素材设置' }).click();
      const settings = page.getByTestId('settings-dialog');
      await expect(settings.getByTestId('settings-tab-assets')).toHaveAttribute('aria-selected', 'true');
      expect(await page.evaluate(async () => (await window.allay.resources.layers()).download.status)).toBe('idle');
      await settings.getByTestId('settings-tab-general').click();
      await page.getByTestId('settings-language').click();
      await page.getByRole('option', { name: 'English', exact: true }).click();
      await page.keyboard.press('Escape');
      await ready(page);
      await expect(hint).toContainText('Panorama unavailable. Using a dark background instead');

      await page.getByTestId(`template-${TOAST}`).click();
      await ready(page);
      await expect(hint).toHaveCount(0);
      await page.getByTestId(`template-${LOADING}`).click();
      await page.evaluate(() => window.__allayTest!.setParams({ loadingStyle: 'javaWorld263' }));
      await ready(page);
      await expect(hint).toBeVisible();

      await page.evaluate(() => {
        const input = document.createElement('input');
        input.type = 'file';
        input.id = 'synthetic-panorama-pack';
        document.body.append(input);
      });
      await page.locator('#synthetic-panorama-pack').setInputFiles(pack);
      const result = await page.evaluate(() => {
        const input = document.getElementById('synthetic-panorama-pack') as HTMLInputElement;
        const file = input.files![0]!;
        input.remove();
        return window.allay.resources.addDroppedPack(file);
      });
      expect(result).toMatchObject({ ok: true });
      await ready(page);
      await expect(hint).toHaveCount(0);
      expect(await page.evaluate(async () => (await window.allay.resources.layers()).download.status)).toBe('idle');
    } finally { await app.close(); }
  } finally { removeUserDataDir(dir); }
});
