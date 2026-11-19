import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { Harness } from './harness/harness';

const root = resolve(import.meta.dirname, '../..');
const executablePath = createRequire(join(root, 'apps/desktop/package.json'))('electron') as string;

test('T-STUDIO-OBJ-4 Worker 预览与导出的像素、长音轨采样及裁切', async () => {
  const env = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) =>
    value === undefined || key === 'ELECTRON_RUN_AS_NODE' || key === 'NODE_OPTIONS' ? [] : [[key, value]]));
  const app = await electron.launch({ executablePath, args: [join(import.meta.dirname, 'electron-main.mjs')], env });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => window.harnessReady === true);
    const result: Awaited<ReturnType<Harness['probeStudioObjects']>> = await page.evaluate(() => window.harness.probeStudioObjects());
    const empty = { width: 0, height: 0, center: [0, 0, 0, 0] };
    for (const [kind, object] of Object.entries(result.visuals)) {
      expect(object.cues, kind).toEqual([]);
      expect(object.before, kind).toEqual(empty);
      expect(object.after, kind).toEqual(empty);
      expect(object.first, kind).toEqual(object.last);
      expect(object.previewFrame.width, kind).toBe(object.first.width);
      expect(object.previewFrame.height, kind).toBe(object.first.height);
      const alpha = object.first.center[3]!;
      expect(Math.abs(object.previewFrame.center[3]! - alpha), kind).toBeLessThanOrEqual(1);
      for (const channel of [0, 1, 2]) {
        const premultiplied = object.first.center[channel]! * alpha / 255;
        expect(Math.abs(object.previewFrame.center[channel]! - premultiplied), kind).toBeLessThanOrEqual(2);
      }
      expect(object.deterministic, kind).toBeNull();
      if (kind === 'emptyImage') expect(object.first).toEqual(empty);
      else expect(object.first.width, kind).toBeGreaterThan(0);
    }
    const still = result.visuals.image.first;
    expect(still.width / still.height).toBeCloseTo(2);
    expect(still.center[0]).toBeGreaterThan(248);
    expect(still.center[3]).toBeCloseTo(128, 0);
    expect(result.visuals.alternateText.first.width).toBeGreaterThan(result.visuals.text.first.width);
    expect(result.visuals.block.first.center[2]).toBeGreaterThan(150);
    expect(result.visuals.packedBlock.first.center[1]).toBeGreaterThan(150);
    expect(result.audioPixels).toEqual([empty, empty, empty]);
    expect(result.audioPreview).toEqual(empty);
    expect(result.cues).toEqual([expect.objectContaining({ at: 1, clip: { offset: 120, end: 300 } })]);
    expect(result.duration).toBe(300);
    expect(result.wavBytes).toBe(44 + 300 * 48_000 * 4);
    expect(result.samples).toEqual([0, expect.closeTo(0.2), 0, expect.closeTo(0.6), 0, 0]);
    expect(result.sought).toBeCloseTo(0.6);
    expect(result.cutSamples).toEqual([expect.closeTo(0.2), 0]);
  } finally {
    await app.close();
  }
});
