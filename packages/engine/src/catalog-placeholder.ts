import { blockTextureIds, GUI_TEXTURES, itemTextureIds } from '@allay/assets';

const blocks = new Set(blockTextureIds());
const items = new Set(itemTextureIds());

function blockMark(id: string, column: number, row: number) {
  if (/planks|log|wood|bookshelf/.test(id)) return row % 5 === 0 || (column + (row >> 2) * 5) % 13 === 0;
  if (/brick|stone|ore/.test(id)) return row % 6 === 0 || (column + ((row / 6) | 0) * 5) % 11 === 0;
  if (/wool|leaves|hay/.test(id)) return (column + row) % 7 === 0 || (column - row) % 7 === 0;
  return (column + row) % 12 < 2 || column === 1 || row === 1;
}

function itemMask(id: string, column: number, row: number) {
  const across = Math.abs(column - 7.5);
  const down = Math.abs(row - 7.5);
  if (/sword|shovel|pickaxe|axe|arrow|stick|rod/.test(id)) {
    const handle = Math.abs(column + row - 15) < 1.8 && column > 1 && column < 13;
    const head = /pickaxe|axe/.test(id) ? row >= 2 && row <= 5 && column >= 6 && column < 15
      : /sword/.test(id) ? Math.abs(column - row) < 2 && across + down < 8 : column > 8 && column < 14 && row > 1 && row < 7;
    return handle || head;
  }
  if (/book|ingot|bread/.test(id)) return across < 7 && down < 4 && across + down < 10;
  if (/clock|compass|disc|pearl|apple|eye|snowball/.test(id)) return across * across + down * down < 43;
  if (/bucket|bottle/.test(id)) return row > 2 && row < 14 && across < 6.6 - row / 5;
  return across * 1.25 + down < 7.5;
}

export function catalogPlaceholder(id: string) {
  const gui = GUI_TEXTURES.find(entry => entry.id === id);
  const item = items.has(id);
  if (!item && !blocks.has(id) && !gui) return null;
  const width = gui?.width ?? 16;
  const height = gui?.height ?? 16;
  const pixels = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) {
    if (item && !itemMask(id, column, row)) continue;
    if (id.endsWith('_side_overlay') && row > 3) continue;
    const mark = gui ? row < 2 || row >= height - 2 || column < 2 || column >= width - 2
      : item ? (row + column) % 6 < 2 : blockMark(id, column, row);
    const tone = mark ? 0xc4 : 0x65;
    pixels.set([tone - 14, tone, tone + 13, 255], (row * width + column) * 4);
  }
  return { pixels, width, height, nineSlice: gui?.nineSlice ?? null };
}
