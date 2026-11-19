import { ImportedSoundIdSchema, SoundKindSchema } from '@allay/assets';
import { z } from 'zod';

export const ImportedSoundSchema = z.strictObject({
  id: ImportedSoundIdSchema,
  name: z.string().min(1).max(255),
  kind: SoundKindSchema,
});
export type ImportedSound = z.infer<typeof ImportedSoundSchema>;

export const SoundExtensionSchema = z.enum(['wav', 'ogg', 'mp3', 'flac', 'm4a', 'aac', 'opus']);
