import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, makeUserDataDir, removeUserDataDir } from './helpers';

test('T-STUDIO-CODE-1 独立窗跟随选中实例、播放和拖帧，关闭重开不重建主预览', async () => {
  const dir = makeUserDataDir();
  try {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ formatVersion: 1, ui: { onboardingCompleted: true, tourCompleted: true, language: 'en' } }));
    const { app, page } = await launchApp(dir);
    try {
      const canvas = page.getByTestId('preview-canvas');
      const ready = () => page.waitForFunction(() => window.__allayTest?.previewUpToDate() === true);
      const openCode = async () => {
        await page.getByRole('button', { name: 'View', exact: true }).click();
        await page.getByTestId('menu-code-editor').click();
      };
      const nextChild = () => app.waitForEvent('window', { predicate: async (window) => {
        await window.waitForURL('**/code-inspector.html');
        return true;
      } });
      await ready();
      await page.getByTestId('project-menu').click();
      await page.getByTestId('menu-new-animation-from-template').click();
      const timeline = page.getByTestId('composition-timeline');
      const clips = timeline.getByTestId('studio-clip');
      await expect(clips).toHaveCount(1);
      await ready();
      const firstOpening = nextChild();
      await openCode();
      const child = await firstOpening;
      await expect(child.getByTestId('code-inspector')).toContainText('Select a clip');
      await expect(canvas).toBeVisible();
      await expect(timeline).toBeVisible();

      await page.getByTestId('studio-template-library').getByTestId('template-allay.builtin.block-wipe').click();
      await expect(clips).toHaveCount(2);
      // 新片段选择由主窗口完成；两个实例故意使用同一个模板。
      const source = child.getByTestId('code-inspector-source');
      await expect(source).toHaveValue(/export/);
      await expect(source).toHaveAttribute('readonly', '');
      const seed = child.getByTestId('code-inspector-params').locator('[data-param="seed"] dd');
      await expect(seed).toHaveText('1');
      const inspector = page.getByTestId('studio-inspector');
      const motion = inspector.getByTestId('param-group-motion');
      await expect(motion).toBeVisible();
      if (await motion.getAttribute('aria-expanded') === 'false') await motion.click();
      const seedInput = inspector.getByRole('textbox', { name: 'Seed', exact: true });
      await expect(seedInput).toBeVisible();
      await seedInput.fill('37');
      await seedInput.press('Enter');
      await expect(seed).toHaveText('37');
      await page.getByTestId('topbar-undo').click();
      await expect(seed).toHaveText('1');
      await page.getByTestId('topbar-redo').click();
      await expect(seed).toHaveText('37');

      // 重叠时同轨上只能点到最上层，键盘可选到下面的片段。
      const other = timeline.locator('[data-testid="studio-clip"][aria-pressed="false"]');
      await other.press('Enter');
      await expect(seed).toHaveText('1');
      await ready();
      const stableCanvas = await canvas.elementHandle();
      await openCode();
      expect(app.windows().filter((window) => window.url().endsWith('/code-inspector.html'))).toEqual([child]);

      const frame = child.getByTestId('code-inspector-frame');
      const frameNumber = child.getByTestId('code-inspector-frame-number');
      const traceStatus = child.getByTestId('code-inspector-trace-status');
      await expect(frameNumber).toHaveText('Frame 0');
      await timeline.getByRole('button', { name: 'Play', exact: true }).click();
      await expect(frame).toContainText('Playing');
      await expect(frameNumber).toHaveText(/^Frame [1-9]\d*$/);
      const scrub = timeline.getByTestId('studio-scrub').first();
      await scrub.press('Home');
      await scrub.press('ArrowRight');
      await expect(frame).toContainText('Paused');
      await expect(frameNumber).toHaveText('Frame 1');
      await expect(traceStatus).toContainText('Executed lines');

      const native = await app.browserWindow(child);
      const closed = child.waitForEvent('close');
      await native.evaluate((window) => window.close());
      await closed;
      await scrub.press('ArrowRight');
      const reopening = nextChild();
      await openCode();
      const reopened = await reopening;
      await expect(reopened.getByTestId('code-inspector-frame-number')).toHaveText('Frame 2');
      await expect(reopened.getByTestId('code-inspector-params').locator('[data-param="seed"] dd')).toHaveText('1');
      await expect(clips).toHaveCount(2);
      await expect(canvas).toBeVisible();
      expect(await stableCanvas?.evaluate((element) => element.isConnected)).toBe(true);
      await reopened.getByTestId('code-inspector-authoring').click();
      await expect(page.getByTestId('workspace-code-editor')).toBeVisible();
      await page.getByTestId('code-back-to-preview').click();
      await expect(canvas).toBeVisible();
    } finally {
      await app.close();
    }
  } finally {
    removeUserDataDir(dir);
  }
});

