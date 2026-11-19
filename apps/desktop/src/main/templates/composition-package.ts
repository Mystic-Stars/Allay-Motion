import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CompositionSchema, COMPOSITION_MAX_SECONDS, studioMaterialManifest, type Composition, type ParamDef, type ParamValue } from '@allay/template-sdk';
import { CompositionPackageIdSchema, CompositionPackageSchema, MAX_COMPOSITION_DOCUMENT_BYTES, type CompositionPackage, type FreezeCompositionRequest } from '../../shared/template-authoring';
import { PROJECT_IMAGE_REF, UNLINKED_PROJECT_IMAGE_REF } from '../../shared/project';
import { SkinRefSchema } from '../../shared/skins';
import type { TemplateBundle } from '../../shared/templates';
import { openZip } from '../resources/zip';
import { readRegular, sourceHash } from './source-files';
import { writeZip } from './zip-writer';

const PACKAGE_FILE = 'composition.json';
const MAX_ZIP_BYTES = MAX_COMPOSITION_DOCUMENT_BYTES + 1024;
type FindTemplate = (id: string, version: string) => Promise<TemplateBundle | null>;

const refKey = ({ id, version }: { id: string; version: string }) => `${id}@${version}`;
const targetKey = ({ clipId, key }: { clipId: string; key: string }) => JSON.stringify([clipId, key]);

function checkTimeline(composition: Composition): void {
  for (const track of composition.tracks) for (const clip of track.clips) {
    if (clip.sourceInFrame + clip.durationFrames > composition.fps * COMPOSITION_MAX_SECONDS || clip.keyframes?.some((point) => point.frame >= clip.durationFrames)) {
      throw new Error(`clip or keyframe out of bounds: ${clip.id}`);
    }
  }
}

function externalRefs(composition: Composition) {
  const images = new Set<string>();
  const skins = new Set<string>();
  const visit = (value: ParamValue): void => {
    if (typeof value === 'string') {
      if (PROJECT_IMAGE_REF.test(value) || UNLINKED_PROJECT_IMAGE_REF.test(value)) images.add(value.toLowerCase());
      else if (SkinRefSchema.safeParse(value).success) skins.add(value);
    }
    else if (value && typeof value === 'object') for (const child of Object.values(value)) visit(child);
  };
  for (const track of composition.tracks) for (const clip of track.clips) {
    for (const value of Object.values(clip.params)) visit(value);
  }
  return { externalImages: [...images].sort(), externalSkins: [...skins].sort() };
}

async function inspect(composition: Composition, find: FindTemplate) {
  checkTimeline(composition);
  const dependencies = new Map<string, CompositionPackage['dependencies'][number]>();
  const definitions = new Map<string, ParamDef[]>();
  for (const track of composition.tracks) for (const clip of track.clips) {
    const ref = clip.template;
    const key = refKey(ref);
    if (!dependencies.has(key)) {
      const native = studioMaterialManifest(ref);
      if (native) {
        dependencies.set(key, { ...ref, hash: sourceHash({ source: 'native-studio-material', manifest: JSON.stringify(native) }) });
        definitions.set(key, native.params ?? []);
        continue;
      }
      const bundle = await find(ref.id, ref.version);
      if (!bundle) throw new Error(`missing script template: ${key}`);
      // 只允许叶模板。派生模板的范围引用会在另一台机器上重新选版本，所以不纳入固化。
      if (bundle.entry.kind !== 'script' || bundle.entry.manifest.extends) throw new Error(`expected a script template: ${key}`);
      dependencies.set(key, { ...ref, hash: sourceHash({ source: bundle.code, manifest: JSON.stringify(bundle.entry.manifest) }) });
      definitions.set(key, bundle.resolved.params.filter((definition) => !bundle.resolved.hidden.includes(definition.key)));
    }
  }
  return { dependencies, definitions };
}

function resolveExposures(composition: Composition, targets: FreezeCompositionRequest['expose'], definitions: Map<string, ParamDef[]>) {
  const clips = new Map(composition.tracks.flatMap((track) => track.clips.map((clip) => [clip.id, clip] as const)));
  const used = new Set<string>();
  return targets.map((target) => {
    const identity = targetKey(target);
    if (used.has(identity)) throw new Error(`duplicate exposed parameter: ${target.clipId}/${target.key}`);
    used.add(identity);
    const clip = clips.get(target.clipId);
    const definition = clip && definitions.get(refKey(clip.template))?.find((candidate) => candidate.key === target.key);
    if (!definition) throw new Error(`unknown exposed parameter: ${target.clipId}/${target.key}`);
    return { clipId: target.clipId, key: target.key, definition };
  });
}

