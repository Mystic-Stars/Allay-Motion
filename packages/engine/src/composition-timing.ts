import type { AudioCue, Composition } from '@allay/template-sdk';

export type Clip = Composition['tracks'][number]['clips'][number];
export type LayerTransform = { x: number; y: number; scale: number; rotation: number; opacity: number };

const DEFAULT_TRANSFORM: LayerTransform = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };
const TRANSFORM_KEYS = ['x', 'y', 'scale', 'rotation', 'opacity'] as const;

export function framePosition(seconds: number, fps: number): number {
  const frame = seconds * fps;
  const integer = Math.round(frame);
  return Math.abs(frame - integer) <= Number.EPSILON * 4 * Math.max(1, Math.abs(frame)) ? integer : frame;
}

export function localFrame(clip: Clip, frame: number): number | null {
  const relative = frame - clip.startFrame;
  return relative >= 0 && relative < clip.durationFrames ? relative : null;
}

export function compileTransform(clip: Clip): (frame: number) => LayerTransform {
  const result = { ...DEFAULT_TRANSFORM };
  const curves = TRANSFORM_KEYS.map((key) => {
    const points = new Map([[0, clip.transform?.[key] ?? DEFAULT_TRANSFORM[key]]]);
    for (const point of clip.keyframes ?? []) {
      const value = point[key];
      if (value !== undefined) points.set(point.frame, value);
    }
    return { key, points: [...points].sort(([left], [right]) => left - right) };
  });
  return (frame) => {
    for (const { key, points } of curves) {
      let low = 0;
      let high = points.length;
      while (high - low > 1) {
        const mid = (low + high) >>> 1;
        if (points[mid]![0] <= frame) low = mid;
        else high = mid;
      }
      const [start, value] = points[low]!;
      const next = points[high];
      result[key] = next ? value + ((frame - start) / (next[0] - start)) * (next[1] - value) : value;
    }
    return result;
  };
}

export function placeCue(cue: AudioCue, clip: Clip, fps: number, durationFrames: number, profile?: string): AudioCue | null {
  const head = clip.startFrame;
  const at = head + (framePosition(cue.at, fps) - clip.sourceInFrame);
  const end = Math.min(head + clip.durationFrames, durationFrames);
  if (at >= end || head >= end) return null;
  return { ...cue, at: Math.max(head, at) / fps, clip: { offset: Math.max(0, head - at) / fps, end: end / fps, ...(profile === undefined ? {} : { profile }) } };
}
