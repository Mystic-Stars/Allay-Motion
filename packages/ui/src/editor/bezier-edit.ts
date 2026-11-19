export type BezierPoints = readonly [number, number, number, number];

export function bezierPadding(points: BezierPoints): number {
  return Math.max(0.3, -points[1] + 0.15, points[1] - 0.85, -points[3] + 0.15, points[3] - 0.85);
}

export function moveBezierPoint(points: BezierPoints, handle: 0 | 1, dx: number, dy: number): [number, number, number, number] {
  const next: [number, number, number, number] = [...points];
  const x = handle * 2;
  const y = x + 1;
  if (dx !== 0) next[x] = Math.round(Math.min(1, Math.max(0, next[x]! + dx)) * 100) / 100;
  if (dy !== 0) next[y] = Math.round((next[y]! + dy) * 100) / 100;
  return next;
}
