import { expect, test } from '@playwright/test';
import { launchApp, makeUserDataDir, removeUserDataDir, type Launched } from './helpers';

test.describe('时间轴与缓动编辑', () => {
  let dir: string;
  let launched: Launched;
  test.beforeEach(async () => {
    dir = makeUserDataDir();
    launched = await launchApp(dir);
    await expect.poll(() => launched.page.evaluate(() => window.__allayTest?.previewUpToDate()), { timeout: 30_000 }).toBe(true);
  });
  test.afterEach(async () => {
    await launched?.app.close();
    removeUserDataDir(dir);
  });

  test('T-UI-2 EXIT 往右延长、往左缩短；取消不改变参数或历史', async () => {
    const { page } = launched;
    const end = page.getByTestId('timeline-exit-end');
    const room = page.getByTestId('timeline-end-room');
    const track = page.getByTestId('transport-track');
    const read = () => page.evaluate(() => ({
      params: window.__allayTest!.project().params,
      duration: window.__allayTest!.transport().duration,
      history: window.__allayTest!.history(),
    }));
    const before = await read();
    const original = Number(before.params.outDuration);
    await expect(room).toBeVisible();
    const drag = async (offset: number) => {
      const handle = (await end.boundingBox())!;
      const lanes = (await track.boundingBox())!;
      const origin = handle.x + handle.width / 2;
      const y = handle.y + handle.height / 2;
      await page.mouse.move(origin, y);
      await page.mouse.down();
      await page.mouse.move(origin + offset, y, { steps: 8 });
      return { origin, width: lanes.width };
    };
    const { origin, width } = await drag(36);
    const expected = Math.round((original + 36 * before.duration / width) * 60) / 60;
    await expect.poll(async () => (await read()).params.outDuration).toBeCloseTo(expected, 6);
    const extended = (await end.boundingBox())!;
    expect(extended.x + extended.width / 2).toBeGreaterThan(origin + 25);
    await page.mouse.up();
    expect((await read()).history.past).toBe(before.history.past + 1);
    await page.getByTestId('topbar-undo').click();
    await expect.poll(async () => (await read()).params).toEqual(before.params);
    await expect.poll(() => page.evaluate(() => window.__allayTest?.previewUpToDate())).toBe(true);

    await drag(-34);
    await expect.poll(async () => Number((await read()).params.outDuration)).toBeLessThan(original);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    expect((await read()).params).toEqual(before.params);
    expect((await read()).history).toEqual({ past: before.history.past, future: before.history.future + 1 });
    await end.press('Shift+ArrowLeft');
    await expect(end).toBeFocused();
    expect(Number((await read()).params.outDuration)).toBeCloseTo(original - 10 / 60, 6);
  });

  test('T-UI-3 阶段、剪辑点和音效菜单操作真实目标', async () => {
    const { page } = launched;
    const menu = page.getByTestId('timeline-context-menu');
    const items = menu.getByRole('menuitem');
    const paused = () => page.evaluate(() => window.__allayTest!.transport());
    const ready = () => expect.poll(() => page.evaluate(() => window.__allayTest?.previewUpToDate())).toBe(true);
    await page.getByTestId('timeline-exit-end').press('ArrowRight');
    const changed = await page.evaluate(() => window.__allayTest!.project().params.outDuration);
    const segment = (await page.getByTestId('timeline-segment-outDuration').boundingBox())!;
    await page.mouse.click(segment.x + segment.width / 2, segment.y + segment.height / 2, { button: 'right' });
    const resetStage = /^(Reset Out duration|重置「退出」的时长)$/;
    await expect(items).toHaveText([
      /^(Go to start of Out|跳到「退出」的开头)$/,
      /^(Go to end of Out|跳到「退出」的结尾)$/,
      resetStage,
    ]);
    await menu.getByRole('menuitem', { name: resetStage }).click();
    await expect.poll(() => page.evaluate(() => window.__allayTest!.project().params.outDuration)).not.toBe(changed);
    await page.getByTestId('topbar-undo').click();
    await expect.poll(() => page.evaluate(() => window.__allayTest!.project().params.outDuration)).toBe(changed);
    await ready();

    const goToCut = /^(Go to cut point|跳到剪辑点)$/;
    const beforeCut = /^(Go to frame before cut|跳到剪辑点的前一帧)$/;
    const cutMarker = (await page.getByTestId('timeline-cut').boundingBox())!;
    await page.mouse.click(cutMarker.x, cutMarker.y + cutMarker.height / 2, { button: 'right' });
    await expect(items).toHaveText([goToCut, beforeCut]);
    await menu.getByRole('menuitem', { name: goToCut }).click();
    const atCut = await paused();
    expect(atCut.cutTime).not.toBeNull();
    expect(atCut.time).toBeCloseTo(atCut.cutTime!, 6);
    await expect(menu).toBeHidden();
    await page.locator('[data-timeline-lane="cut"]').press('Shift+F10');
    await expect(items).toHaveText([goToCut, beforeCut]);
    await menu.getByRole('menuitem', { name: beforeCut }).click();
    const cut = await paused();
    expect(cut.playing).toBe(false);
    expect(cut.time).toBeCloseTo((Math.round(cut.cutTime! * 60) - 1) / 60, 6);

    const audio = page.getByTestId('timeline-cues');
    const markers = audio.locator(':scope > span');
    const mute = page.getByTestId('transport-mute');
    for (const withCues of [false, true]) {
      await page.evaluate((enabled) => window.__allayTest!.setParams({
        inDuration: 0.5, hold: 0.1, outDuration: 0.5, overlap: 1,
        placeSound: enabled ? 'minecraft:block.stone.place' : null,
        breakSound: enabled ? 'minecraft:block.stone.break' : null,
      }), withCues);
      await ready();
      if (withCues) await expect.poll(() => markers.count()).toBeGreaterThan(1);
      else await expect(markers).toHaveCount(0);

      const seek = withCues
        ? /^(Go to sound cue at 00:00:36|跳到 00:00:36 的音效标记)$/
        : /^(Go to 00:00:20|跳到 00:00:20)$/;
      const muted = (await mute.getAttribute('aria-pressed')) === 'true';
      const toggle = muted ? /^(Unmute|取消静音)$/ : /^(Mute|静音)$/;
      const openAudioMenu = async () => {
        await expect(menu).toBeHidden();
        const box = (await audio.boundingBox())!;
        await page.mouse.click(box.x + box.width * (withCues ? 0.75 : 0.30), box.y + box.height / 2, { button: 'right' });
        await expect(items).toHaveText([seek, toggle]);
      };
      await openAudioMenu();
      await menu.getByRole('menuitem', { name: seek }).click();
      const audioSeek = await paused();
      expect(audioSeek.playing).toBe(false);
      expect(audioSeek.time).toBeCloseTo((withCues ? 36 : 20) / 60, 6);
      await openAudioMenu();
      await menu.getByRole('menuitem', { name: toggle }).click();
      await expect(mute).toHaveAttribute('aria-pressed', String(!muted));
    }
  });

  test('T-UI-3 过冲手柄可达且曲线聚焦不吞背景首击', async () => {
    const { page } = launched;
    await page.evaluate(() => window.__allayTest!.setParams({ easing: [0.25, -0.8, 0.75, 2] }));
    const graph = page.getByTestId('param-easing-bezier');
    const point = graph.locator('[data-bezier-handle="1"]');
    await page.evaluate(() => { document.documentElement.dataset.reducedMotion = 'true'; });
    const dot = graph.locator('[data-bezier-preview]');
    await expect.poll(() => dot.getAttribute('transform')).toBeNull();
    await point.scrollIntoViewIfNeeded();
    await point.hover();
    await expect(graph).toHaveAttribute('data-active', 'true');
    const otherRow = page.locator('[data-testid^="param-row-"]').filter({ hasNot: graph }).first();
    await expect(otherRow).toHaveCSS('opacity', '0.42');
    await point.press('Shift+ArrowUp');
    await expect(point).toHaveAttribute('aria-valuetext', '0.75, 2.1');
    await point.hover();
    const box = (await point.boundingBox())!;
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 25);
    await expect(point).not.toHaveAttribute('aria-valuetext', '0.75, 2.1');
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(point).toHaveAttribute('aria-valuetext', '0.75, 2.1');
    const mute = page.getByTestId('transport-mute');
    const muted = await mute.getAttribute('aria-pressed');
    await mute.click();
    await expect(graph).toHaveAttribute('data-active', 'false');
    await expect(otherRow).toHaveCSS('opacity', '1');
    await expect(mute).toHaveAttribute('aria-pressed', muted === 'true' ? 'false' : 'true');
    expect(await dot.getAttribute('transform')).toBeNull();
  });
});
