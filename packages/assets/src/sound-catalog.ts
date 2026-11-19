import { z } from 'zod';
import { parseResourceId } from './ids';

export const ImportedSoundIdSchema = z.string().regex(/^user-audio:[0-9a-f]{32}$/);
export const SoundKindSchema = z.enum(['effect', 'music']);
export type SoundKind = z.infer<typeof SoundKindSchema>;
export const MAX_SOUND_BYTES = 16 * 1024 * 1024;

export function soundFileEvent(file: string): string {
  return `sound-file:${file.replace(':', '/')}`;
}

export function fileFromSoundEvent(id: string): string | null {
  if (!id.startsWith('sound-file:')) return null;
  const value = id.slice('sound-file:'.length).replace('/', ':');
  return value.includes(':') && parseResourceId(value) && soundFileEvent(value) === id ? value : null;
}

export function soundKind(id: string, file?: string): SoundKind {
  const event = parseResourceId(id)?.path ?? '';
  const path = file ? (parseResourceId(file)?.path ?? '') : '';
  return /^(music|music_disc|record)([./_]|$)/.test(event) || /(?:^|\/)(music|music_disc|records?)(\/|$)/.test(path) ? 'music' : 'effect';
}
