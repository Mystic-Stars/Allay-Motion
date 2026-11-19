import { ExecutionTraceLinesSchema, MAX_EXECUTION_TRACE_LINES, MAX_TEMPLATE_CODE_BYTES, type ParamValue } from '@allay/template-sdk';
import { z } from 'zod';
import type { CodeInspectorAction, CodeInspectorPacket } from '../shared/code-inspector';
import { MAX_SOURCE_MANIFEST_BYTES } from '../shared/template-authoring';

const text = (max: number) => z.string().refine((value) => value.length <= max && Buffer.byteLength(value) <= max);
const token = z.int().nonnegative();
const baseVersion = z.string().min(1).max(128);
const appearance = { language: z.enum(['en', 'zh-CN']), theme: z.enum(['dark', 'light']) };
const files = { source: text(MAX_TEMPLATE_CODE_BYTES), manifest: text(MAX_SOURCE_MANIFEST_BYTES) };
const lines = z.custom<unknown[]>((value) => Array.isArray(value) && value.length <= 4096)
  .pipe(z.array(z.int().nonnegative()));

function boundedParams(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  let bytes = 256 * 1024;
  let nodes = 16_384;
  const charge = (part: string) => part.length <= bytes && (bytes -= Buffer.byteLength(part)) >= 0;
  const visit = (item: unknown, depth: number): boolean => {
    if (--nodes < 0 || depth > 32) return false;
    if (typeof item === 'string') return charge(item);
    if (typeof item === 'number') return Number.isFinite(item);
    if (item === null || typeof item === 'boolean') return true;
    if (Array.isArray(item)) return item.length <= nodes && item.every((child: unknown) => visit(child, depth + 1));
    if (typeof item !== 'object' || Object.getPrototypeOf(item) !== Object.prototype) return false;
    let count = 0;
    for (const key in item) {
      if (!Object.hasOwn(item, key) || (depth === 0 && ++count > 128)
        || key === '__proto__' || key === 'constructor' || key === 'prototype'
        || !charge(key) || !visit((item as Record<string, unknown>)[key], depth + 1)) return false;
    }
    return true;
  };
  return visit(value, 0);
}

export const packetSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('document'), token, id: z.string().min(1).max(256), version: z.string().min(1).max(128),
    clipId: z.string().min(1).max(128).optional(), title: text(4096), ...files, editable: z.boolean(),
    ...appearance, baseVersion: baseVersion.optional(),
  }),
  z.strictObject({
    type: z.literal('params'), token, params: z.custom<Record<string, ParamValue>>(boundedParams), fps: z.number().gt(0).max(240),
  }),
  z.strictObject({
    type: z.literal('frame'), token, time: z.number().nonnegative(), frame: z.int().nonnegative(),
    playing: z.boolean(), lines,
  }),
  z.strictObject({
    type: z.literal('setup'), token,
    lines: z.custom<unknown[]>((value) => Array.isArray(value) && value.length <= MAX_EXECUTION_TRACE_LINES).pipe(ExecutionTraceLinesSchema),
  }),
  z.strictObject({ type: z.literal('empty'), message: text(8192), ...appearance }),
  z.strictObject({ type: z.literal('result'), token, ok: z.boolean(), message: text(8192) }),
]) satisfies z.ZodType<CodeInspectorPacket>;

export const actionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('save'), token, ...files, baseVersion }),
  z.strictObject({ type: z.literal('copy'), token }),
  z.strictObject({ type: z.literal('authoring') }),
]) satisfies z.ZodType<CodeInspectorAction>;

export const noArgs = z.tuple([]);
export const dirtyArgs = z.tuple([z.boolean()]);
export const publishArgs = z.tuple([packetSchema]);
export const actionArgs = z.tuple([actionSchema]);