export async function freezeComposition(req: FreezeCompositionRequest, find: FindTemplate): Promise<CompositionPackage> {
  if (Buffer.byteLength(req.document) > MAX_COMPOSITION_DOCUMENT_BYTES) throw new Error('composition document is too large');
  const composition = CompositionSchema.parse(JSON.parse(req.document));
  const { definitions, dependencies } = await inspect(composition, find);
  const pkg = CompositionPackageSchema.parse({
    formatVersion: 1, kind: 'composition', id: randomUUID(), name: req.name, composition, canvas: req.canvas,
    dependencies: [...dependencies.values()], exposed: resolveExposures(composition, req.expose, definitions), ...externalRefs(composition),
  });
  documentBytes(pkg);
  return pkg;
}

async function checkDependencies(pkg: CompositionPackage, find: FindTemplate): Promise<CompositionPackage> {
  const { dependencies, definitions } = await inspect(pkg.composition, find);
  if (pkg.dependencies.length !== dependencies.size || new Set(pkg.dependencies.map(refKey)).size !== dependencies.size ||
      pkg.dependencies.some((dep) => dependencies.get(refKey(dep))?.hash !== dep.hash)) throw new Error('template dependency differs from the frozen version');
  const exposed = resolveExposures(pkg.composition, pkg.exposed, definitions);
  return { ...pkg, exposed, ...externalRefs(pkg.composition) };
}

function parseDocument(bytes: Uint8Array): CompositionPackage {
  const pkg = CompositionPackageSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  checkTimeline(pkg.composition);
  return pkg;
}

function documentBytes(pkg: CompositionPackage): Buffer {
  const bytes = Buffer.from(JSON.stringify(pkg));
  if (bytes.length > MAX_COMPOSITION_DOCUMENT_BYTES) throw new Error('composition package is too large');
  return bytes;
}

export function encodeCompositionPackage(pkg: CompositionPackage): Buffer {
  return writeZip([{ path: PACKAGE_FILE, data: documentBytes(pkg) }]);
}

export async function readCompositionArchive(file: string): Promise<CompositionPackage> {
  const info = await lstat(file);
  if (!info.isFile() || info.nlink !== 1 || info.size > MAX_ZIP_BYTES) throw new Error('invalid composition package file');
  const zip = await openZip(file, { maxEntries: 1, maxEntryBytes: MAX_COMPOSITION_DOCUMENT_BYTES, rejectLinks: true });
  try {
    if (zip.warnings.length || zip.paths.size !== 1) throw new Error('invalid composition package entries');
    const bytes = await zip.read(PACKAGE_FILE);
    if (!bytes) throw new Error('composition.json is missing');
    return parseDocument(bytes);
  } finally {
    zip.close();
  }
}

export async function writeCompositionAtomic(file: string, bytes: Uint8Array): Promise<void> {
  const temp = join(dirname(file), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, bytes, { flag: 'wx', flush: true });
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}

export class CompositionLibrary {
  constructor(private readonly root: string) {}

  async remember(pkg: CompositionPackage): Promise<void> {
    await mkdir(this.root, { recursive: true });
    if (!(await lstat(this.root)).isDirectory()) throw new Error('invalid composition library');
    await writeCompositionAtomic(join(this.root, `${pkg.id}.json`), documentBytes(pkg));
  }

  async list() {
    if (!(await lstat(this.root).catch(() => null))?.isDirectory()) return [];
    const result = [];
    for (const name of await readdir(this.root)) {
      const parsed = CompositionPackageIdSchema.safeParse(name.replace(/\.json$/, ''));
      if (!name.endsWith('.json') || !parsed.success) continue;
      const pkg = await this.read(parsed.data).catch(() => null);
      if (pkg) result.push({ id: pkg.id, name: pkg.name });
    }
    return result;
  }

  async read(id: string): Promise<CompositionPackage | null> {
    if (!CompositionPackageIdSchema.safeParse(id).success || !(await lstat(this.root).catch(() => null))?.isDirectory()) return null;
    const bytes = await readRegular(join(this.root, `${id}.json`), MAX_COMPOSITION_DOCUMENT_BYTES);
    if (!bytes) return null;
    const pkg = parseDocument(bytes);
    return pkg.id === id ? pkg : null;
  }

  async open(id: string, find: FindTemplate): Promise<CompositionPackage> {
    const pkg = await this.read(id);
    if (!pkg) throw new Error('composition template not found');
    return checkDependencies(pkg, find);
  }
}
