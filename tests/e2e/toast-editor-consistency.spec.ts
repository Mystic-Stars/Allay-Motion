import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, makeUserDataDir, removeUserDataDir } from './helpers';

const TOAST = 'allay.builtin.advancement-toast';
const SAMPLE = 1;

async function ready(page: Page) {
  await expect.poll(() => page.evaluate(() => window.__allayTest?.previewUpToDate())).toBe(true);
}

async function language(page: Page, option: 'English' | '简体中文' | 'Follow system' | '跟随系统') {
  await page.getByTestId('topbar-settings').click();
  await page.getByTestId('settings-language').click();
  await page.getByRole('option', { name: option, exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('settings-dialog')).toBeHidden();
  await ready(page);
}

async function visibleWorkerHash(page: Page) {
  const sample = await page.evaluate(async () => {
    const hooks = window.__allayTest!;
    const { time, playing } = hooks.transport();
    const { maxAlpha } = await hooks.previewStats(time);
    return { time, playing, maxAlpha, hash: await hooks.previewHash(time) };
  });
  expect(sample).toMatchObject({ time: SAMPLE, playing: false });
  expect(sample.maxAlpha, `主预览 ${sample.time}s 必须包含非透明像素（${sample.hash}）`).toBeGreaterThan(0);
  return sample.hash;
}

async function canvasPixels(app: ElectronApplication, page: Page) {
  const canvas = page.getByTestId('preview-canvas');
  await expect(canvas).toBeVisible();
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('主预览画布没有边界');
  const x = Math.ceil(bounds.x);
  const y = Math.ceil(bounds.y);
  const crop = { x, y, width: Math.floor(bounds.x + bounds.width) - x, height: Math.floor(bounds.y + bounds.height) - y };
  const native = await app.browserWindow(page);
  return native.evaluate(async (window, area) => {
    const image = await window.webContents.capturePage(area, { stayHidden: true, stayAwake: true });
    return image.isEmpty() ? null : image.toBitmap().toString('base64');
  }, crop);
}

test('T-FID.toast-editor 主画布跟随语言重绘，卡片区分默认和当前实例时长', async () => {
  const dir = makeUserDataDir();
  try {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ formatVersion: 1, ui: { onboardingCompleted: true, tourCompleted: true, language: 'zh-CN', theme: 'dark' } }));
    const { app, page } = await launchApp(dir);
    try {
      const card = page.getByTestId(`template-${TOAST}`);
      await expect(card).toHaveAttribute('aria-description', /新建默认：6\.2 秒/);
      await card.click();
      await ready(page);
      const title = page.getByTestId('param-javaTitle');
      await title.fill('钻石！');
      await title.blur();
      await ready(page);
      const original = await page.evaluate(() => window.__allayTest!.project());
      expect(original.params).toMatchObject({ toastStyle: 'javaAdvancement', toastLanguage: 'auto', javaHeader: '', javaTitle: '钻石！' });
      expect(await page.evaluate(() => window.__allayTest!.previewStats(0).then(({ maxAlpha }) => maxAlpha))).toBe(0);
      const emptyCanvas = await canvasPixels(app, page);
      expect(emptyCanvas).not.toBeNull();
      await page.evaluate((time) => window.__allayTest!.setTime(time), SAMPLE);
      await expect(card).toHaveAttribute('aria-description', /当前实例：6\.2 秒/);

      await expect.poll(async () => {
        const pixels = await canvasPixels(app, page);
        return pixels !== null && pixels !== emptyCanvas;
      }).toBe(true);
      const zhCanvas = await canvasPixels(app, page);
      const zhWorker = await visibleWorkerHash(page);
      await language(page, 'English');
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      await expect.poll(async () => {
        const pixels = await canvasPixels(app, page);
        return pixels !== null && pixels !== zhCanvas && pixels !== emptyCanvas;
      }).toBe(true);
      const enWorker = await visibleWorkerHash(page);
      expect(enWorker).not.toBe(zhWorker);
      expect(await page.evaluate(() => window.__allayTest!.project())).toEqual(original);
      expect(await page.evaluate(() => window.__allayTest!.transport())).toMatchObject({ time: SAMPLE, playing: false });

      const followsChinese = await page.evaluate(async () => /^zh/i.test((await window.allay.app.info()).systemLocale));
      await language(page, 'Follow system');
      await expect(page.locator('html')).toHaveAttribute('lang', followsChinese ? 'zh-CN' : 'en');
      expect(await visibleWorkerHash(page)).toBe(followsChinese ? zhWorker : enWorker);
      if (!followsChinese) await language(page, '简体中文');
      await expect.poll(() => canvasPixels(app, page)).toBe(zhCanvas);

      await page.evaluate(() => window.__allayTest!.setParams({ toastLanguage: 'en', javaTiming: 'custom', hold: 5.07 }));
      await ready(page);
      await expect(card).toHaveAttribute('aria-description', /当前实例：6\.27 秒/);
      const explicitEnglish = await visibleWorkerHash(page);
      expect(explicitEnglish).toBe(enWorker);
      const custom = await page.evaluate(() => window.__allayTest!.project());
      await language(page, 'English');
      expect(await visibleWorkerHash(page)).toBe(explicitEnglish);
      expect(await page.evaluate(() => window.__allayTest!.project())).toEqual(custom);
      await expect(card).toHaveAttribute('aria-description', /Current instance: 6\.27 s/);

      await page.getByTestId('param-toastLanguage').click();
      await page.getByRole('option', { name: 'Follow app language', exact: true }).click();
      await ready(page);
      await expect(title).toHaveValue('钻石！');
      expect(await visibleWorkerHash(page)).toBe(explicitEnglish);
      await page.getByTestId('param-toastLanguage').click();
      await page.getByRole('option', { name: 'Simplified Chinese', exact: true }).click();
      await ready(page);
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      await expect(title).toHaveValue('钻石！');
      expect(await visibleWorkerHash(page)).toBe(zhWorker);

      await page.evaluate(() => window.__allayTest!.loadBuiltin());
      await ready(page);
      await expect(card).toHaveAttribute('aria-description', /New template: 6\.2 s/);
    } finally {
      await app.close();
    }
  } finally {
    removeUserDataDir(dir);
  }
});

