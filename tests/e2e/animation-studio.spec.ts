import { expect, test, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProjectFileSchema } from '../../apps/desktop/src/shared/project';
import { launchApp, makeUserDataDir, removeUserDataDir } from './helpers';

async function newAnimation(page: Page) {
  await page.getByTestId('project-menu').click();
  await page.getByTestId('menu-new-animation').click();
  await expect(page.getByTestId('studio-add')).toBeVisible();
}

test('T-STUDIO 多轨工作台逐帧分割、复制、锁定和保存后重开', async () => {
  const dir = makeUserDataDir();
  const path = join(dir, 'studio.allay');
  try {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ formatVersion: 1, ui: { onboardingCompleted: true, language: 'en', theme: 'dark' } }));
    const { app, page } = await launchApp(dir, { ALLAY_E2E_PROJECT_PATH: path });
    try {
      await newAnimation(page);
      const timeline = page.getByTestId('composition-timeline');
      const add = timeline.getByTestId('studio-add');
      const inspector = page.getByTestId('studio-inspector');
      const scrub = timeline.getByTestId('studio-scrub');
      const frameInput = timeline.getByRole('spinbutton', { name: 'Frame', exact: true });
      const clipActions = inspector.getByRole('button', { name: 'Clip actions' });
      await expect(inspector).toHaveCount(0);
      await add.press('Enter');
      await page.getByRole('menuitem', { name: 'Template…', exact: true }).click();
      await page.getByRole('dialog', { name: 'Choose a template' }).getByRole('button', { name: 'Block wipe 1.0.0', exact: true }).click();
      await expect(timeline.getByTestId('studio-clip')).toHaveCount(1);
      await expect(add).toBeFocused();
      await page.waitForFunction(() => window.__allayTest?.previewUpToDate() === true);
      const ruler = (await scrub.boundingBox())!;
      const y = ruler.y + ruler.height / 2;
      await page.mouse.move(ruler.x + ruler.width / 10, y);
      await page.mouse.down();
      await expect(frameInput).toHaveValue('30');
      await page.mouse.move(ruler.x + ruler.width / 5, y + ruler.height, { steps: 4 });
      await page.mouse.up();
      await expect(frameInput).toHaveValue('60');
      await expect(scrub).toBeFocused();
      await scrub.press('Shift+ArrowLeft');
      await expect(frameInput).toHaveValue('50');
      await frameInput.fill('10');
      await frameInput.press('Enter');
      await expect(timeline.getByTestId('studio-timecode')).toHaveText('00:00:10');
      await inspector.getByRole('tab', { name: 'Transform' }).click();
      const addKey = inspector.getByRole('button', { name: 'Add keyframe', exact: true });
      await addKey.click();
      await expect(timeline.getByTestId('studio-keyframe')).toHaveCount(1);
      await page.getByTestId('topbar').getByRole('button', { name: 'Undo', exact: true }).click();
      await expect(timeline.getByTestId('studio-keyframe')).toHaveCount(0);
      await addKey.click();
      await clipActions.press('Enter');
      await page.getByRole('menuitem', { name: 'Split', exact: true }).press('Enter');
      await expect(timeline.getByTestId('studio-clip')).toHaveCount(2);
      await clipActions.click();
      await page.getByRole('menuitem', { name: 'Duplicate', exact: true }).click();
      await expect(timeline.getByTestId('studio-clip')).toHaveCount(3);
      await add.click();
      await page.getByRole('menuitem', { name: 'Add track', exact: true }).click();
      await expect(inspector).toHaveCount(0);
      const track = timeline.getByTestId('studio-track').first();
      const mute = track.getByRole('button', { name: 'Mute track', exact: true });
      await mute.press('Enter');
      await expect(mute).toHaveAttribute('aria-pressed', 'true');
      await track.getByRole('button', { name: 'Lock track', exact: true }).click();
      await add.click();
      await expect(page.getByRole('menuitem', { name: 'Template…', exact: true })).toBeDisabled();
      await page.keyboard.press('Escape');
      await page.getByTestId('project-menu').click();
      await page.getByTestId('project-save').click();
      await expect(page.getByTestId('project-name')).toHaveText('studio');
      const file = ProjectFileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
      expect(file.formatVersion).toBe(2);
      if (file.formatVersion !== 2) throw new Error('expected v2 project');
      expect(file.composition.tracks.map((track) => [track.locked, track.clips.length])).toEqual([[false, 3], [true, 0]]);
      expect(file.composition.tracks[0]!.clips[1]).toMatchObject({ startFrame: 10, sourceInFrame: 10 });
      expect(file.composition.tracks[1]!.muted).toBe(true);

      await newAnimation(page);
      await expect(timeline.getByTestId('studio-clip')).toHaveCount(0);
      await page.locator('body').focus();
      await page.keyboard.press('Control+KeyO');
      await expect(timeline.getByTestId('studio-clip')).toHaveCount(3);
    } finally {
      await app.close();
    }
  } finally {
    removeUserDataDir(dir);
  }
});

