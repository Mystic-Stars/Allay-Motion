import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchApp, makeUserDataDir, removeUserDataDir } from './helpers';

const template = { id: 'allay.builtin.loading-screen', version: '1.0.0' };
const durationParams = { inDuration: 0.4, hold: 2, outDuration: 0.6, cutAt: 0.4 };

async function openProject(page: Page) {
  await page.getByTestId('project-menu').click();
  await page.getByTestId('project-open').click();
  await expect.poll(() => page.evaluate(() => window.__allayTest?.previewUpToDate())).toBe(true);
}

test('T-FID.loading-controls Java 文案与填充色分开选来源，保留预设和工程参数', async () => {
  const dir = makeUserDataDir();
  const projectPath = join(dir, 'loading.allay');
  try {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ formatVersion: 1, ui: { onboardingCompleted: true, tourCompleted: true, language: 'en' } }));
    writeFileSync(projectPath, JSON.stringify({ formatVersion: 1, name: 'Loading', template, params: {
      loadingStyle: 'javaWorld263', title: '正在加载世界', subtitle: '正在生成地形…', javaBarColor: '#00000000', barColor: '#55FF55', ...durationParams,
    } }));
    const { app, page } = await launchApp(dir, { ALLAY_E2E_PROJECT_PATH: projectPath });
    try {
      await openProject(page);
      const param = (key: string) => page.getByTestId(`param-${key}`);
      const source = (key: string, label: 'Vanilla' | 'Custom') => param(key).getByRole('button', { name: label, exact: true }).click();
      const modes = ['javaTitleMode', 'javaSubtitleMode', 'javaFillMode'];
      const fields = ['javaTitle', 'javaSubtitle', 'javaFillColor'];
      const state = () => page.evaluate(() => window.__allayTest!.project().params);
      const enter = async (key: string, value: string) => {
        await param(key).fill(value);
        await param(key).press('Enter');
      };
      for (const key of [...fields, 'title', 'subtitle', 'javaBarColor']) await expect(param(key)).toHaveCount(0);
      await expect(param('loadingLanguage')).toBeVisible();
      for (const key of modes) await source(key, 'Custom');
      await expect(param('loadingLanguage')).toHaveCount(0);
      await enter('javaTitle', '正在加载世界');
      await enter('javaSubtitle', '正在生成地形…');
      await param('javaFillColor').click();
      const hex = page.getByRole('dialog', { name: 'Fill color' }).getByRole('textbox');
      await hex.fill('#00000000');
      await hex.press('Enter');
      await page.keyboard.press('Escape');
      await expect(param('javaFillColor')).toContainText('#00000000');
      for (const key of modes) await source(key, 'Vanilla');
      for (const key of fields) await expect(param(key)).toHaveCount(0);
      for (const key of modes) await source(key, 'Custom');
      await expect(param('javaTitle')).toHaveValue('正在加载世界');
      await expect(param('javaSubtitle')).toHaveValue('正在生成地形…');
      await expect(param('javaFillColor')).toContainText('#00000000');

      await enter('javaTitle', '');
      await page.getByTestId('preset-menu').click();
      await page.getByTestId('preset-save').click();
      const dialog = page.getByTestId('save-preset-dialog');
      await dialog.getByTestId('preset-name').fill('Explicit loading');
      await dialog.getByTestId('preset-save-confirm').click();
      await expect(dialog).toHaveCount(0);
      await source('javaFillMode', 'Vanilla');
      await enter('javaTitle', 'Temporary');
      await page.getByTestId('preset-menu').click();
      await page.getByTestId('preset-Explicit loading').click();
      await expect(param('javaTitle')).toHaveValue('');
      await expect(param('javaSubtitle')).toHaveValue('正在生成地形…');
      await expect(param('javaFillColor')).toContainText('#00000000');

      await page.getByTestId('project-menu').click();
      await page.getByTestId('project-save').click();
      const expected = {
        javaTitleMode: 'custom', javaSubtitleMode: 'custom', javaSubtitle: '正在生成地形…', javaFillMode: 'custom', javaFillColor: '#00000000', ...durationParams,
      };
      await expect.poll(() => JSON.parse(readFileSync(projectPath, 'utf8')).params).toMatchObject(expected);
      await openProject(page);
      expect(await state()).toMatchObject({ ...expected, javaTitle: '' });
      await expect(param('javaTitle')).toHaveValue('');
      expect(await page.evaluate(() => window.__allayTest!.transport())).toMatchObject({ duration: 3 });
    } finally { await app.close(); }
  } finally { removeUserDataDir(dir); }
});
