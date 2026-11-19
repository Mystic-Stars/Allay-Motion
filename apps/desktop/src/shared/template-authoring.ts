import { CompositionSchema, isValidVersion, MAX_TEMPLATE_CODE_BYTES, ParamDefSchema, TemplateIdSchema } from '@allay/template-sdk';
import { z } from 'zod';
import { TemplateVersionArgSchema } from './templates';
import { SkinRefSchema } from './skins';

export const MAX_SOURCE_MANIFEST_BYTES = 256 * 1024;
export const SourceRefSchema = z.strictObject({ id: TemplateIdSchema, version: TemplateVersionArgSchema.refine(isValidVersion) });
export const SourceHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const TemplateSourceFilesSchema = z.strictObject({
  source: z.string().max(MAX_TEMPLATE_CODE_BYTES),
  manifest: z.string().max(MAX_SOURCE_MANIFEST_BYTES),
});
export const WriteSourceSchema = TemplateSourceFilesSchema.extend({ baseVersion: SourceHashSchema });
export const AuthoringNameSchema = z.string().trim().min(1).max(60);

export const MAX_COMPOSITION_DOCUMENT_BYTES = 2 * 1024 * 1024;
export const CompositionDocumentSchema = z.string().max(MAX_COMPOSITION_DOCUMENT_BYTES);
export const ExposureTargetSchema = z.strictObject({ clipId: z.string().min(1).max(128), key: z.string().regex(/^[a-z][a-zA-Z0-9]*$/).max(64) });
export const CompositionCanvasSchema = z.strictObject({ width: z.int().min(16).max(8192), height: z.int().min(16).max(8192) });
export const FreezeCompositionSchema = z.strictObject({ name: AuthoringNameSchema, document: CompositionDocumentSchema, canvas: CompositionCanvasSchema, expose: z.array(ExposureTargetSchema).max(128) });
export const CompositionPackageIdSchema = z.uuid();
export const CompositionPackageSchema = z.strictObject({
  formatVersion: z.literal(1),
  kind: z.literal('composition'),
  id: CompositionPackageIdSchema,
  name: AuthoringNameSchema,
  composition: CompositionSchema,
  canvas: CompositionCanvasSchema,
  dependencies: z.array(SourceRefSchema.extend({ hash: SourceHashSchema })).max(2048),
  exposed: z.array(ExposureTargetSchema.extend({ definition: ParamDefSchema })).max(128),
  externalImages: z.array(z.string().regex(/^(?:file|unlinked-file):[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/)).max(2048),
  externalSkins: z.array(SkinRefSchema).max(2048),
});

export type TemplateSourceFiles = z.infer<typeof TemplateSourceFilesSchema>;
export type WriteSourceRequest = z.infer<typeof WriteSourceSchema>;
export type FreezeCompositionRequest = z.infer<typeof FreezeCompositionSchema>;
export type CompositionPackage = z.infer<typeof CompositionPackageSchema>;
export type CompositionPackageEntry = Pick<CompositionPackage, 'id' | 'name'>;
export type CompositionPackageResult = { ok: true; entry: CompositionPackageEntry } | { ok: false; error: string } | { canceled: true };
export type ReadCompositionPackageResult = { ok: true; package: CompositionPackage } | { ok: false; error: string };
