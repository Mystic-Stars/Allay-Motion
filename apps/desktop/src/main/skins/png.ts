import { decodePng, readPngHeader } from '@allay/assets';
import { crc32, inflateSync } from 'node:zlib';
import { SkinPixelsSchema, type SkinPixels } from '../../shared/skins';

export const MAX_SKIN_BYTES = 128 * 1024;

export async function decodeSkinPng(bytes: Buffer): Promise<SkinPixels> {
  if (bytes.length > MAX_SKIN_BYTES) throw new Error('oversize PNG');
  const header = readPngHeader(bytes);
  if (header?.width !== 64 || (header.height !== 32 && header.height !== 64)) throw new Error('invalid skin dimensions');
  if (bytes[26] !== 0 || bytes[27] !== 0 || (bytes[28] !== 0 && bytes[28] !== 1)) throw new Error('invalid PNG header');
  const depths: Readonly<Record<number, readonly number[]>> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (!depths[header.colorType]?.includes(header.bitDepth)) throw new Error('invalid PNG color format');
  let complete = false;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 8 + length;
    if (end + 4 > bytes.length || crc32(bytes.subarray(offset + 4, end)) !== bytes.readUInt32BE(end)) throw new Error('invalid PNG chunk');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (type === 'IHDR' && (offset !== 8 || length !== 13)) throw new Error('invalid IHDR');
    if (type === 'IEND') {
      complete = length === 0 && end + 4 === bytes.length;
      break;
    }
    offset = end + 4;
  }
  if (!complete) throw new Error('incomplete PNG');
  const pixels = SkinPixelsSchema.parse(await decodePng(bytes, async (data) => inflateSync(data, { maxOutputLength: 34 * 1024 })));
  if (pixels.height === 32) clearOpaqueLegacyHat(pixels.data);
  return pixels;
}

function clearOpaqueLegacyHat(data: Uint8Array): void {
  for (let row = 0; row < 32; row++) {
    for (let column = 32; column < 64; column++) {
      if (data[(row * 64 + column) * 4 + 3]! < 128) return;
    }
  }
  for (let row = 0; row < 16; row++) {
    for (let column = 32; column < 64; column++) data[(row * 64 + column) * 4 + 3] = 0;
  }
}
