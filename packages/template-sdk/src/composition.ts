import { z } from 'zod';
import { TemplateIdSchema, VersionSchema } from './manifest';
import type { ParamValue } from './runtime';

export const COMPOSITION_MAX_SECONDS = 300;
export const COMPOSITION_MAX_TRACKS = 64;
export const COMPOSITION_MAX_CLIPS = 2048;
export const COMPOSITION_MAX_KEYFRAMES = 1024;
export const CompositionFpsSchema = z.literal([24, 25, 30, 50, 60]);
export const CompositionIdSchema = z.string().min(1).max(128);

const frame = z.int().min(0).max(COMPOSITION_MAX_SECONDS * 60);
const length = frame.min(1);
const profile = z.string().min(1).max(256);
const transformFields = {
  x: z.number().min(-100_000).max(100_000).optional(),
  y: z.number().min(-100_000).max(100_000).optional(),
  scale: z.number().min(0).max(100).optional(),
  rotation: z.number().min(-36_000).max(36_000).optional(),
  opacity: z.number().min(0).max(1).optional(),
};

function isBoundedJson(value: unknown, depth: number, budget: { nodes: number }): value is ParamValue {
  if (--budget.nodes < 0 || depth > 32) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) {
    for (const child of value) if (!isBoundedJson(child, depth + 1, budget)) return false;
    return true;
  }
  if (typeof value !== 'object') return false;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.entries(value).every(([key, child]) =>
    key !== '__proto__' && key !== 'constructor' && key !== 'prototype' && isBoundedJson(child, depth + 1, budget));
}

export const CompositionParamsSchema = z.custom<Record<string, ParamValue>>((value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length <= 128 && isBoundedJson(value, 0, { nodes: 16_384 }), 'expected bounded JSON params');

export const CompositionTemplateSchema = z.strictObject({ id: TemplateIdSchema, version: VersionSchema });
export const CompositionTransformSchema = z.strictObject(transformFields);
export const CompositionKeyframeSchema = z.strictObject({ frame, ...transformFields });
export const CompositionClipSchema = z.strictObject({
  id: CompositionIdSchema,
  startFrame: frame,
  durationFrames: length,
  sourceInFrame: frame,
  template: CompositionTemplateSchema,
  params: CompositionParamsSchema,
  profile: profile.optional(),
  transform: CompositionTransformSchema.optional(),
  keyframes: z.array(CompositionKeyframeSchema).max(COMPOSITION_MAX_KEYFRAMES).optional(),
});
export const CompositionTrackSchema = z.strictObject({
  id: CompositionIdSchema,
  name: z.string().min(1).max(120),
  muted: z.boolean(),
  locked: z.boolean(),
  clips: z.array(CompositionClipSchema).max(COMPOSITION_MAX_CLIPS),
});

/** 按数组顺序从底到顶合成；片段使用 [start, start + length)，曲线以片段开头为第 0 帧。 */
export const CompositionSchema = z.strictObject({
  formatVersion: z.literal(1),
  fps: CompositionFpsSchema,
  durationFrames: length,
  defaultProfile: profile.optional(),
  tracks: z.array(CompositionTrackSchema).max(COMPOSITION_MAX_TRACKS),
}).superRefine((doc, ctx) => {
  if (doc.durationFrames > doc.fps * COMPOSITION_MAX_SECONDS) {
    ctx.addIssue({ code: 'custom', path: ['durationFrames'], message: 'composition exceeds 300 seconds' });
  }
  const trackIds = new Set<string>();
  const clipIds = new Set<string>();
  for (const [trackIndex, track] of doc.tracks.entries()) {
    const path = ['tracks', trackIndex];
    if (trackIds.has(track.id)) ctx.addIssue({ code: 'custom', path: [...path, 'id'], message: 'duplicate track id' });
    trackIds.add(track.id);
    for (const [clipIndex, clip] of track.clips.entries()) {
      const clipPath = [...path, 'clips', clipIndex];
      if (clipIds.has(clip.id)) ctx.addIssue({ code: 'custom', path: [...clipPath, 'id'], message: 'duplicate clip id' });
      clipIds.add(clip.id);
      if (clip.startFrame + clip.durationFrames > doc.durationFrames) {
        ctx.addIssue({ code: 'custom', path: clipPath, message: 'clip extends beyond composition' });
      }
      const keyFrames = new Set<number>();
      for (const [index, point] of (clip.keyframes ?? []).entries()) {
        if (keyFrames.has(point.frame)) {
          ctx.addIssue({ code: 'custom', path: [...clipPath, 'keyframes', index, 'frame'], message: 'duplicate keyframe' });
        }
        keyFrames.add(point.frame);
      }
    }
  }
  if (clipIds.size > COMPOSITION_MAX_CLIPS) ctx.addIssue({ code: 'custom', path: ['tracks'], message: 'too many clips' });
});

export type Composition = z.infer<typeof CompositionSchema>;
export type CompositionClip = z.infer<typeof CompositionClipSchema>;
export type CompositionTrack = z.infer<typeof CompositionTrackSchema>;
export type CompositionTransform = z.infer<typeof CompositionTransformSchema>;
