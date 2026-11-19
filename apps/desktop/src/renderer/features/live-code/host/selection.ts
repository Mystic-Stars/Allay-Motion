import type { CompositionClip, CompositionTrack, ParamValues } from '@allay/template-sdk';
import type { Selection } from '../../studio/edits';
import type { useProjectStore } from '../../../stores/projectStore';

export type Project = ReturnType<typeof useProjectStore.getState>;
export type Target = {
  ref: { id: string; version: string };
  params: ParamValues;
  clip?: CompositionClip;
  track?: CompositionTrack;
};

let selected: Selection | null = null;
const listeners = new Set<() => void>();

export function selectCodeClip(next: Selection | null): void {
  if (next?.trackId === selected?.trackId && next?.clipId === selected?.clipId) return;
  selected = next;
  for (const listener of listeners) listener();
}

export function onCodeSelectionChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function codeTarget(project: Project): Target | null {
  if (!project.composition) return project.template ? { ref: project.template.ref, params: project.params } : null;
  const track = project.composition.tracks.find(({ id }) => id === selected?.trackId);
  const clip = track?.clips.find(({ id }) => id === selected?.clipId);
  return clip && track ? { ref: clip.template, clip, track, params: clip.params } : null;
}
