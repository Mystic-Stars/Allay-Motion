import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { isReservedId, MAX_TEMPLATE_CODE_BYTES, parseManifest } from '@allay/template-sdk';
import { MAX_SOURCE_MANIFEST_BYTES, SourceRefSchema, type TemplateSourceFiles } from '../../shared/template-authoring';
import { analyzeTemplateCode, TemplateCodeError } from '../../shared/template-code';

export async function safeTemplateDir(root: string, id: string, version: string): Promise<string | null> {
  if (!SourceRefSchema.safeParse({ id, version }).success || isReservedId(id)) return null;
  const parent = join(root, id);
  const dir = join(parent, version);
  try {
    for (const path of [root, parent, dir]) {
      if (!(await lstat(path)).isDirectory()) return null;
    }
    return (await realpath(dir)) === join(await realpath(root), id, version) ? dir : null;
  } catch {
    return null;
  }
}

export async function readRegular(file: string, limit: number): Promise<Buffer | null> {
  const before = await lstat(file).catch(() => null);
  if (!before?.isFile() || before.nlink !== 1 || before.size > limit) return null;
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || actual.nlink !== 1 || actual.size > limit || actual.ino !== before.ino || actual.dev !== before.dev) return null;
    const bytes = Buffer.alloc(actual.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== actual.size) return null;
    return bytes.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export function sourceHash(files: TemplateSourceFiles): string {
  return createHash('sha256').update(JSON.stringify([files.source, files.manifest])).digest('hex');
}

export async function readSourceFiles(dir: string): Promise<(TemplateSourceFiles & { version: string }) | null> {
  const [source, manifest] = await Promise.all([
    readRegular(join(dir, 'template.js'), MAX_TEMPLATE_CODE_BYTES),
    readRegular(join(dir, 'manifest.json'), MAX_SOURCE_MANIFEST_BYTES),
  ]);
  if (!source || !manifest) return null;
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const files = { source: decoder.decode(source), manifest: decoder.decode(manifest) };
  return { ...files, version: sourceHash(files) };
}

export async function validateSource(id: string, version: string, files: TemplateSourceFiles) {
  if (Buffer.byteLength(files.manifest) > MAX_SOURCE_MANIFEST_BYTES) return { ok: false, message: 'manifest.json exceeds the size limit' } as const;
  let json: unknown;
  try {
    json = JSON.parse(files.manifest.replace(/^\uFEFF/, ''));
  } catch (error) {
    return { ok: false, message: String(error) } as const;
  }
  const parsed = parseManifest(json);
  if (!parsed.ok) return { ok: false, message: parsed.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ').slice(0, 2000) } as const;
  if (parsed.manifest.id !== id || parsed.manifest.version !== version || parsed.manifest.extends) {
    return { ok: false, message: 'manifest identity and script kind cannot change' } as const;
  }
  try {
    const diagnostics = await analyzeTemplateCode(files.source);
    if (diagnostics.length) return { ok: false, message: diagnostics[0]!.message, diagnostics } as const;
  } catch (error) {
    if (error instanceof TemplateCodeError) return { ok: false, message: error.message, diagnostics: [error.diagnostic] } as const;
    throw error;
  }
  return { ok: true, manifest: parsed.manifest } as const;
}

/** 先准备两份替换文件，再核对版本。单文件改名原子；第二次改名失败则恢复已替换的源码。 */
export async function replaceSourceFiles(dir: string, files: TemplateSourceFiles, before: TemplateSourceFiles & { version: string }, recheck: () => Promise<string | null>) {
  const token = randomUUID();
  const js = join(dir, `.${token}.js.tmp`);
  const manifest = join(dir, `.${token}.json.tmp`);
  const rollback = join(dir, `.${token}.rollback.tmp`);
  try {
    await writeFile(js, files.source, { flag: 'wx', flush: true });
    await writeFile(manifest, files.manifest, { flag: 'wx', flush: true });
    await writeFile(rollback, before.source, { flag: 'wx', flush: true });
    const currentVersion = await recheck();
    if (currentVersion === null) return { ok: false, error: 'io' } as const;
    if (currentVersion !== before.version) return { ok: false, error: 'conflict', currentVersion } as const;
    await rename(js, join(dir, 'template.js'));
    try {
      await rename(manifest, join(dir, 'manifest.json'));
    } catch (error) {
      await rename(rollback, join(dir, 'template.js'));
      throw error;
    }
    return { ok: true, version: sourceHash(files) } as const;
  } finally {
    await Promise.allSettled([js, manifest, rollback].map((file) => rm(file, { force: true })));
  }
}

export async function ensureTemplateParent(root: string, dir: string): Promise<void> {
  const parent = dirname(dir);
  if (!resolve(parent).startsWith(`${resolve(root)}${sep}`)) throw new Error('outside template root');
  await mkdir(root, { recursive: true });
  if (!(await lstat(root)).isDirectory()) throw new Error('invalid template root');
  await mkdir(parent).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
  if (!(await lstat(parent)).isDirectory()) throw new Error('invalid template parent');
}
