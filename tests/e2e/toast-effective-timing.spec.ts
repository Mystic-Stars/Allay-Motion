import { expect, test, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { catalogJarEntries, makeCatalogGame } from '../unit/helpers/resource-fixtures';
import { launchApp, makeUserDataDir, removeUserDataDir } from './helpers';

const template = { id: 'allay.builtin.advancement-toast', version: '1.0.0' };
const keys = ['inDuration', 'hold', 'outDuration'] as const;
const originalDurations = { inDuration: 0.25, hold: 2.5, outDuration: 0.25 };

async function ready(page: Page) {
  await expect.poll(() => page.evaluate(() => window.__allayTest?.previewUpToDate())).toBe(true);
}

async function expectPhases(page: Page, durations: readonly [number, number, number], editable: boolean) {
  await ready(page);
  await expect.poll(() => page.evaluate(() => window.__allayTest!.transport().duration)).toBeCloseTo(durations[0] + durations[1] + durations[2], 8);
  for (const [index, key] of keys.entries()) {
    const value = durations[index]!;
    await expect(page.getByTestId(`timeline-segment-${key}`)).toHaveAttribute('data-duration', String(value));
    const info = page.getByTestId(`param-${key}`);
    if (editable) {
      const input = info.getByRole('textbox');
      await expect(input).toBeEditable();
      await expect.poll(async () => Number(await input.inputValue())).toBeCloseTo(value, 3);
    } else {
      await expect(info.getByRole('status')).toHaveText(`${value.toFixed(3).replace(/0$/, '')} s`);
      await expect(info.locator('input')).toHaveCount(0);
    }
  }
  await expect(page.getByTestId('timeline-boundary-0')).toHaveCount(editable ? 1 : 0);
  await expect(page.getByTestId('timeline-boundary-1')).toHaveCount(editable ? 1 : 0);
  await expect(page.getByTestId('timeline-exit-end')).toHaveCount(editable ? 1 : 0);
}

test('T-FID.toast-effective-timing 26.3 资源不改变旧工程样式，阶段跟随实际节拍', async () => {
  const dir = makeUserDataDir();
  const appData = join(dir, 'game');
  const projectPath = join(dir, 'classic.allay');
  try {
    makeCatalogGame(join(appData, '.minecraft'), '26.3', '2026-11-01T00:00:00+00:00', catalogJarEntries([], {}));
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({
      formatVersion: 1,
      ui: { onboardingCompleted: true, tourCompleted: true, language: 'en' },
      resources: { vanilla: { consent: true, enabled: true, dir: join(appData, '.minecraft') }, packs: [] },
    }));
    writeFileSync(projectPath, JSON.stringify({ formatVersion: 1, name: 'Classic', template, params: { toastStyle: 'javaAdvancement', javaTiming: 'auto', ...originalDurations } }));
    const { app, page } = await launchApp(dir, { ALLAY_E2E_GAME_APPDATA: appData, ALLAY_E2E_PROJECT_PATH: projectPath });
    try {
      await page.getByTestId('project-menu').click({ timeout: 5_000 });
      await page.getByTestId('project-open').click();
      await ready(page);
      await expect.poll(() => page.evaluate(() => {
        const library = window.__allayTest!.resourceState()?.library;
        return library?.profiles.find(({ id }) => id === library.activeProfileId)?.versionId;
      })).toBe('26.3');
      const params = () => page.evaluate(() => window.__allayTest!.project().params);
      expect(await params()).toMatchObject({ toastStyle: 'javaAdvancement', javaTiming: 'auto', ...originalDurations });
      await expectPhases(page, [0.6, 5, 0.6], false);

      await page.getByTestId('param-javaTiming').click();
      await page.getByRole('option', { name: 'Always use durations below' }).click();
      await expectPhases(page, [0.25, 2.5, 0.25], true);
      await page.getByTestId('timeline-boundary-1').press('Shift+ArrowRight');
      const editedHold = 160 / 60;
      await expectPhases(page, [0.25, editedHold, 0.25], true);
      await page.getByTestId('param-javaTiming').click();
      await page.getByRole('option', { name: 'Vanilla durations only' }).click();
      await expectPhases(page, [0.6, 5, 0.6], false);
      expect(await params()).toMatchObject({ javaTiming: 'vanilla', hold: editedHold });
      await page.getByTestId('topbar-undo').click();
      await expectPhases(page, [0.25, editedHold, 0.25], true);

      await page.getByTestId('param-javaTiming').click();
      await page.getByRole('option', { name: 'Auto (keep edited durations)', exact: true }).click();
      await expectPhases(page, [0.25, editedHold, 0.25], true);
      await page.evaluate(() => window.__allayTest!.setParams({ toastStyle: 'javaAchievement', inDuration: 0.25, hold: 2.5, outDuration: 0.25 }));
      await expectPhases(page, [0.375, 2.25, 0.375], false);
      expect(await params()).toMatchObject({ toastStyle: 'javaAchievement', javaTiming: 'auto', ...originalDurations });
    } finally {
      await app.close();
    }
  } finally {
    removeUserDataDir(dir);
  }
});

test('T-FID.toast-effective-timing 合成片段的只读阶段按实例区分', async () => {
  const dir = makeUserDataDir();
  const projectPath = join(dir, 'composition.allay');
  try {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ formatVersion: 1, ui: { onboardingCompleted: true, tourCompleted: true, language: 'en' } }));
    writeFileSync(projectPath, JSON.stringify({
      formatVersion: 2, name: 'Timing', output: { width: 1920, height: 1080, fps: 60 },
      export: { preset: 'prores4444', quality: 'standard', shutterAngle: 180 }, preview: { background: 'checker' }, resourceHint: [],
      composition: { formatVersion: 1, fps: 60, durationFrames: 480, tracks: [{ id: 'track', name: 'Track', locked: false, muted: false, clips: [
        { id: 'classic', template, startFrame: 0, sourceInFrame: 0, durationFrames: 372, params: { toastStyle: 'javaAdvancement', javaTiming: 'vanilla', hold: 1 } },
        { id: 'legacy', template, startFrame: 372, sourceInFrame: 0, durationFrames: 108, params: { toastStyle: 'javaAchievement', javaTiming: 'auto' } },
      ] }] },
    }));
    const { app, page } = await launchApp(dir, { ALLAY_E2E_PROJECT_PATH: projectPath });
    try {
      await page.getByTestId('project-menu').click();
      await page.getByTestId('project-open').click();
      await ready(page);
      const clips = page.getByTestId('studio-clip');
      await expect(clips).toHaveCount(2);
      await clips.nth(0).click();
      const inspector = page.getByTestId('studio-inspector');
      await expect(inspector.getByTestId('param-hold').getByRole('status')).toHaveText('5.00 s');
      await clips.nth(1).click();
      await expect(inspector.getByTestId('param-inDuration').getByRole('status')).toHaveText('0.375 s');
      await expect(inspector.getByTestId('param-hold').getByRole('status')).toHaveText('2.25 s');
      await clips.nth(0).click();
      await inspector.getByTestId('param-javaTiming').click();
      await page.getByRole('option', { name: 'Always use durations below' }).click();
      await ready(page);
      await expect(inspector.getByTestId('param-hold').getByRole('textbox')).toHaveValue('1.00');
    } finally {
      await app.close();
    }
  } finally {
    removeUserDataDir(dir);
  }
});
