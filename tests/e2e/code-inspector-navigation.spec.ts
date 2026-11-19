import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, makeUserDataDir, removeUserDataDir } from './helpers';

test('T-STUDIO-CODE-NAV 子窗查找、跳行和真实执行阶段互不覆盖', async () => {
  const dir = makeUserDataDir();
  try {
    const id = 'user.e2e.inspector-navigation';
    const version = '1.0.0';
    const param = 'longParameterNameForInspectorWrapping';
    const value = 'A long value '.repeat(16).trim();
    const templateDir = join(dir, 'templates', id, version);
    const original = [
      'export default {',
      '  setup(ctx) {',
      '    const material = new ctx.THREE.MeshBasicMaterial();',
      '    function unusedDefinition() {',
      '      material.color.setHex(0xffffff);',
      '    }',
      '    const plane = new ctx.THREE.Mesh(new ctx.THREE.PlaneGeometry(ctx.stage.width, ctx.stage.height), material);',
      '    ctx.scene.add(plane);',
      ...Array.from({ length: 100 }, (_, index) => `    // ${index === 25 || index === 75 ? 'needle.token' : 'padding'}`),
      '    return { duration: 2, update(time) {',
      '      if (time < 1) {',
      '        material.color.setHex(0xff0000);',
      '      } else {',
      '        material.color.setHex(0x0000ff);',
      '      }',
      '    } };',
      '  }',
      '};',
      '',
    ].join('\n');
    const lineOf = (fragment: string) => original.split('\n').findIndex((line) => line.includes(fragment)) + 1;
    mkdirSync(templateDir, { recursive: true });
    writeFileSync(join(templateDir, 'template.js'), original);
    writeFileSync(join(templateDir, 'manifest.json'), JSON.stringify({
      formatVersion: 1, id, version, category: 'overlay', name: 'Navigation trace',
      params: [{ key: param, type: 'text', label: 'Long value', default: value }],
    }, null, 2));
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({
      formatVersion: 1, ui: { onboardingCompleted: true, tourCompleted: true, language: 'en' },
    }));

    const { app, page } = await launchApp(dir);
    try {
      await page.getByTestId('gallery-tab-mine').click();
      await page.getByTestId(`template-${id}`).click();
      const opened = app.waitForEvent('window');
      await page.evaluate(() => window.allay.codeInspector!.open());
      const child = await opened;
      await child.waitForURL('**/code-inspector.html');
      const native = await app.browserWindow(child);
      await native.evaluate((win) => win.setContentSize(420, 420));
      const source = child.getByTestId('code-inspector-source');
      const manifest = child.getByTestId('code-inspector-manifest');
      const trace = child.getByTestId('code-inspector-trace-status');
      const current = child.getByTestId('code-inspector-trace-frame');
      const setup = child.getByTestId('code-inspector-trace-setup');
      const row = (line: number) => child.locator(`[data-testid="code-inspector-source-row"][data-line="${line}"]`);
      const frame = page.getByTestId('timeline-panel').getByRole('slider', { name: 'Timeline', exact: true });
      await expect(source).toHaveValue(original);
      await expect(frame).toHaveAttribute('aria-disabled', 'false');
      await frame.press('Home');
      const firstBranch = row(lineOf('0xff0000'));
      const secondBranch = row(lineOf('0x0000ff'));
      await expect(firstBranch).toHaveAttribute('data-hit', 'true');
      await expect(secondBranch).toHaveAttribute('data-hit', 'false');
      const frameColor = await firstBranch.evaluate((element) => getComputedStyle(element).backgroundColor);

      await setup.click();
      await expect(trace).toHaveText(/Initialization lines: [1-9]\d*/);
      await child.getByTestId('code-inspector-go-line').click();
      await child.getByTestId('code-inspector-line-input').fill(String(lineOf('ctx.scene.add')));
      await child.getByTestId('code-inspector-line-input').press('Enter');
      const init = row(lineOf('ctx.scene.add'));
      await expect(init).toHaveAttribute('data-hit', 'true');
      await expect(row(lineOf('0xffffff'))).toHaveAttribute('data-hit', 'false');
      expect(await init.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(frameColor);
      await expect(child.getByTestId('code-inspector-follow')).toBeDisabled();
      await frame.press('End');
      await expect(child.getByTestId('code-inspector-frame-number')).toHaveText(/Frame [1-9]\d*/);
      await expect(init).toHaveAttribute('data-hit', 'true');
      await current.click();
      await expect(secondBranch).toHaveAttribute('data-hit', 'true');
      await expect(firstBranch).toHaveAttribute('data-hit', 'false');
      const follow = child.getByTestId('code-inspector-follow');
      const locate = child.getByTestId('code-inspector-locate');
      await follow.click();
      await expect(follow).toHaveAttribute('aria-pressed', 'true');
      await frame.press('Home');
      await expect(firstBranch).toHaveAttribute('data-hit', 'true');
      await locate.click();
      await expect(follow).toHaveAttribute('aria-pressed', 'false');
      await expect(child.locator('[data-testid="code-inspector-source-row"][data-hit="true"][data-located="true"]')).toHaveCount(1);

      const params = child.getByTestId('code-inspector-params');
      const longParam = params.locator(`[data-param="${param}"]`);
      await expect(longParam.locator('dt')).toHaveText(param);
      await expect(longParam.locator('dd')).toHaveText(JSON.stringify(value));
      expect(await longParam.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await params.locator('summary').click();

      const draft = `// draft preserved\n${original}`;
      await source.fill(draft);
      await expect(trace).toContainText('unapplied draft');
      await setup.click();
      await expect(trace).toContainText('unapplied draft');
      await expect(child.locator('[data-testid="code-inspector-source-row"][data-hit="true"]')).toHaveCount(0);
      await source.evaluate((field: HTMLTextAreaElement) => field.setSelectionRange(3, 8));
      await source.press('ControlOrMeta+f');
      const find = child.getByTestId('code-inspector-find-input');
      const count = child.getByTestId('code-inspector-find-count');
      await expect(find).toBeFocused();
      await find.fill('needle.token');
      await expect(count).toHaveText('1 / 2');
      await find.press('Enter');
      await expect(count).toHaveText('2 / 2');
      await expect.poll(() => source.evaluate((field) => field.scrollTop)).toBeGreaterThan(1000);
      await find.press('ArrowUp');
      await expect(count).toHaveText('1 / 2');
      await find.press('Escape');
      await expect(source).toBeFocused();
      expect(await source.evaluate((field: HTMLTextAreaElement) => [field.selectionStart, field.selectionEnd])).toEqual([3, 8]);

      await source.press('ControlOrMeta+g');
      const go = child.getByTestId('code-inspector-line-input');
      await go.fill('99999');
      await go.press('Enter');
      await expect(go).toHaveAttribute('aria-invalid', 'true');
      await go.fill('4');
      await go.press('Enter');
      await expect(source).toBeFocused();
      const caret = draft.split('\n').slice(0, 3).join('\n').length + 1;
      expect(await source.evaluate((field: HTMLTextAreaElement) => [field.selectionStart, field.selectionEnd])).toEqual([caret, caret]);

      await child.getByTestId('code-inspector-manifest-tab').click();
      await manifest.press('ControlOrMeta+f');
      await find.fill(param);
      await expect(count).toHaveText('1 / 1');
      await find.press('Escape');
      await expect(manifest).toBeFocused();
      await child.getByTestId('code-inspector-source-tab').click();
      await expect(source).toHaveValue(draft);
      await expect(child.getByTestId('preview-canvas')).toHaveCount(0);
      await expect(page.getByTestId('preview-canvas')).toBeVisible();
    } finally {
      await app.close();
    }
  } finally {
    removeUserDataDir(dir);
  }
});
