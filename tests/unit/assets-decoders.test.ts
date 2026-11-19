import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodePng, findBdfGlyph, parseBdf, PngDecodeError } from '../../packages/assets/src/index';
import { solidPng } from './helpers/resource-fixtures';

// 渲染进程用的 PNG 解码与兜底字体的 BDF 解析（decisions.md M2b）。

const inflate = async (b: Uint8Array) => new Uint8Array(inflateSync(b));

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/** 测试数据：任意颜色类型、位深的 PNG（每行过滤类型由 filters 指定） */
function png(width: number, height: number, colorType: number, bitDepth: number, rows: number[][], extra: Buffer[] = [], filters: number[] = []): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  const raw = Buffer.concat(rows.map((r, y) => Buffer.from([filters[y] ?? 0, ...r])));
  return new Uint8Array(
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), ...extra, chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]),
  );
}

describe('decodePng', () => {
  it('RGBA8：纯色色块', async () => {
    const img = await decodePng(solidPng('#123456', 32), inflate);
    expect(img.width).toBe(16);
    expect(img.height).toBe(32);
    expect([...img.data.subarray(0, 4)]).toEqual([0x12, 0x34, 0x56, 255]);
    expect([...img.data.subarray(img.data.length - 4)]).toEqual([0x12, 0x34, 0x56, 255]);
  });

  it('半透明像素保持准确的直通 alpha', async () => {
    const img = await decodePng(png(2, 1, 6, 8, [[255, 0, 0, 1, 10, 20, 30, 128]]), inflate);
    expect([...img.data]).toEqual([255, 0, 0, 1, 10, 20, 30, 128]);
  });

  it('索引色 + tRNS，4 位深', async () => {
    const plte = chunk('PLTE', Buffer.from([0, 0, 0, 255, 0, 0, 0, 255, 0]));
    const trns = chunk('tRNS', Buffer.from([0]));
    const img = await decodePng(png(3, 1, 3, 4, [[0x01, 0x20]], [plte, trns]), inflate);
    expect([...img.data]).toEqual([0, 0, 0, 0, 255, 0, 0, 255, 0, 255, 0, 255]);
  });

  it('灰度 + alpha、RGB 16 位、Sub/Up/Average/Paeth 过滤', async () => {
    const ga = await decodePng(png(1, 1, 4, 8, [[200, 50]]), inflate);
    expect([...ga.data]).toEqual([200, 200, 200, 50]);
    const rgb16 = await decodePng(png(1, 1, 2, 16, [[0xff, 0x00, 0x80, 0x00, 0x00, 0x01]]), inflate);
    expect([...rgb16.data]).toEqual([255, 128, 0, 255]);
    // 第二行用 Up（+上一行），第三行 Average，第四行 Paeth
    const g = await decodePng(png(2, 4, 0, 8, [[10, 20], [5, 5], [3, 3], [0, 0]], [], [1, 2, 3, 4]), inflate);
    // 行 0（Sub）：10, 30；行 1（Up）：15, 35；行 2（Average）：3 + 7 = 10, 3 + ((10 + 35) >> 1) = 25；行 3（Paeth）：10, 25
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((i) => g.data[i * 4])).toEqual([10, 30, 15, 35, 10, 25, 10, 25]);
  });

  it('不是 PNG 时抛 PngDecodeError', async () => {
    await expect(decodePng(new Uint8Array(40), inflate)).rejects.toBeInstanceOf(PngDecodeError);
  });
});

describe('parseBdf', () => {
  it('小字体：度量与位图', () => {
    const text = [
      'STARTFONT 2.1',
      'FONT_ASCENT 7',
      'FONT_DESCENT 1',
      'CHARS 2',
      'STARTCHAR b',
      'ENCODING 98',
      'DWIDTH 4 0',
      'BBX 2 2 1 0',
      'BITMAP',
      'C0',
      '40',
      'ENDCHAR',
      'STARTCHAR a',
      'ENCODING 97',
      'BBX 3 1 0 -1',
      'BITMAP',
      'E0',
      'ENDCHAR',
      'ENDFONT',
    ].join('\n');
    const f = parseBdf(text);
    expect(f.ascent).toBe(7);
    expect(f.descent).toBe(1);
    expect([...f.codepoints]).toEqual([97, 98]);
    expect([...f.metrics]).toEqual([3, 3, 1, 0, -1, 4, 2, 2, 1, 0]);
    expect([...f.bits]).toEqual([0xe0, 0xc0, 0x40]);
    expect(findBdfGlyph(f.codepoints, 98)).toBe(1);
    expect(findBdfGlyph(f.codepoints, 99)).toBe(-1);
  });
});