test('T-STUDIO-CODE-2 合成内复制并试渲脚本，失败保住草稿和已保存文件', async () => {
  const dir = makeUserDataDir();
  try {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ formatVersion: 1, ui: { onboardingCompleted: true, tourCompleted: true, language: 'en' } }));
    const { app, page } = await launchApp(dir);
    try {
      const ready = () => page.waitForFunction(() => window.__allayTest?.previewUpToDate() === true);
      await ready();
      await page.getByTestId('project-menu').click();
      await page.getByTestId('menu-new-animation-from-template').click();
      await page.getByTestId('studio-clip').press('Enter');
      const opened = app.waitForEvent('window');
      await page.getByRole('button', { name: 'View', exact: true }).click();
      await page.getByTestId('menu-code-editor').click();
      const child = await opened;
      await child.waitForURL('**/code-inspector.html');
      await child.getByRole('button', { name: 'Copy as editable script', exact: true }).click();
      const source = child.getByTestId('code-inspector-source');
      await expect(source).toBeEditable({ timeout: 30_000 });
      await ready();

      await child.getByTestId('code-inspector-manifest-tab').click();
      const manifest = await child.getByTestId('code-inspector-manifest').inputValue();
      const { id, version } = JSON.parse(manifest) as { id: string; version: string };
      const file = join(dir, 'templates', id, version, 'template.js');
      const before = readFileSync(file, 'utf8');
      await child.getByTestId('code-inspector-source-tab').click();

      const submit = async () => {
        await child.getByRole('button', { name: 'Test & save', exact: true }).click();
        const confirmation = page.getByRole('dialog', { name: 'Save a shared template?' });
        await expect(confirmation).toContainText('Other clips and projects');
        await confirmation.getByRole('button', { name: 'Save shared template', exact: true }).click();
      };
      const invalid = 'export default { setup() { return { duration: 1, cutTime: 0.5, update() { throw new Error("trial failed"); } }; } };';
      await source.fill(invalid);
      await submit();
      await expect(child.getByTestId('code-inspector-result')).toContainText('Validation failed', { timeout: 30_000 });
      await expect(source).toHaveValue(invalid);
      expect(readFileSync(file, 'utf8')).toBe(before);
      await ready();
      await expect(page.getByTestId('preview-canvas')).toBeVisible();

      const valid = `${before.replace(/\r\n?/g, '\n')}\n// D test save`;
      await source.fill(valid);
      await submit();
      await expect(child.getByTestId('code-inspector-mode')).toHaveText('Editable', { timeout: 30_000 });
      expect(readFileSync(file, 'utf8').replace(/\r\n?/g, '\n')).toBe(valid);
      await ready();
    } finally {
      await app.close();
    }
  } finally {
    removeUserDataDir(dir);
  }
});

