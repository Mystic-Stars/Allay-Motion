import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { encodePng } from '../../scripts/mascot-bake/png';
import { launchApp, makeUserDataDir, removeUserDataDir } from './helpers';

async function addPlayerMaterial(page: Page) {
  await page.getByTestId('project-menu').click();
  await page.getByTestId('menu-new-animation').click();
  await page.getByTestId('studio-add').click();
  await page.getByRole('menuitem', { name: 'Player', exact: true }).click();
  await expect(page.getByTestId('skin-library-select')).toBeEnabled();
}

test('T-SKIN-6 角色属性导入、预览、离线重启换肤和删除；取消专属同意不获取', async () => {
  const dir = makeUserDataDir();
  try {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ formatVersion: 1, ui: { onboardingCompleted: true, language: 'en', updates: { mode: 'off' } } }));
    const paths = [join(dir, 'Violet.png'), join(dir, 'Amber.png')];
    for (const [index, path] of paths.entries()) {
      const data = new Uint8Array(64 * 64 * 4);
      for (let offset = 0; offset < data.length; offset += 4) data.set(index === 0 ? [90, 40, 162, 255] : [190, 122, 18, 255], offset);
      writeFileSync(path, encodePng({ width: 64, height: 64, data }));
    }
    const first = await launchApp(dir);
    let refs: string[] = [];
    try {
      await first.app.evaluate(({ dialog }, choices) => {
        const native = dialog as unknown as Record<string, unknown>;
        native.skinConsentCalls = 0;
        native.showOpenDialog = async () => ({ canceled: false, filePaths: [choices.shift()] });
        native.showMessageBox = async (_window: unknown, options: { title?: string; cancelId?: number; defaultId?: number }) => {
          if (options.title !== 'Fetch skin by Java username' || options.cancelId !== 0 || options.defaultId !== 0) throw new Error('unexpected consent dialog');
          native.skinConsentCalls = Number(native.skinConsentCalls) + 1;
          return { response: 0 };
        };
      }, [...paths]);
      const { page } = first;
      await addPlayerMaterial(page);
      const manage = page.getByRole('button', { name: 'Manage skins…' });
      const library = page.getByRole('dialog', { name: 'Player skin library' });
      await expect(page.getByTestId('skin-import')).toBeHidden();
      const sample = () => page.evaluate(() => window.__allayTest!.previewStats(0.5));
      await page.waitForFunction(() => window.__allayTest?.previewUpToDate() === true);
      expect((await sample()).maxAlpha).toBe(0);
      await manage.press('Enter');
      await page.getByTestId('skin-import').click();
      await expect(page.getByTestId('skin-library-select')).toContainText('Violet');
      await page.waitForFunction(() => window.__allayTest?.previewUpToDate() === true);
      expect((await sample()).maxAlpha).toBeGreaterThan(0);
      const violet = await page.evaluate(() => window.__allayTest!.previewHash(0.5));
      await page.getByTestId('skin-import').click();
      await expect(page.getByTestId('skin-library-select')).toContainText('Amber');
      await page.waitForFunction(() => window.__allayTest?.previewUpToDate() === true);
      expect(await page.evaluate(() => window.__allayTest!.previewHash(0.5))).not.toBe(violet);
      await page.getByLabel('Java username').fill('Test_123');
      for (const expectedCalls of [1, 2]) {
        await page.getByTestId('skin-fetch-java').click();
        await expect.poll(() => first.app.evaluate(({ dialog }) => Reflect.get(dialog, 'skinConsentCalls'))).toBe(expectedCalls);
        await expect(library).toHaveAttribute('aria-busy', 'false');
        await expect(library.getByRole('alert')).toBeHidden();
      }
      await page.keyboard.press('Escape');
      await expect(manage).toBeFocused();
      refs = await page.evaluate(async () => (await window.allay.skins!.list()).map((skin) => skin.ref));
      expect(refs).toHaveLength(2);
    } finally {
      await first.app.close();
    }

    const { app, page } = await launchApp(dir);
    try {
      expect(await page.evaluate(async () => (await window.allay.skins!.list()).map((skin) => skin.ref))).toEqual(refs);
      await addPlayerMaterial(page);
      await page.getByTestId('skin-library-select').click();
      await page.getByRole('option', { name: /Amber/ }).click();
      await expect(page.getByTestId('skin-library-select')).toContainText('Amber');
      await page.getByRole('button', { name: 'Manage skins…' }).click();
      await page.getByRole('button', { name: 'Delete skin…' }).click();
      await page.getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Done' })).toBeFocused();
      await expect(page.getByTestId('skin-library-select')).toContainText('No skin');
      await page.waitForFunction(() => window.__allayTest?.previewUpToDate() === true);
      expect((await page.evaluate(() => window.__allayTest!.previewStats(0.5))).maxAlpha).toBe(0);
      expect(await page.evaluate(async () => (await window.allay.skins!.list()).map((skin) => skin.name))).toEqual(['Violet']);
      expect(await page.evaluate((ref) => window.allay.skins!.read(ref), refs[0]!)).toBeNull();
    } finally {
      await app.close();
    }
  } finally {
    removeUserDataDir(dir);
  }
});
