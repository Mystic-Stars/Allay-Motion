import { isSafeRelativePath } from '@allay/assets';
import { FontProviderPayloadSchema, FontRefSchema, MAX_OUTLINE_FONT_BYTES, OutlineProviderPayloadSchema } from '@allay/template-sdk';
import { z } from 'zod';

export const FontBytesSchema = z.instanceof(Uint8Array).refine((bytes) => bytes.byteLength >= 12 && bytes.byteLength <= MAX_OUTLINE_FONT_BYTES);

export const FontCatalogSchema = z.strictObject({
  resources: z.array(FontRefSchema).max(1024),
});
export type FontCatalog = z.infer<typeof FontCatalogSchema>;

const packPath = z.string().max(1024).refine(isSafeRelativePath);
export const FontProvidersResultSchema = z.strictObject({
  providers: z.array(z.discriminatedUnion('type', [
    FontProviderPayloadSchema.options[0].omit({ image: true }).extend({ file: packPath }),
    FontProviderPayloadSchema.options[1],
    OutlineProviderPayloadSchema.omit({ bytes: true }).extend({ file: packPath }),
    FontProviderPayloadSchema.options[3],
  ])).max(256),
  skipped: z.array(z.string()).max(256),
});
export type FontProvidersResult = z.infer<typeof FontProvidersResultSchema>;