test('T-STUDIO-CODE-3 快预览颜色与互斥执行行一致，改参撤销不影响草稿，保存才换代码', async () => {
  const dir = makeUserDataDir();
  try {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ formatVersion: 1, ui: { onboardingCompleted: true, tourCompleted: true, language: 'en' } }));
    const version = '1.0.0';
    const id = 'user.e2e.trace-colors';
    const derivedId = 'user.e2e.trace-colors-derived';
    const templateDir = join(dir, 'templates', id, version);
    const derivedDir = join(dir, 'templates', derivedId, version);
    const file = join(templateDir, 'template.js');
    const manifest = {
      formatVersion: 1, id, version, category: 'overlay', name: 'Trace colors',
      params: [{ key: 'swap', type: 'boolean', label: 'Swap colors', default: false }],
    };
    const original = `export default {
  setup({ THREE, scene, stage, params }) {
    const material = new THREE.MeshBasicMaterial();
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(stage.width, stage.height), material);
    scene.add(plane);
    return { duration: 2, update(time) {
      if ((time < 1) !== params.swap) {
        material.color.setHex(0xff0000);
      } else {
        material.color.setHex(0x0000ff);
      }
    } };
  }
};
`;
    const draft = `// Draft\n${original.replace('0x0000ff', '0x00ff00')}`;
    const redLine = original.split('\n').findIndex((line) => line.includes('0xff0000')) + 1;
    const blueLine = original.split('\n').findIndex((line) => line.includes('0x0000ff')) + 1;
    mkdirSync(templateDir, { recursive: true });
    mkdirSync(derivedDir, { recursive: true });
    writeFileSync(file, original);
    writeFileSync(join(templateDir, 'manifest.json'), JSON.stringify(manifest));
    writeFileSync(join(derivedDir, 'manifest.json'), JSON.stringify({
      formatVersion: 1, id: derivedId, version, category: 'overlay', name: 'Derived trace colors', extends: { id, version },
    }));

    const { app, page } = await launchApp(dir);
    try {
      await page.getByTestId('gallery-tab-mine').click();
      await page.getByTestId(`template-${derivedId}`).click();
      const opening = app.waitForEvent('window');
      await page.getByRole('button', { name: 'View', exact: true }).click();
      await page.getByTestId('menu-code-editor').click();
      const child = await opening;
      await child.waitForURL('**/code-inspector.html');
      const source = child.getByRole('textbox', { name: 'template.js', exact: true });
      const mode = child.getByTestId('code-inspector-mode');
      await expect(child.getByRole('heading', { name: 'Derived trace colors' })).toBeVisible();
      await expect(mode).toHaveText('Read-only');
      await expect(source).toHaveValue(original);
      await expect(child.getByRole('button', { name: 'Copy as editable script', exact: true })).toHaveCount(0);

      await page.getByTestId(`template-${id}`).click();
      await expect(mode).toHaveText('Editable');
      await expect(source).toHaveValue(original);
      const timeline = page.getByTestId('timeline-panel').getByRole('slider', { name: 'Timeline', exact: true });
      await expect(timeline).toHaveAttribute('aria-disabled', 'false');
      const canvas = page.getByTestId('preview-canvas');
      await expect(canvas).toBeVisible();
      const bounds = (await canvas.boundingBox())!;
      const rect = { x: Math.floor(bounds.x + bounds.width / 2), y: Math.floor(bounds.y + bounds.height / 2), width: 4, height: 4 };
      const native = await app.browserWindow(page);
      const expectColor = (color: 'red' | 'blue' | 'green') => expect.poll(async () => {
        const { blue, green, red, alpha } = await native.evaluate(async (window, area) => {
          const image = await window.webContents.capturePage(area, { stayHidden: true });
          const bitmap: Uint8Array = image.toBitmap();
          return { blue: bitmap[0] ?? -1, green: bitmap[1] ?? -1, red: bitmap[2] ?? -1, alpha: bitmap[3] ?? -1 };
        }, rect);
        const channels = { red, green, blue };
        return alpha === 255 && Object.entries(channels).every(([name, value]) => name === color ? value > 220 : value >= 0 && value < 30);
      }, { message: `预览画布中心应为 ${color}` }).toBe(true);
      const hit = (line: number) => child.locator(`[data-testid="code-inspector-source-row"][data-line="${line}"]`);
      const expectBranch = async (taken: number, notTaken: number) => {
        await expect(hit(taken)).toHaveAttribute('data-hit', 'true');
        await expect(hit(notTaken)).toHaveAttribute('data-hit', 'false');
      };

      await timeline.press('Home');
      await expect(child.getByTestId('code-inspector-frame-number')).toHaveText('Frame 0');
      await expectColor('red');
      await expectBranch(redLine, blueLine);
      await timeline.press('End');
      await expect(timeline).toHaveAttribute('aria-valuenow', '120');
      await expect(child.getByTestId('code-inspector-frame-number')).toHaveText('Frame 120');
      await expectColor('blue');
      await expectBranch(blueLine, redLine);

      await source.fill(draft);
      const expectDraft = async () => {
        await expect(mode).toHaveText('Unsaved draft');
        await expect(source).toHaveValue(draft);
        await expect(child.getByTestId('code-inspector-trace-status')).toHaveText('Trace hidden while viewing an unapplied draft');
        await expect(child.locator('[data-testid="code-inspector-source-row"][data-hit="true"]')).toHaveCount(0);
        expect(readFileSync(file, 'utf8')).toBe(original);
      };
      const swap = page.getByRole('switch', { name: 'Swap colors', exact: true });
      const param = child.getByTestId('code-inspector-params').locator('[data-param="swap"] dd');
      await expectDraft();
      await swap.click();
      await expect(param).toHaveText('true');
      await expectColor('red');
      await expectDraft();
      await child.getByRole('button', { name: 'View running version', exact: true }).click();
      await expect(source).toHaveValue(original);
      await expectBranch(redLine, blueLine);
      await page.getByTestId('topbar-undo').click();
      await expect(param).toHaveText('false');
      await expectColor('blue');
      await expectBranch(blueLine, redLine);
      await child.getByRole('button', { name: 'Return to draft', exact: true }).click();
      await expectDraft();

      await child.getByRole('button', { name: 'Test & save', exact: true }).click();
      await expect(mode).toHaveText('Editable');
      expect(readFileSync(file, 'utf8')).toBe(draft);
      await expectColor('green');
      await expectBranch(blueLine + 1, redLine + 1);
    } finally {
      await app.close();
    }
  } finally {
    removeUserDataDir(dir);
  }
});
