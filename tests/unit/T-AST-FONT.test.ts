import { describe, expect, it } from 'vitest';
import { fontPathToId, outlineCoverage, parseFontJson, parseUnihex, resolveFontProviders } from '../../packages/assets/src/index';
import { setupText } from '../../packages/engine/src/text';
import { FontRefSchema, type FontPayload } from '../../packages/template-sdk/src/index';
import { readUnihexArchive } from '../../apps/desktop/src/main/fonts/unihex';
import { buildZip } from './helpers/resource-fixtures';

// 只合成 cmap 测试表；不含轮廓和真实字体文件。
function fakeSfnt(signature = 0x00010000): Uint8Array {
  const bytes = new Uint8Array(160);
  const data = new DataView(bytes.buffer);
  data.setUint32(0, signature);
  data.setUint16(4, 3);
  const tables = [[0x68656164, 60, 54], [0x6d617870, 114, 6], [0x636d6170, 120, 40]];
  tables.forEach(([tag, start, size], index) => {
    data.setUint32(12 + index * 16, tag!);
    data.setUint32(20 + index * 16, start!);
    data.setUint32(24 + index * 16, size!);
  });
  data.setUint16(118, 2);
  data.setUint16(122, 1);
  data.setUint16(124, 3);
  data.setUint16(126, 10);
  data.setUint32(128, 12);
  data.setUint16(132, 12);
  data.setUint32(136, 28);
  data.setUint32(144, 1);
  data.setUint32(148, 0x20000);
  data.setUint32(152, 0x20000);
  data.setUint32(156, 1);
  return bytes;
}

type Mask = { width: number; height: number; alpha: Uint8Array };

function actualMask(texture: Parameters<typeof setupText>[3][number]): Mask {
  const { width, height, data } = texture.image as { width: number; height: number; data: Uint8Array };
  return { width, height, alpha: Uint8Array.from({ length: width * height }, (_, pixel) =>
    data[((height - 1 - Math.floor(pixel / width)) * width + pixel % width) * 4 + 3]!) };
}

function putMask(destination: Mask, source: Mask, left: number, top: number, scale = 1) {
  for (let row = 0; row < source.height * scale; row++) {
    for (let col = 0; col < source.width * scale; col++) {
      destination.alpha[(top + row) * destination.width + left + col] = source.alpha[Math.floor(row / scale) * source.width + Math.floor(col / scale)]!;
    }
  }
}

function emptyMask(width: number, height: number): Mask {
  return { width, height, alpha: new Uint8Array(width * height) };
}

