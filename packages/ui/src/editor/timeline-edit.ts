export function snapSegment(value: number, fps: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value * fps) / fps));
}

export function segmentAt(ends: readonly number[], time: number): number {
  const index = ends.findIndex((end) => time < end);
  return index < 0 ? ends.length - 1 : index;
}

export function nearestCue(cues: readonly number[], time: number): number | undefined {
  return cues.reduce<number | undefined>((nearest, cue) => (
    nearest === undefined || Math.abs(cue - time) < Math.abs(nearest - time) ? cue : nearest
  ), undefined);
}
