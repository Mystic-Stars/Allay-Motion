import {
  COMPOSITION_MAX_CLIPS, COMPOSITION_MAX_KEYFRAMES, COMPOSITION_MAX_SECONDS, COMPOSITION_MAX_TRACKS,
  type Composition, type CompositionClip, type CompositionTrack, type CompositionTransform,
} from '@allay/template-sdk';

export const TRANSFORM_KEYS = ['x', 'y', 'scale', 'rotation', 'opacity'] as const;
export const BASE_TRANSFORM = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 } as const;
export type TransformKey = typeof TRANSFORM_KEYS[number];
export type Selection = { trackId: string; clipId?: string };

export function clampFrame(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function clipCount(doc: Composition): number {
  return doc.tracks.reduce((count, track) => count + track.clips.length, 0);
}

export function trackEdit(doc: Composition, id: string, edit: (track: CompositionTrack) => CompositionTrack | null): Composition {
  const track = doc.tracks.find((candidate) => candidate.id === id);
  if (!track) return doc;
  const next = edit(track);
  return track === next ? doc : { ...doc, tracks: doc.tracks.flatMap((candidate) => candidate !== track ? [candidate] : next ? [next] : []) };
}

export function clipEdit(doc: Composition, selection: Selection, edit: (clip: CompositionClip) => CompositionClip | null): Composition {
  return trackEdit(doc, selection.trackId, (track) => {
    const clip = track.clips.find((candidate) => candidate.id === selection.clipId);
    if (!clip || track.locked) return track;
    const next = edit(clip);
    return next === clip ? track : { ...track, clips: track.clips.flatMap((candidate) => candidate !== clip ? [candidate] : next ? [next] : []) };
  });
}

export function makeTrack(id: string, name: string): CompositionTrack {
  return { id, name, muted: false, locked: false, clips: [] };
}

export function appendClip(doc: Composition, target: CompositionTrack, clip: CompositionClip): Composition {
  const existing = doc.tracks.find((track) => track.id === target.id);
  if ((existing ?? target).locked || clipCount(doc) >= COMPOSITION_MAX_CLIPS) return doc;
  const end = clip.startFrame + clip.durationFrames;
  if (end > doc.fps * COMPOSITION_MAX_SECONDS) return doc;
  if (!existing && doc.tracks.length >= COMPOSITION_MAX_TRACKS) return doc;
  const next = existing ? trackEdit(doc, target.id, (track) => ({ ...track, clips: [...track.clips, clip] }))
    : { ...doc, tracks: [...doc.tracks, { ...target, clips: [clip] }] };
  return { ...next, durationFrames: Math.max(doc.durationFrames, end) };
}

export function lastClipEnd(doc: Composition): number {
  return doc.tracks.reduce((end, track) => track.clips.reduce((max, clip) => Math.max(max, clip.startFrame + clip.durationFrames), end), 1);
}

export function moveClip(doc: Composition, selection: Selection, startFrame: number, targetId = selection.trackId): Composition {
  const track = doc.tracks.find((candidate) => candidate.id === selection.trackId);
  const target = doc.tracks.find((candidate) => candidate.id === targetId);
  const clip = track?.clips.find((candidate) => candidate.id === selection.clipId);
  if (!clip || track?.locked || !target || target.locked) return doc;
  const start = clampFrame(startFrame, 0, doc.durationFrames - clip.durationFrames);
  if (target.id === track?.id) return clipEdit(doc, selection, (old) => start === old.startFrame ? old : { ...old, startFrame: start });
  const removed = clipEdit(doc, selection, () => null);
  return trackEdit(removed, target.id, (value) => ({ ...value, clips: [...value.clips, { ...clip, startFrame: start }] }));
}

/** 每条曲线从变换基准起步，按字段独立插值，最后一点之后保持。 */
export function valueAt(clip: CompositionClip, key: TransformKey, frame: number): number {
  let left = { frame: 0, value: clip.transform?.[key] ?? BASE_TRANSFORM[key] };
  let right: typeof left | undefined;
  for (const point of clip.keyframes ?? []) {
    const value = point[key];
    if (value === undefined) continue;
    if (point.frame <= frame && point.frame >= left.frame) left = { frame: point.frame, value };
    if (point.frame > frame && (!right || point.frame < right.frame)) right = { frame: point.frame, value };
  }
  return right ? left.value + (right.value - left.value) * ((frame - left.frame) / (right.frame - left.frame)) : left.value;
}

function advanceSource(clip: CompositionClip, delta: number): CompositionClip {
  if (!delta) return clip;
  const transform: CompositionTransform = { ...clip.transform };
  const keyframes = clip.keyframes ?? [];
  let points = keyframes.filter((point) => point.frame >= delta).map((point) => ({ ...point, frame: point.frame - delta }));
  if (delta > 0) {
    for (const key of TRANSFORM_KEYS) transform[key] = valueAt(clip, key, delta);
  } else if (keyframes.length && points.length < COMPOSITION_MAX_KEYFRAMES && !points.some((point) => point.frame === -delta)) {
    points = [{ frame: -delta, ...transform }, ...points];
  }
  return {
    ...clip, startFrame: clip.startFrame + delta, durationFrames: clip.durationFrames - delta, sourceInFrame: clip.sourceInFrame + delta,
    transform, keyframes: points.filter((point) => point.frame <= COMPOSITION_MAX_SECONDS * 60),
  };
}

export function trimClip(doc: Composition, selection: Selection, edge: 'start' | 'end', frame: number): Composition {
  return clipEdit(doc, selection, (clip) => {
    const end = clip.startFrame + clip.durationFrames;
    if (edge === 'start') {
      const earliest = Math.max(0, clip.startFrame - clip.sourceInFrame);
      const latest = Math.min(end - 1, clip.startFrame + COMPOSITION_MAX_SECONDS * 60 - clip.sourceInFrame);
      return advanceSource(clip, clampFrame(frame, earliest, latest) - clip.startFrame);
    }
    const durationFrames = clampFrame(frame, clip.startFrame + 1, doc.durationFrames) - clip.startFrame;
    return durationFrames === clip.durationFrames ? clip : { ...clip, durationFrames };
  });
}

export function splitClip(doc: Composition, selection: Selection, frame: number, id: string): Composition {
  if (clipCount(doc) >= COMPOSITION_MAX_CLIPS) return doc;
  return trackEdit(doc, selection.trackId, (track) => {
    if (track.locked) return track;
    const clip = track.clips.find((candidate) => candidate.id === selection.clipId);
    if (!clip) return track;
    const delta = frame - clip.startFrame;
    if (!Number.isInteger(delta) || delta <= 0 || delta >= clip.durationFrames || clip.sourceInFrame + delta > COMPOSITION_MAX_SECONDS * 60) return track;
    const left = { ...clip, durationFrames: delta };
    const right = { ...advanceSource(clip, delta), id, params: structuredClone(clip.params) };
    return { ...track, clips: track.clips.flatMap((candidate) => candidate === clip ? [left, right] : [candidate]) };
  });
}

export function duplicateClip(doc: Composition, track: CompositionTrack, clip: CompositionClip, id: string): Composition {
  if (track.locked) return doc;
  const startFrame = Math.min(clip.startFrame + clip.durationFrames, doc.fps * COMPOSITION_MAX_SECONDS - clip.durationFrames);
  return appendClip(doc, track, { ...structuredClone(clip), id, startFrame });
}

export function setKeyframe(clip: CompositionClip, frame: number, values: CompositionTransform): CompositionClip {
  const points = clip.keyframes ?? [];
  const previous = points.find((point) => point.frame === frame);
  if (frame < 0 || frame >= clip.durationFrames || (!previous && points.length >= COMPOSITION_MAX_KEYFRAMES)) return clip;
  return { ...clip, keyframes: [...points.filter((point) => point !== previous), { ...previous, frame, ...values }].sort((left, right) => left.frame - right.frame) };
}
