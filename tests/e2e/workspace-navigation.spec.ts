import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, makeUserDataDir, removeUserDataDir } from './helpers';

test('T-STUDIO 合成播放、创作工具往返和追加不丢工程', async () => {
  const dir = makeUserDataDir();
  try {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ formatVersion: 1, ui: { onboardingCompleted: true, tourCompleted: true, language: 'en' } }));
    const { app, page } = await launchApp(dir);
    try {
      const quickTimeline = page.getByTestId('timeline-panel');
      const studioTimeline = page.getByTestId('composition-timeline');
      const code = page.getByTestId('workspace-code-editor');
      const file = page.getByTestId('project-menu');
      const clips = studioTimeline.getByTestId('studio-clip');

      await expect(quickTimeline).toBeVisible();
      await expect(page.getByTestId('studio-navigation')).toHaveCount(0);
      await expect(page.getByTestId('template-allay.builtin.block-wipe')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('template-allay.builtin.studio-object')).toHaveCount(0);

      const showCode = async () => {
        await page.getByRole('button', { name: 'View', exact: true }).click();
        await page.getByTestId('menu-authoring-tools').click();
        await expect(code).toBeVisible();
      };

      await showCode();
      await expect(quickTimeline).toBeVisible();
      await file.click();
      await page.getByTestId('menu-new-animation-from-template').click();
      await expect(code).toBeHidden();
      await expect(studioTimeline).toBeVisible();
      await expect(clips).toHaveCount(1);

      const library = page.getByTestId('studio-template-library');
      await expect(page.getByTestId('left-tab-presets')).toHaveCount(0);
      await library.getByTestId('template-allay.builtin.block-wipe').click();
      await expect(clips).toHaveCount(2);
      await expect(page.getByTestId('project-dirty')).toBeVisible();

      await page.waitForFunction(() => window.__allayTest?.previewUpToDate() === true);
      const readTransport = () => page.evaluate(() => window.__allayTest!.transport());
      const startTime = (await readTransport()).time;
      await studioTimeline.getByRole('button', { name: 'Play', exact: true }).click();
      await expect.poll(async () => {
        const { playing, time } = await readTransport();
        return playing && time > startTime + 0.05;
      }).toBe(true);
      await studioTimeline.getByRole('button', { name: 'Pause', exact: true }).click();
      const paused = await readTransport();
      expect(paused.playing).toBe(false);
      const later = await page.evaluate(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return window.__allayTest!.transport();
      });
      expect(later).toMatchObject({ playing: false, time: paused.time });

      await showCode();
      await code.getByTestId('code-back-to-preview').click();
      await expect(code).toBeHidden();
      await expect(clips).toHaveCount(2);
      await expect(page.getByTestId('project-dirty')).toBeVisible();
      expect(await readTransport()).toMatchObject({ playing: false, time: paused.time });

      const scrub = studioTimeline.getByTestId('studio-scrub').first();
      const lastFrame = Number(await scrub.getAttribute('aria-valuemax'));
      await scrub.press('End');
      await expect(scrub).toHaveAttribute('aria-valuenow', String(lastFrame));
      expect((await readTransport()).time).toBeLessThan(paused.duration);
      await studioTimeline.getByRole('button', { name: 'Play', exact: true }).click();
      await expect.poll(async () => {
        const { playing, time } = await readTransport();
        return playing && time > 0 && time < paused.duration / 2;
      }).toBe(true);
      await studioTimeline.getByRole('button', { name: 'Pause', exact: true }).click();

      await page.getByTestId('topbar-undo').click();
      await expect(clips).toHaveCount(1);
    } finally {
      await app.close();
    }
  } finally {
    removeUserDataDir(dir);
  }
});
