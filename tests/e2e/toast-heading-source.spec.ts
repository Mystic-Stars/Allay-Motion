import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator } from '@playwright/test';
import { launchApp, makeUserDataDir, removeUserDataDir } from './helpers';

const TOAST_ID = 'allay.builtin.advancement-toast';

async function select(container: Locator, key: string, name: string) {
  await container.getByTestId(`param-${key}`).getByRole('button', { name, exact: true }).click();
}

test('T-FID Java 提示的标题来源互斥，切换、类型与真实预设往返', async () => {
  const dir = makeUserDataDir();
  try {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ formatVersion: 1, ui: { onboardingCompleted: true, language: 'en' } }));
    const { app, page } = await launchApp(dir);
    try {
      expect(await page.evaluate((id) => window.__allayTest!.selectTemplate(id, '1.0.0', { toastStyle: 'javaAdvancement' }), TOAST_ID)).toBe(true);
      const panel = page.getByTestId('param-panel');
      const heading = panel.getByTestId('param-javaHeader');
      const language = panel.getByTestId('param-toastLanguage');
      const frame = panel.getByTestId('param-frame');
      const title = panel.getByTestId('param-javaTitle');
      const state = () => page.evaluate(() => window.__allayTest!.project().params);
      const mode = (name: 'Follow type' | 'Custom') => select(panel, 'javaHeadingMode', name);
      const changeFrame = (name: 'Task' | 'Goal' | 'Challenge') => select(panel, 'frame', name);
      const editHeading = async (text: string) => {
        await heading.fill(text);
        await heading.press('Enter');
        await expect.poll(async () => (await state()).javaHeader).toBe(text);
      };
      const savePreset = async (name: string) => {
        await page.getByTestId('preset-menu').click();
        await page.getByTestId('preset-save').click();
        const dialog = page.getByTestId('save-preset-dialog');
        await dialog.getByTestId('preset-name').fill(name);
        await dialog.getByTestId('preset-save-confirm').click();
        await expect(dialog).toHaveCount(0);
      };
      const restorePreset = async (name: string) => {
        await page.getByTestId('preset-menu').click();
        await page.getByTestId(`preset-${name}`).click();
      };

      await expect(language).toBeVisible();
      await expect(heading).toHaveCount(0);
      await expect(panel.getByTestId('param-header')).toHaveCount(0);
      await expect(title).toBeVisible();
      await expect(frame).toBeVisible();
      await language.click();
      await page.getByRole('option', { name: 'Simplified Chinese', exact: true }).click();
      await expect.poll(async () => (await state()).toastLanguage).toBe('zh-CN');
      await changeFrame('Challenge');
      await mode('Custom');
      await expect(language).toHaveCount(0);
      await expect(heading).toHaveValue('');

      for (const [name, literal] of [['English literal', 'Advancement Made!'], ['Chinese literal', '进度已达成！'], ['Empty literal', '']] as const) {
        await editHeading(literal);
        await changeFrame('Goal');
        await expect(heading).toHaveValue(literal);
        await savePreset(name);
        await mode('Follow type');
        await expect(language).toBeVisible();
        await expect(heading).toHaveCount(0);
        await changeFrame('Task');
        await mode('Custom');
        await expect(heading).toHaveValue(literal);
        await editHeading('Temporary heading');
        await restorePreset(name);
        await expect(heading).toHaveValue(literal);
        await expect(language).toHaveCount(0);
        await expect.poll(state).toMatchObject({ javaHeadingMode: 'custom', javaHeader: literal, frame: 'goal' });
      }
      const presets = await page.evaluate(() => window.__allayTest!.listPresets());
      expect(presets).toHaveLength(3);
      expect(presets.find(({ name }) => name === 'Empty literal')?.params).toMatchObject({ javaHeadingMode: 'custom' });
    } finally {
      await app.close();
    }
  } finally {
    removeUserDataDir(dir);
  }
});
