import { z } from 'zod';

export const SkinRefSchema = z.string().regex(/^skins:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
export const SkinModelSchema = z.enum(['classic', 'slim']);
export const JavaNameSchema = z.string().regex(/^[A-Za-z0-9_]{3,16}$/);
export const SkinLocaleSchema = z.enum(['zh-CN', 'en']);
export const SkinEntrySchema = z.strictObject({
  ref: SkinRefSchema,
  name: z.string().min(1).max(128),
  model: SkinModelSchema,
  height: z.union([z.literal(32), z.literal(64)]),
  source: z.enum(['local', 'java']),
}).refine((entry) => entry.height === 64 || entry.model === 'classic');
export const SkinPixelsSchema = z.strictObject({
  width: z.literal(64),
  height: z.union([z.literal(32), z.literal(64)]),
  data: z.instanceof(Uint8Array),
}).refine(({ height, data }) => data.length === 64 * height * 4);

export type SkinEntry = z.infer<typeof SkinEntrySchema>;
export type SkinModel = z.infer<typeof SkinModelSchema>;
export type SkinPixels = z.infer<typeof SkinPixelsSchema>;
const SkinErrorCodeSchema = z.enum(['invalid-png', 'too-large', 'not-found', 'no-skin', 'offline', 'invalid-response', 'busy', 'storage']);
export const SkinAddResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('added'), entry: SkinEntrySchema }),
  z.strictObject({ status: z.literal('canceled') }),
  z.strictObject({ status: z.literal('error'), code: SkinErrorCodeSchema }),
]);
export type SkinErrorCode = z.infer<typeof SkinErrorCodeSchema>;
export type SkinAddResult = z.infer<typeof SkinAddResultSchema>;

export interface SkinsApi {
  list(): Promise<SkinEntry[]>;
  importPng(model: SkinModel): Promise<SkinAddResult>;
  fetchJava(name: string, locale: z.infer<typeof SkinLocaleSchema>): Promise<SkinAddResult>;
  read(ref: string): Promise<SkinPixels | null>;
  remove(ref: string): Promise<boolean>;
}
