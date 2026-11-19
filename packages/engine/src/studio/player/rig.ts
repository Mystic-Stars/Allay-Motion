import type { SetupContext } from '@allay/template-sdk';

export type Three = SetupContext['THREE'];
export type Texture = Awaited<ReturnType<SetupContext['resources']['texture']>>;
type Part = 'head' | 'body' | 'rightArm' | 'leftArm' | 'rightLeg' | 'leftLeg';
type Origin = readonly [number, number];
type Dimensions = readonly [number, number, number];
type Face = readonly [x: number, y: number, width: number, height: number];

const ATLAS = {
  head: [[0, 0], [32, 0]],
  body: [[16, 16], [16, 32]],
  rightArm: [[40, 16], [40, 32]],
  leftArm: [[32, 48], [48, 48]],
  rightLeg: [[0, 16], [0, 32]],
  leftLeg: [[16, 48], [0, 48]],
} as const satisfies Record<Part, readonly [Origin, Origin]>;

function rectangles([x, y]: Origin, [width, height, depth]: Dimensions): Face[] {
  return [
    [x + depth + width, y + depth, depth, height],
    [x, y + depth, depth, height],
    [x + depth, y, width, depth],
    [x + depth + width, y, width, depth],
    [x + depth, y + depth, width, height],
    [x + 2 * depth + width, y + depth, width, height],
  ];
}

function box(three: Three, size: Dimensions, origin: Origin, atlasHeight: number, inflate: number, mirror: boolean) {
  const [width, height, depth] = size;
  const geometry = new three.BoxGeometry(width + inflate, height + inflate, depth + inflate);
  const uv = geometry.getAttribute('uv');
  if (!uv) throw new Error('missing box UVs');
  const faces = rectangles(origin, size);
  for (const [face, rect] of faces.entries()) {
    const [x, y, w, h] = mirror && face < 2 ? faces[1 - face]! : rect;
    // BoxGeometry 面次序为 +X、-X、+Y、-Y、+Z、-Z；贴图首行是顶端。
    // 用平面的仿射变换得到每面的 UV，旧皮肤的左肢将对面交换并水平翻转。
    for (let corner = 0; corner < 4; corner++) {
      const index = face * 4 + corner;
      const u = (x + (mirror ? 1 - uv.getX(index) : uv.getX(index)) * w) / 64;
      const v = 1 - (y + (face === 3 ? uv.getY(index) : 1 - uv.getY(index)) * h) / atlasHeight;
      (uv as typeof uv & { setXY(index: number, u: number, v: number): void }).setXY(index, u, v);
    }
  }
  uv.needsUpdate = true;
  return geometry;
}

export function buildRig(three: Three, texture: Texture, atlasHeight: number, slim: boolean) {
  const legacy = atlasHeight === 32;
  const armWidth = slim && !legacy ? 3 : 4;
  const base = new three.MeshBasicMaterial({ map: texture });
  const overlay = new three.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, alphaTest: 1 / 255 });
  const makePart = (part: Part, size: Dimensions, centerY: number) => {
    const pivot = new three.Group();
    pivot.name = part;
    const mirrored = legacy && (part === 'leftArm' || part === 'leftLeg');
    const origins = ATLAS[mirrored ? (part === 'leftArm' ? 'rightArm' : 'rightLeg') : part];
    const inner = new three.Mesh(box(three, size, origins[0], atlasHeight, 0, mirrored), base);
    inner.name = 'base';
    inner.position.y = centerY;
    pivot.add(inner);
    if (!legacy || part === 'head') {
      const outer = new three.Mesh(box(three, size, origins[1], atlasHeight, part === 'head' ? 1 : 0.5, false), overlay);
      outer.name = 'outer';
      outer.position.y = centerY;
      pivot.add(outer);
    }
    return pivot;
  };

  const root = new three.Group();
  const upper = new three.Group();
  upper.position.y = 12;
  const body = makePart('body', [8, 12, 4], 6);
  const head = makePart('head', [8, 8, 8], 4);
  head.position.y = 12;
  const arm = (side: 'rightArm' | 'leftArm') => makePart(side, [armWidth, 12, 4], -4);
  const rightArm = arm('rightArm');
  const leftArm = arm('leftArm');
  rightArm.position.set(-4 - armWidth / 2, armWidth === 3 ? 9.5 : 10, 0);
  leftArm.position.set(4 + armWidth / 2, rightArm.position.y, 0);
  const rightLeg = makePart('rightLeg', [4, 12, 4], -6);
  const leftLeg = makePart('leftLeg', [4, 12, 4], -6);
  rightLeg.position.set(-2, 12, 0);
  leftLeg.position.set(2, 12, 0);
  upper.add(body, head, rightArm, leftArm);
  root.add(upper, rightLeg, leftLeg);
  return { root, upper, head, rightArm, leftArm, rightLeg, leftLeg, makeViewArm: () => arm('rightArm') };
}
