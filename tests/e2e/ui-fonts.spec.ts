import { expect, test, type Locator, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIN_WINDOW } from '../../apps/desktop/src/main/window-state';
import { launchApp, makeUserDataDir, removeUserDataDir, type Launched } from './helpers';

async function platformFont(locator: Locator, family: string): Promise<void> {
  await expect(locator).toBeVisible();
  await expect(locator).toHaveCSS('font-family', family);
}

async function noWebFonts(page: Page): Promise<void> {
  expect(await page.evaluate(() => ({
    fonts: document.fonts.size,
    requests: performance.getEntriesByType('resource').filter(({ name }) => /\.(woff2?|ttf|otf)([?#]|$)/i.test(name)).map(({ name }) => name),
  }))).toEqual({ fonts: 0, requests: [] });
}

test('T-UI-FONT 无游戏资源时可离线切换中英文，界面与代码分别保留系统字体', async () => {
  const testInfo = test.info();
  const dir = makeUserDataDir();
  let launched: Launched | undefined;
  const ui = 'system-ui, sans-serif';
  const mono = 'ui-monospace, SFMono-Regular, Consolas, monospace';
  try {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({
      formatVersion: 1, ui: { language: 'en', onboardingCompleted: false, tourCompleted: true, reducedMotion: 'on' },
    }));
    launched = await launchApp(dir, {}, {
      firstRun: true, waitFor: '[data-testid="onboarding"]', args: ['--host-resolver-rules=MAP * ~NOTFOUND'],
    });
    const { app, page } = launched;
    const mainWindow = await app.browserWindow(page);
    await mainWindow.evaluate((win, size) => win.setContentSize(size.width, size.height), MIN_WINDOW);
    const next = page.getByTestId('onboarding-next');
    const html = page.locator('html');
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    for (const language of ['en', 'zh-CN']) {
      await page.getByTestId(`onboarding-language-${language}`).click();
      await expect(html).toHaveAttribute('lang', language);
      await expect(next).toHaveText(language === 'en' ? 'Continue' : '继续');
      await platformFont(page.getByTestId('onboarding').locator('#onboarding-title'), ui);
      await platformFont(next, ui);
      await expect(next).toBeInViewport({ ratio: 1 });
      for (const step of await page.getByTestId('onboarding-stepper').getByRole('button').all()) {
        await expect(step).toBeInViewport({ ratio: 1 });
        expect(await step.evaluate((button) => {
          const label = button.lastElementChild!;
          return label.scrollWidth <= label.clientWidth;
        })).toBe(true);
      }
      await page.screenshot({ path: testInfo.outputPath(`onboarding-${language}.png`) });
    }

    await next.click();
    await expect(page.getByTestId('onboarding')).toHaveAttribute('data-step', 'appearance');
    await page.getByTestId('onboarding-skip-all').click();
    await expect(page.getByTestId('onboarding')).toHaveCount(0);
    const opened = app.waitForEvent('window');
    await page.evaluate(() => window.allay.codeInspector!.open());
    const child = await opened;
    await child.waitForURL('**/code-inspector.html');
    child.on('pageerror', (error) => errors.push(error.message));
    const codeWindow = await app.browserWindow(child);
    await codeWindow.evaluate((win) => win.setContentSize(420, 420));
    const editor = child.getByTestId('code-inspector-source');
    const findButton = child.getByTestId('code-inspector-find');

    for (const language of ['zh-CN', 'en']) {
      if (language === 'en') {
        await page.getByTestId('topbar-settings').click();
        await page.getByTestId('settings-language').click();
        await page.getByRole('option', { name: 'English', exact: true }).click();
        await page.keyboard.press('Escape');
        await expect(page.getByTestId('settings-dialog')).toHaveCount(0);
      }

      await expect(html).toHaveAttribute('lang', language);
      await expect(child.locator('html')).toHaveAttribute('lang', language);
      await platformFont(page.getByTestId('topbar').locator('span.whitespace-nowrap').first(), ui);
      const menu = page.getByTestId('project-menu');
      if (process.platform !== 'darwin') {
        await platformFont(menu, ui);
        await menu.click();
        await platformFont(page.getByRole('menuitem').first(), ui);
        await page.keyboard.press('Escape');
      }

      await page.getByTestId('topbar-settings').click();
      await platformFont(page.getByTestId('settings-language'), ui);
      await page.screenshot({ path: testInfo.outputPath(`settings-${language}.png`) });
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('settings-dialog')).toHaveCount(0);
      await platformFont(findButton, ui);
      await platformFont(editor, mono);
      await findButton.click();
      const find = child.getByTestId('code-inspector-find-input');
      await find.fill('export');
      await expect(child.getByTestId('code-inspector-find-count')).toHaveText(/^1 \/ [1-9]\d*$/);
      expect(await editor.evaluate((field) => field.clientHeight / parseFloat(getComputedStyle(field).lineHeight))).toBeGreaterThanOrEqual(3);
      await child.screenshot({ path: testInfo.outputPath(`code-${language}.png`) });
      await find.press('Escape');
    }

    await noWebFonts(page);
    await noWebFonts(child);
    expect(errors).toEqual([]);
  } finally {
    await launched?.app.close();
    removeUserDataDir(dir);
  }
});