describe('T-AST-FONT 动画字体', () => {
  it('区分字体 ID、文件引用和路径；解析 Java 提供器字段', () => {
    expect(fontPathToId('assets/example/font/hud/title.json')).toBe('example:hud/title');
    expect(fontPathToId('assets/example/font/../title.json')).toBeNull();
    expect(FontRefSchema.safeParse('C:/Windows/font.ttf').success).toBe(false);
    const { providers } = parseFontJson(JSON.stringify({ providers: [
      { type: 'ttf', file: 'example:main.otf', size: 12, oversample: 2, shift: [1, -1], skip: ['A', '字'] },
      { type: 'unihex', hex_file: 'example:cjk.zip', size_overrides: [{ from: '中', to: '中', left: 1, right: 3 }] },
      { type: 'ttf', file: 'example:../main.otf' },
    ] }));
    expect(providers).toEqual([
      { type: 'ttf', file: 'assets/example/font/main.otf', size: 12, oversample: 2, shift: [1, -1], skip: 'A字' },
      { type: 'unihex', file: 'assets/example/cjk.zip', overrides: [{ from: 0x4e2d, to: 0x4e2d, left: 1, right: 3 }] },
    ]);
  });

  it('识别 TTF/OTF cmap 覆盖，不用系统字体填充未知码位', () => {
    for (const signature of [0x00010000, 0x4f54544f]) {
      const bytes = fakeSfnt(signature);
      expect(outlineCoverage(bytes)?.(0x20000)).toBe(true);
      expect(outlineCoverage(bytes)?.(0x20001)).toBe(false);
      expect(outlineCoverage(bytes.slice(0, 30))).toBeNull();
    }
  });

  it('仅兼容对象和数组尾逗号，保留字符串中的标点及转义', () => {
    const skip = ',] ,} \\" \\\\';
    const encoded = JSON.stringify(skip);
    const strict = `{"providers":[{"type":"ttf","file":"test:main.ttf","skip":${encoded}},{"type":"space","advances":{" ":4}}]}`;
    const trailing = `\uFEFF{"providers":[{"type":"ttf","file":"test:main.ttf","skip":${encoded},\n},{"type":"space","advances":{" ":4,\r}},\t], }`;
    expect(() => JSON.parse(trailing.slice(1))).toThrow();
    expect(parseFontJson(trailing)).toEqual(parseFontJson(strict));
    expect(parseFontJson(trailing).providers[0]).toMatchObject({ skip });
  });

  it.each(['[,]', '{,}', '[1,,]', '[,1,]', '[1,,2,]', '{"a":,}', '{"a":1,,}',
    '[1,/* 注释 */]', '[1,// 注释\n]', '[01,]', '[undefined,]', '["\\x00",]', '[1,\u00a0]', '[1,}',
  ])('尾逗号兼容仍拒绝坏 JSON：%j', (invalid) => {
    expect(parseFontJson(`{"providers":[],"fixture":${invalid},}`).skipped).toEqual(['invalid-json']);
  });

  it('拒绝超过字体 JSON 上限的兼容输入', () => {
    expect(parseFontJson(`{"providers":[${' '.repeat(4 * 1024 * 1024)}],}`).skipped).toEqual(['invalid-json']);
  });

  it('展开尾逗号定义的引用并解码合成 Unihex 字形', async () => {
    const definitions = new Map([
      ['assets/test/font/default.json', '{"providers":[{"type":"reference","id":"test:include/cjk",},],}'],
      ['assets/test/font/include/cjk.json', '{"providers":[{"type":"unihex","hex_file":"test:font/cjk.zip","size_overrides":[{"from":"中","to":"中","left":0,"right":7,},],},],}'],
    ]);
    const { providers, skipped } = await resolveFontProviders('test:default', async (path) => {
      const definition = definitions.get(path);
      return definition ? [parseFontJson(definition)] : null;
    });
    expect(skipped).toEqual([]);
    expect(providers).toHaveLength(1);
    const [provider] = providers;
    if (provider?.type !== 'unihex') throw new Error('没有解析到 Unihex 提供器');
    expect(provider.file).toBe('assets/test/font/cjk.zip');
    const archive = buildZip([{ name: 'synthetic.hex', data: `4E2D:${'18'.repeat(16)}` }]);
    const glyphs = await readUnihexArchive(archive, provider.overrides);
    expect(glyphs?.codepoints).toEqual(new Uint32Array([0x4e2d]));
    expect(glyphs?.metrics[1]).toBe(8);
  });

  it('GUI Unihex 单独及与高清位图混排：完整源遮罩、alpha 和基线不变', async () => {
    const hexRows = Array.from({ length: 16 }, (_, row) => row % 2 ? '4081' : '8202');
    const tables = parseUnihex(`4E2D:${hexRows.join('')}`)!;
    const unihex = { width: 16, height: 16, alpha: Uint8Array.from(hexRows.flatMap((hex) =>
      [...Number.parseInt(hex, 16).toString(2).padStart(16, '0')].map((bit) => bit === '1' ? 255 : 0))) };
    const bitmap = { width: 12, height: 16, alpha: Uint8Array.from({ length: 12 * 16 }, (_, pixel) =>
      (pixel % 12 + Math.floor(pixel / 12)) % 3 === 0 ? 64 + pixel % 128 : 0) };
    const rgba = new Uint8Array(bitmap.alpha.length * 4);
    bitmap.alpha.forEach((alpha, index) => { rgba[index * 4 + 3] = alpha; });
    const vanilla: FontPayload = { kind: 'font', skipped: [], providers: [
      { type: 'unihex', tables },
      { type: 'bitmap', ascent: 7, height: 8, rows: [[66]], image: { width: 12, height: 16, data: rgba } },
    ] };
    const owned: Parameters<typeof setupText>[3] = [];
    const painter = await setupText([], async () => vanilla, () => undefined, owned, () => true);
    try {
      painter.create({ text: '中', size: 1, origin: 'guiBaseline' });
      const solo = emptyMask(18, 16);
      putMask(solo, unihex, 0, 0);
      expect(actualMask(owned[0]!)).toEqual(solo);

      const mixed = emptyMask(32, 16);
      putMask(mixed, bitmap, 0, 0);
      putMask(mixed, unihex, 14, 0);
      expect(painter.measureGui('B中')).toEqual({ width: 16, advance: 16, left: 0, above: 7, below: 1 });
      const label = painter.create({ text: 'B中', size: 1, origin: 'guiBaseline' });
      expect([label.width, label.height]).toEqual([16, 8]);
      expect(actualMask(owned[1]!)).toEqual(mixed);
    } finally { owned.forEach((texture) => texture.dispose()); }
  });
});
