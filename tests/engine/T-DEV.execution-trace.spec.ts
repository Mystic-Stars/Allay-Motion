import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type * as TraceHarness from './trace-harness/probe';

declare global {
  interface Window { executionTraceHarness: typeof TraceHarness }
}

const root = resolve(import.meta.dirname, '../..');
const executablePath = createRequire(join(root, 'apps/desktop/package.json'))('electron') as string;
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  const { build } = await import('vite');
  await build({
    configFile: false, root: join(import.meta.dirname, 'trace-harness'), base: './', logLevel: 'warn',
    build: { outDir: join(import.meta.dirname, 'out/execution-trace'), emptyOutDir: false, target: 'es2023' },
    worker: { format: 'es' },
  });
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE' && key !== 'NODE_OPTIONS') env[key] = value;
  }
  app = await electron.launch({ executablePath, args: [join(import.meta.dirname, 'electron-main.mjs')], env });
  page = await app.firstWindow();
  await page.goto('harness://engine/execution-trace/index.html');
  await page.waitForFunction(() => Boolean(window.executionTraceHarness));
});

test.afterAll(async () => { await app?.close(); });

function probe<Name extends keyof typeof TraceHarness>(name: Name): Promise<Awaited<ReturnType<(typeof TraceHarness)[Name]>>> {
  return page.evaluate<unknown, keyof typeof TraceHarness>(async (key) => window.executionTraceHarness[key](), name) as Promise<Awaited<ReturnType<(typeof TraceHarness)[Name]>>>;
}

test('T-DEV-TRACE 真实预览 Worker 执行分支、辅助函数、早退及子帧的并集，像素无变化', async () => {
  const result = await probe('probeExecutionTrace');
  expect(result.early).toEqual([7, 9, 10]);
  expect(result.left).toEqual([1, 2, 7, 9, 11, 12, 13, 14, 16]);
  expect(result.right).toEqual([1, 3, 7, 9, 11, 12, 13, 14, 15, 16]);
  expect(result.both).toEqual([...new Set([...result.left!, ...result.right!])].sort((left, right) => left - right));
  expect(result.seek).toEqual(result.left);
  expect(result.error).toMatchObject({ kind: 'update', code: 'update-threw', line: 16, column: 27 });
  expect(result.off).toBeUndefined();
  expect(result.unavailable).toBeUndefined();
  expect(result.reloaded).toEqual(result.left!.map((line) => line + 1));
  expect(result.exactSource && result.hasVisiblePixels && result.equalPixels).toBe(true);
});

test('T-DEV-TRACE 重叠的同版本实例只记录所选片段，切换、版本不符及片段不在场均无残留', async () => {
  const result = await probe('probeTraceComposition');
  expect(result.red).toContain(2);
  expect(result.red).not.toContain(3);
  expect(result.blue).toContain(3);
  expect(result.blue).not.toContain(2);
  expect(result.inactive).toBeUndefined();
  expect(result.wrongVersion).toBeUndefined();
  expect(result.equalPixels).toBe(true);
});

test('T-DEV-TRACE 初始化跨 await 只记录真实分支，改参、切换实例与重开不会串行号或重复执行', async () => {
  const { first, reopened, changed, late, a, b, inactive, back, setupCalls } = await probe('probeSetupTrace');
  expect(first.setup?.lines).toEqual([2, 3, 5, 12, 13, 15]);
  expect(first.trace).toEqual([15, 16]);
  expect(reopened).toEqual(first);
  expect(changed.setup?.lines).toEqual([2, 3, 4, 12, 13, 14, 15]);
  expect(late).toEqual(first);
  expect(setupCalls).toEqual({
    initialLoad: 1, reopened: 1, paramsChanged: 2, paramsRendered: 2, untracedLoad: 3, lateSelection: 4, lateReopened: 4,
    compositionLoaded: 6, secondClipSelected: 7, firstClipReselected: 7,
  });
  expect(a.setup).toMatchObject({ clipId: 'a', lines: first.setup!.lines });
  expect(b.setup).toMatchObject({ clipId: 'b', lines: changed.setup!.lines });
  expect(inactive.setup).toEqual(b.setup);
  expect(inactive.trace).toBeUndefined();
  expect(back).toEqual(a);
});

test('T-AST-FONT 实际绘制才报告系统回退，确认逐行来源、旧引用与合成实例隔离', async () => {
  const { results, overlap, single, flags, requested } = await probe('probeFontUsage');
  const whole = flags.whole | flags.resourceDefault;
  const partial = flags.partial | flags.resourceDefault;
  expect(requested).toEqual(['minecraft:default', 'test:complete']);
  expect(results).toEqual([[], [], [whole], [partial], [whole | partial], [partial], [], [], [whole]]);
  expect(overlap).toEqual([{ clipId: 'whole', flags: whole }, { clipId: 'partial', flags: partial }]);
  expect(single).toEqual([{ clipId: 'partial', flags: whole | partial }]);
});

test('T-AST-FONT 空栈英中日韩有各自的系统墨迹、空格不画，预览与导出一致', async () => {
  const { requested, warnings, flags, anyInk, anyEdge, equal } = await probe('probeSystemFont');
  const samples = warnings.filter((message) => message.startsWith('glyph-test:')).map((message) => JSON.parse(message.slice('glyph-test:'.length)) as {
    width: number; height: number; hash: number; ink: boolean; edge: boolean; geometry: [number, number]; bounds: [number, number, number];
    measure: { advance: number; width: number; left: number; above: number; below: number };
  });
  expect(samples).toHaveLength(8);
  for (const sample of [...samples.slice(0, 4), samples[5]!, samples[6]!]) {
    expect(sample.ink && sample.edge).toBe(true);
    expect(sample.height).toBeGreaterThan(30);
    expect(sample.measure.above).toBeLessThan(12);
    expect(sample.geometry).toEqual([sample.measure.width, sample.measure.above + sample.measure.below]);
    expect(sample.bounds).toEqual([sample.measure.left, -sample.measure.below, sample.measure.above]);
  }
  expect(new Set(samples.slice(0, 4).map(({ hash }) => hash)).size).toBe(4);
  expect(samples[4]).toMatchObject({ ink: false, measure: { left: 0, above: 0, below: 0 } });
  expect(samples[4]!.measure.advance).toBeGreaterThan(0);
  expect(samples[6]!.measure.below).toBeGreaterThan(0);
  expect(samples[7]).toMatchObject({ ink: false, measure: { advance: samples[4]!.measure.advance * 4, above: 0, below: 0 } });
  expect(warnings.filter((message) => message.includes('no glyph'))).toEqual(['text: 1 character(s) have no glyph in any font (U+10FFFD)']);
  expect(warnings).toContain('font-globals:undefined/undefined/undefined');
  expect(requested).toEqual(['minecraft:default', 'minecraft:default']);
  expect(flags).toEqual([{ flags: 9 }]);
  expect(anyInk && anyEdge && equal).toBe(true);
});