test('T-STUDIO 中文浅色最小窗口中编辑对象内容、切换类型并定位五分钟合成末帧', async () => {
  const dir = makeUserDataDir();
  try {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ formatVersion: 1, ui: { onboardingCompleted: true, language: 'zh-CN', theme: 'light' } }));
    const { app, page } = await launchApp(dir);
    try {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1120, 700));
      await expect(async () => {
        const { width, height } = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
        expect(width).toBeGreaterThanOrEqual(1120);
        expect(width).toBeLessThanOrEqual(1122);
        expect(height).toBeGreaterThanOrEqual(700);
        expect(height).toBeLessThanOrEqual(702);
      }).toPass({ timeout: 5000 });
      await newAnimation(page);
      const timeline = page.getByTestId('composition-timeline');
      const add = timeline.getByTestId('studio-add');
      const frameInput = timeline.getByRole('spinbutton', { name: '帧', exact: true });
      const inspector = page.getByTestId('studio-inspector');
      await add.click();
      await page.getByRole('menuitem', { name: '文字', exact: true }).click();
      const textClip = timeline.getByTestId('studio-clip').first();
      await expect(textClip).toHaveAccessibleName(/^文字 · /);
      const content = inspector.getByRole('tabpanel', { name: '内容' });
      const text = content.getByRole('textbox', { name: '文字', exact: true });
      await expect(text).toBeInViewport();
      await expect(content.getByTestId('param-kind')).toHaveCount(0);
      await expect(content.getByRole('combobox', { name: /^(资源版本|资源档案)$/ })).toHaveCount(0);
      await text.fill('开场标题');
      await text.blur();
      await expect(inspector.getByRole('heading', { name: '开场标题' })).toBeVisible();
      await expect(textClip).toHaveAccessibleName(/^开场标题 · /);
      const clipActions = inspector.getByRole('button', { name: '片段操作' });
      const clipSettings = page.getByRole('dialog', { name: '片段设置', exact: true });
      const openClipSettings = async () => {
        await clipActions.press('Enter');
        await page.getByRole('menuitem', { name: '片段设置…', exact: true }).press('Enter');
        await expect(clipSettings).toBeVisible();
      };
      await openClipSettings();
      const version = clipSettings.getByRole('combobox', { name: '资源版本' });
      await expect(version.locator('option:checked')).toHaveText('跟随工程');
      await expect(version).toBeDisabled();
      const kind = clipSettings.getByRole('combobox', { name: '更换对象类型' });
      await expect(kind).toHaveValue('text');
      await kind.selectOption('sound');
      await clipSettings.getByRole('button', { name: '关闭' }).click();
      await expect(clipActions).toBeFocused();
      await expect(inspector.getByRole('heading', { name: '音频', exact: true })).toBeVisible();
      await expect(text).toHaveCount(0);
      await openClipSettings();
      await expect(kind).toHaveValue('sound');
      await kind.selectOption('text');
      await kind.press('Escape');
      await expect(clipActions).toBeFocused();
      await expect(text).toHaveValue('开场标题');
      const lock = timeline.getByTestId('studio-track').first().getByRole('button', { name: '锁定轨道' });
      await lock.click();
      await expect(lock).toHaveAttribute('aria-pressed', 'true');
      await expect(clipActions).toHaveCount(0);
      await lock.click();
      await expect(text).toHaveValue('开场标题');
      await frameInput.fill('185');
      await frameInput.press('Enter');
      await add.click();
      await page.getByRole('menuitem', { name: '方块', exact: true }).click();
      await expect(inspector.getByRole('heading', { name: '方块' })).toBeVisible();
      await expect(timeline.getByTestId('studio-clip').last()).toHaveAccessibleName(/^方块 · 185–/);
      const more = timeline.getByRole('button', { name: '时间轴操作' });
      await more.click();
      await page.getByRole('menuitem', { name: '动画设置' }).click();
      const settings = page.getByRole('dialog', { name: '动画设置' });
      const total = settings.getByRole('textbox', { name: '总帧数' });
      await total.fill('18000');
      await total.blur();
      await settings.getByRole('button', { name: '关闭' }).click();
      await expect(more).toBeFocused();
      await timeline.getByRole('button', { name: '末帧' }).click();
      await expect(frameInput).toHaveValue('17999');
      await expect(timeline.getByTestId('studio-timecode')).toHaveText('04:59:59');
    } finally {
      await app.close();
    }
  } finally {
    removeUserDataDir(dir);
  }
});
