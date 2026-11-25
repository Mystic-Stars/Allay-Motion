// 页面（DOM 里的逻辑）和 3D 世界之间交换的几样东西。都是模块级的可变对象：每帧读写，不经过 React。

/** 悦灵在 3D 世界里画（带路的逻辑仍在 AllayGuide 里算：落点、弹簧、朝向、动作） */
export const allay3d: {
  /** 世界已经装好悦灵的图集；为假时 AllayGuide 照旧用 DOM 里的 <Allay> */
  ready: boolean;
  /** 这一帧悦灵在哪（视口坐标、CSS 像素）、多大、画图集的第几帧；不出场时为 null */
  state: { x: number; y: number; size: number; frame: number; facing: 1 | -1; tilt: number } | null;
  /**
   * 首屏的体素悦灵（方块拼成的那只）此刻在哪（视口坐标）；没在拼、没拼好时为 null。
   * 它在的时候带路的悦灵不出场（同屏最多一只），它散开时带路的悦灵从它所在的位置飞出来。
   */
  sculpture: { x: number; y: number } | null;
  /** 世界会拼出体素悦灵（有 WebGL）：首屏给带路悦灵留的锚点（data-allay-yield）让给它 */
  expected: boolean;
  /** 背景方块拼出一大块时，带路的悦灵飞过去看一眼：那一块在视口里的位置、看到什么时候（performance.now） */
  attention: { x: number; y: number; until: number } | null;
} = { ready: false, state: null, sculpture: null, expected: false, attention: null };

const subs = new Set<() => void>();

/** expected 变了时通知（静止版的悦灵据此决定画不画） */
export function onSculptureExpected(fn: () => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

export function setSculptureExpected(v: boolean): void {
  if (allay3d.expected === v) return;
  allay3d.expected = v;
  for (const fn of subs) fn();
}
