import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp, makeUserDataDir, removeUserDataDir } from './helpers';

async function watchUpdateRequests(app: ElectronApplication) {
  await app.evaluate(() => {
    const requests: string[] = [];
    Object.assign(globalThis, { updateRequestsForTest: requests });
    globalThis.fetch = async (input) => {
      requests.push(input instanceof Request ? input.url : String(input));
      throw new Error('此测试不允许主进程访问网络');
    };
  });
  return () => app.evaluate(() => Reflect.get(globalThis, 'updateRequestsForTest') as string[]);
}

async function openUpdates(page: Page) {
  await page.getByTestId('topbar-settings').click();
  await page.getByTestId('settings-tab-updates').click();
  return page.getByTestId('updates-channel');
}

test('更新渠道切换后保留设置，重启后主进程与界面仍使用 dev', async () => {
  const userData = makeUserDataDir();
  const settingsFile = join(userData, 'settings.json');
  const oldPrefs = { mode: 'off', source: 'gitcode', skipVersion: null };
  try {
    await writeFile(settingsFile, JSON.stringify({ formatVersion: 1, ui: { onboardingCompleted: true, tourCompleted: true, updates: oldPrefs } }));
    const first = await launchApp(userData);
    try {
      const requests = await watchUpdateRequests(first.app);
      const select = await openUpdates(first.page);
      await expect(select).toHaveText('main');
      for (const [channel, label] of [['codex', 'Codex'], ['main', 'main'], ['dev', 'dev']] as const) {
        await select.click();
        await first.page.getByRole('option', { name: label, exact: true }).click();
        await expect(select).toHaveText(label);
        await expect.poll(() => first.page.evaluate(() => window.allay.settings.get())).toMatchObject({ updates: { ...oldPrefs, channel } });
        await expect(select).toBeEnabled();
        expect(await first.page.evaluate(() => window.allay.updates.state())).toMatchObject({ channel, preferredSource: 'gitcode', checkedAt: null });
      }
      await delay(1_200);
      expect(await requests()).toEqual([]);
    } finally {
      await first.app.close();
    }

    expect(JSON.parse(await readFile(settingsFile, 'utf8'))).toMatchObject({ ui: { updates: { ...oldPrefs, channel: 'dev' } } });
    const restarted = await launchApp(userData);
    try {
      const requests = await watchUpdateRequests(restarted.app);
      expect(await restarted.page.evaluate(() => window.allay.updates.state())).toMatchObject({ channel: 'dev', preferredSource: 'gitcode', checkedAt: null });
      const select = await openUpdates(restarted.page);
      await expect(select).toHaveText('dev');
      await expect(restarted.page.getByTestId('updates-status')).toHaveAttribute('data-status', /^(idle|unsupported)$/);
      expect(await requests()).toEqual([]);
    } finally {
      await restarted.app.close();
    }
  } finally {
    removeUserDataDir(userData);
  }
});