test('T-FID.toast-editor 合成片段暂停在同一帧时语言切换也会重载', async () => {
  const dir = makeUserDataDir();
  try {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ formatVersion: 1, ui: { onboardingCompleted: true, tourCompleted: true, language: 'en' } }));
    const { app, page } = await launchApp(dir);
    try {
      await page.getByTestId('project-menu').click();
      await page.getByTestId('menu-new-animation').click();
      const card = page.getByTestId('studio-template-library').getByTestId(`template-${TOAST}`);
      await expect(card).toHaveAttribute('aria-description', /New template: 6\.2 s/);
      await card.click();
      await expect(page.getByTestId('studio-clip')).toHaveCount(1);
      await ready(page);
      await page.evaluate((time) => window.__allayTest!.setTime(time), SAMPLE);
      const timecode = page.getByTestId('studio-timecode');
      await expect(timecode).toHaveText('00:01:00');
      await expect(page.getByRole('spinbutton', { name: 'Frame', exact: true })).toHaveValue('60');
      const english = await visibleWorkerHash(page);
      await language(page, '简体中文');
      await expect(timecode).toHaveText('00:01:00');
      await expect(page.getByRole('spinbutton', { name: '帧', exact: true })).toHaveValue('60');
      expect(await visibleWorkerHash(page)).not.toBe(english);
      await expect(card).toHaveAttribute('aria-description', /新建默认：6\.2 秒/);
      await language(page, 'English');
      await expect(timecode).toHaveText('00:01:00');
      await expect(page.getByRole('spinbutton', { name: 'Frame', exact: true })).toHaveValue('60');
      expect(await visibleWorkerHash(page)).toBe(english);
    } finally {
      await app.close();
    }
  } finally {
    removeUserDataDir(dir);
  }
});
