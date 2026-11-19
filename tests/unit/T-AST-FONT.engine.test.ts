import { expect, it, vi } from 'vitest';
import { parseUnihex } from '../../packages/assets/src/index';
import { EngineResources } from '../../packages/engine/src/resources';
import { setupText } from '../../packages/engine/src/text';
import { DEFAULT_FONT_ID, FALLBACK_FONT_ID, FontRefSchema, FrameStatsSchema, normalizeRequestedFont, type FontPayload } from '../../packages/template-sdk/src/index';

const imported = `user-font:${'a'.repeat(64)}`;

it('T-AST-FONT 旧引用可读，但引擎不向宿主请求旧字体；换资源代后重新解析默认字体', async () => {
  const payload: FontPayload = { kind: 'font', skipped: [], providers: [{ type: 'space', advances: [[32, 4]] }] };
  const resolver = vi.fn(async () => payload);
  const resources = new EngineResources(resolver, vi.fn());
  expect(FontRefSchema.safeParse(FALLBACK_FONT_ID).success).toBe(true);
  expect(FontRefSchema.safeParse(imported).success).toBe(true);
  for (const input of [undefined, FALLBACK_FONT_ID, imported, 'user-font:not-a-hash', 'pack:../font']) {
    expect(normalizeRequestedFont(input)).toBe(DEFAULT_FONT_ID);
  }
  expect(normalizeRequestedFont('pack:titles/main')).toBe('pack:titles/main');
  await Promise.all([resources.fonts(), resources.fonts(imported), resources.fonts(FALLBACK_FONT_ID), resources.fonts('pack:titles/main')]);
  expect(resolver.mock.calls).toEqual([['font', DEFAULT_FONT_ID], ['font', 'pack:titles/main']]);
  resources.setStamp('new-stack');
  await resources.fonts(imported);
  expect(resolver).toHaveBeenCalledTimes(3);
  expect(resolver).toHaveBeenLastCalledWith('font', DEFAULT_FONT_ID);
  expect(FrameStatsSchema.safeParse({ t: 0, ms: 0, fontUsage: [{ flags: 4 }] }).success).toBe(true);
});

it('T-AST-FONT 资源选择逐字覆盖；自选缺字或整个字体缺失时回游戏默认', async () => {
  const makeFont = (text: string, rows: string): FontPayload => ({ kind: 'font', skipped: [], providers: [
    { type: 'unihex', tables: parseUnihex([...text].map((char) => `${char.codePointAt(0)!.toString(16).padStart(4, '0')}:${rows.repeat(16)}`).join('\n'))! },
  ] });
  const vanilla = makeFont('A中', '8001');
  const selected = makeFont('A', '30');
  const load = vi.fn(async (id: string) => id === DEFAULT_FONT_ID ? vanilla : id === 'pack:title' ? selected : null);
  const owned: Parameters<typeof setupText>[3] = [];
  const warn = vi.fn();
  let setup = true;
  const painter = await setupText([FALLBACK_FONT_ID, imported, 'pack:title', 'pack:absent'], load, warn, owned, () => setup);
  expect(load.mock.calls).toEqual([[DEFAULT_FONT_ID], ['pack:title'], ['pack:absent']]);
  const expected = { advance: 18, width: 18, left: 0, above: 7, below: 1 };
  for (const alias of [undefined, FALLBACK_FONT_ID, imported, 'pack:absent']) expect(painter.measureGui('A中', alias)).toEqual(expected);
  expect(painter.measureGui('A中', 'pack:title')).toEqual({ ...expected, advance: 11, width: 11 });
  expect(owned).toHaveLength(0);
  try {
    const first = painter.create({ text: 'A中', size: 1, origin: 'guiBaseline', font: 'pack:title' });
    expect([first.width, first.height]).toEqual([11, 8]);
    painter.create({ text: 'A中', size: 1, origin: 'guiBaseline', font: imported });
    painter.create({ text: 'A中', size: 1, origin: 'guiBaseline', font: 'pack:title' });
    expect(owned[0]!.image).toEqual(owned[2]!.image);
    expect(owned[0]!.image).not.toEqual(owned[1]!.image);
    expect(warn.mock.calls).toEqual([['text: font pack:absent is unavailable; using minecraft:default and system fallback']]);
    setup = false;
    await painter.prepare('pack:late');
    expect(load).not.toHaveBeenCalledWith('pack:late');
  } finally {
    owned.forEach((texture) => texture.dispose());
  }
});
