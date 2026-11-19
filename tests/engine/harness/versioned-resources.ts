import type { ResourcePayload } from '../../../packages/template-sdk/src';

type Rgba = [number, number, number, number];
type Texture = Extract<ResourcePayload, { kind: 'rgba' }>;
type Sample = (x: number, y: number) => Rgba;

export const BEDROCK_MARKERS = {
  empty: [48, 64, 96, 255],
  fill: [24, 224, 48, 255],
  divider: [192, 32, 160, 255],
  customBackground: [30, 120, 210, 255],
  customTitle: [210, 120, 30, 255],
} satisfies Record<string, Rgba>;

function image(width: number, height: number, sample: Sample, mcmeta?: object): Texture {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(sample(x, y), (y * width + x) * 4);
  return { kind: 'rgba', width, height, data, ...(mcmeta ? { mcmeta: JSON.stringify(mcmeta) } : {}) };
}

function pattern(seed: number): Sample {
  return (x, y) => [30 + ((x * 5 + seed * 17) % 192), 35 + ((y * 7 + seed * 11) % 176), 40 + (((x + y) * 3 + seed * 23) % 160), 255];
}

function panel(width: number, height: number, border: number, seed: number): Texture {
  const sample = pattern(seed);
  return image(width, height, (x, y) => {
    if ((x === 0 || x === width - 1) && (y === 0 || y === height - 1)) return [0, 0, 0, 0];
    return sample(x, y);
  }, { gui: { scaling: { type: 'nine_slice', width, height, border } } });
}

function toastAtlas(left: number, top: number, seed: number): Texture {
  const sample = pattern(seed);
  return image(256, 256, (x, y) => x >= left && x < left + 160 && y >= top && y < top + 32 ? sample(x - left, y - top) : [0, 0, 0, 0]);
}

const textures: Record<string, () => Texture> = {
  'minecraft:gui/title/mojang': () => image(256, 256, pattern(1)),
  'minecraft:gui/title/mojangstudios': () => image(512, 512, (x, y) => pattern(y < 256 ? 2 : 3)(x, y % 256)),
  'minecraft:gui/options_background': () => image(16, 16, pattern(4)),
  'minecraft:block/dirt': () => image(16, 16, pattern(5)),
  'minecraft:block/nether_portal': () => image(16, 16 * 32, (x, y) => [35 + Math.floor(y / 16) * 6, 32 + (x % 4) * 8, 140 + (y % 16) * 4, 180], { animation: { frametime: 1 } }),
  'minecraft:environment/end_sky': () => image(128, 128, pattern(6)),
  'minecraft:entity/end_portal': () => image(256, 256, pattern(7)),
  'minecraft:entity/end_portal/end_portal': () => image(256, 256, pattern(8)),
  'minecraft:gui/menu_background': () => image(16, 16, () => [0, 0, 0, 64]),
  'minecraft:gui/title/background/panorama_overlay': () => image(1, 1, () => [255, 255, 255, 0]),
  'minecraft:gui/achievement/achievement_background': () => toastAtlas(96, 202, 9),
  'minecraft:gui/achievement/bg': () => toastAtlas(96, 202, 10),
  'minecraft:gui/toasts': () => toastAtlas(0, 0, 11),
  'minecraft:gui/sprites/toast/advancement': () => image(160, 32, pattern(12)),
  'minecraft:item/diamond': () => image(16, 16, (x, y) => Math.abs(x - 7.5) + Math.abs(y - 7.5) < 8 ? [30, 235, 240, 255] : [0, 0, 0, 0]),
  'minecraft:ui/title': () => image(192, 48, pattern(13)),
  'minecraft:ui/bg32': () => image(32, 32, pattern(14)),
  'test:ui/custom_background': () => image(16, 9, () => BEDROCK_MARKERS.customBackground),
  'test:ui/custom_title': () => image(16, 4, () => BEDROCK_MARKERS.customTitle),
  'minecraft:ui/dialog_background_hollow_3': () => panel(16, 16, 4, 15),
  'minecraft:ui/loading_bar': () => image(640, 8, (x) => [32 + Math.floor(x / 64) * 20, 0, 0, 255]),
  'minecraft:ui/experiencebarempty': () => image(13, 5, () => BEDROCK_MARKERS.empty),
  'minecraft:ui/experiencebarfull': () => image(13, 5, () => BEDROCK_MARKERS.fill),
  'minecraft:ui/experiencenub': () => image(11, 5, (x) => x === 0 ? BEDROCK_MARKERS.divider : [0, 0, 0, 0]),
  'minecraft:ui/greyborder': () => panel(16, 16, 4, 17),
  'minecraft:ui/achievement_third_party': () => image(13, 13, pattern(18)),
  'minecraft:blocks/netherrack': () => image(16, 16, pattern(19)),
  'minecraft:blocks/end_stone': () => image(16, 16, pattern(20)),
  'minecraft:blocks/dirt': () => image(16, 16, pattern(21)),
};

for (let face = 0; face < 6; face++) {
  textures[`minecraft:gui/title/background/panorama_${face}`] = () => image(128, 128, pattern(22 + face));
  textures[`minecraft:ui/panorama_${face}`] = () => image(128, 128, pattern(28 + face));
}

export function versionedTexture(id: string): Texture | null {
  return Object.hasOwn(textures, id) ? textures[id]!() : null;
}
