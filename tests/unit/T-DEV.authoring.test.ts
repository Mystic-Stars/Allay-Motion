import { mkdtemp, readFile, rm, writeFile, link, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CompositionSchema } from '../../packages/template-sdk/src';
import { encodeCompositionPackage, readCompositionArchive } from '../../apps/desktop/src/main/templates/composition-package';
import { IPC } from '../../apps/desktop/src/shared/ipc-channels';
import { IPC_ARGS } from '../../apps/desktop/src/shared/ipc-contract';
import { BASE_CODE, basePackage, derivedPackage, makeService, writePackage } from './helpers/template-fixtures';

const sourceRef = { id: 'user.test.base', version: '1.2.0' };
const builtinRef = { id: 'allay.builtin.source-test', version: '1.0.0' };
const image = 'unlinked-file:31a98dbb-cdcf-4a3f-a1e6-3b1a900f98cb';
const skin = 'skins:31a98dbb-cdcf-4a3f-a1e6-3b1a900f98cb';
const canvas = { width: 1080, height: 1920 };
const composition = (template = sourceRef) => CompositionSchema.parse({
  formatVersion: 1, fps: 60, durationFrames: 60, defaultProfile: 'local:00000000000000000000000000000000',
  tracks: [{ id: 'track', name: '测试', muted: false, locked: false, clips: [{ id: 'clip', startFrame: 0, durationFrames: 60, sourceInFrame: 0, template, params: { logo: image, skin, size: 3 } }] }],
});

describe('T-DEV-1 / T-DEV-2 应用内源码编辑与合成固化', () => {
  let root: string;
  let builtinDir: string;
  let service: Awaited<ReturnType<typeof makeService>>;
  const install = async (name: string, entries: ReturnType<typeof basePackage>) => {
    const staged = await service.stage(writePackage(join(root, name), entries));
    if (!('ok' in staged) || !staged.ok) throw new Error(JSON.stringify(staged));
    expect(await service.commit(staged.stagingId, { warnings: [] })).toMatchObject({ ok: true });
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'allay-authoring-'));
    builtinDir = join(root, 'builtin');
    writePackage(join(builtinDir, 'builtin.allaytpl'), basePackage(builtinRef));
    service = await makeService(root, builtinDir);
    await install('source.allaytpl', basePackage());
  });

  afterEach(async () => {
    expect(root.startsWith(join(tmpdir(), 'allay-authoring-'))).toBe(true);
    await rm(root, { force: true, recursive: true });
  });

  it('内置模板不可读写源码，复制后保留 JS；空白模板可在重启后读取', async () => {
    expect(await service.readSource(builtinRef.id, builtinRef.version)).toEqual({ ok: false, error: 'not-user' });
    expect(await service.copyBuiltin(builtinRef, { id: 'user.test.copy' })).toMatchObject({ ok: true });
    expect(await service.readSource('user.test.copy', '1.0.0')).toMatchObject({ ok: true, source: BASE_CODE });
    const blank = await service.createBlank('空白动画');
    const restarted = await makeService(root, builtinDir);
    expect(await restarted.readSource(blank.id, blank.version)).toMatchObject({ ok: true, source: expect.stringContaining('export default') });
  });

  it('读取两个文档，保护内容版本，保留原始文本及无效编辑前的版本', async () => {
    const read = () => service.readSource(sourceRef.id, sourceRef.version);
    const initial = await read();
    if (!initial.ok) throw new Error(initial.error);
    const save = (source: string, manifest: string, baseVersion = initial.version) => service.writeSource(sourceRef.id, sourceRef.version, { source, manifest, baseVersion });
    expect(await save('export default {\n  ?', initial.manifest)).toMatchObject({ ok: false, error: 'invalid', diagnostics: [{ kind: 'compile', line: 2 }] });
    expect(await save('export default Math.random();', initial.manifest)).toMatchObject({ ok: false, error: 'invalid', diagnostics: [{ code: 'math-random' }] });
    expect(await save(initial.source, initial.manifest.replace(sourceRef.id, 'user.test.other'))).toMatchObject({ ok: false, error: 'invalid' });
    expect(await read()).toEqual(initial);
    const manifest = `${initial.manifest}\n\n`;
    const next = `${initial.source}\n// 修改\n`;
    const saved = await save(next, manifest);
    if (!saved.ok) throw new Error(saved.error);
    expect(saved.version).not.toBe(initial.version);
    expect(await save(initial.source, initial.manifest)).toEqual({ ok: false, error: 'conflict', currentVersion: saved.version });
    expect(await read()).toEqual({ ok: true, source: next, manifest, version: saved.version });
    expect(await service.read(sourceRef.id, sourceRef.version)).toMatchObject({ code: next });
    const dir = service.userTemplateDir(sourceRef.id, sourceRef.version)!;
    await writeFile(join(dir, 'manifest.json'), '{');
    expect(await service.refreshUser(sourceRef.id, sourceRef.version)).toBeNull();
    const broken = await read();
    if (!broken.ok) throw new Error(broken.error);
    expect(await save(next, manifest, broken.version)).toEqual(saved);
  });

  it('不跟随固定文件硬链接或模板目录链接', async () => {
    const dir = service.userTemplateDir(sourceRef.id, sourceRef.version)!;
    const external = join(root, 'outside.js');
    const original = await service.readSource(sourceRef.id, sourceRef.version);
    if (!original.ok) throw new Error(original.error);
    await writeFile(external, BASE_CODE);
    await rm(join(dir, 'template.js'));
    await link(external, join(dir, 'template.js'));
    expect(await service.readSource(sourceRef.id, sourceRef.version)).toEqual({ ok: false, error: 'io' });
    expect(await service.writeSource(sourceRef.id, sourceRef.version, { source: '// blocked', manifest: original.manifest, baseVersion: original.version })).toEqual({ ok: false, error: 'io' });
    expect(await readFile(external, 'utf8')).toBe(BASE_CODE);
    await rm(join(dir, 'template.js'));
    await rm(join(dir, 'manifest.json'));
    await rm(join(dir, 'assets', 'base-only.png'));
    const { rmdir } = await import('node:fs/promises');
    await rmdir(join(dir, 'assets'));
    await rmdir(dir);
    const outside = join(root, 'outside');
    await mkdir(outside);
    await symlink(outside, dir, 'junction');
    expect(await service.readSource(sourceRef.id, sourceRef.version)).toEqual({ ok: false, error: 'io' });
  });

  it('只持久化合成数据与依赖，并在另一实例回读和验证版本', async () => {
    const model = composition();
    const pkg = await service.freezeComposition({ name: '可复用', document: JSON.stringify(model), canvas, expose: [{ clipId: 'clip', key: 'size' }] });
    expect(pkg).toMatchObject({ composition: model, canvas, exposed: [{ key: 'size' }], externalImages: [image], externalSkins: [skin], dependencies: [sourceRef] });
    const path = join(root, 'frozen.allaytpl');
    await writeFile(path, encodeCompositionPackage(pkg));
    const imported = await readCompositionArchive(path);
    await service.compositionLibrary.remember(imported);
    const restarted = await makeService(root, builtinDir);
    expect(await restarted.compositionLibrary.list()).toEqual([{ id: pkg.id, name: pkg.name }]);
    expect(await restarted.openComposition(pkg.id)).toEqual(pkg);
    const source = await restarted.readSource(sourceRef.id, sourceRef.version);
    if (!source.ok) throw new Error(source.error);
    expect(await restarted.writeSource(sourceRef.id, sourceRef.version, { manifest: source.manifest, source: `${source.source}\n// changed`, baseVersion: source.version })).toMatchObject({ ok: true });
    await expect(restarted.openComposition(pkg.id)).rejects.toThrow('frozen version');
  });

  it('拒绝派生、片段越界、未知暴露目标及错误包格式', async () => {
    await install('derived.allaytpl', derivedPackage());
    const freeze = (model: ReturnType<typeof composition>, expose: { clipId: string; key: string }[] = []) => service.freezeComposition({ name: 'Test', document: JSON.stringify(model), canvas, expose });
    await expect(freeze(composition({ id: 'user.test.derived', version: '1.0.0' }))).rejects.toThrow('expected a script template');
    const model = composition();
    model.tracks[0]!.clips[0]!.keyframes = [{ frame: 61, x: 10 }];
    await expect(freeze(model)).rejects.toThrow('out of bounds');
    await expect(freeze(composition(), [{ clipId: 'missing', key: 'size' }])).rejects.toThrow('unknown exposed parameter');
    const updated = await freeze(composition());
    await expect(readCompositionArchive(writePackage(join(root, 'extra.allaytpl'), { 'composition.json': JSON.stringify(updated), 'assets/unknown.png': 'fixture' }))).rejects.toThrow();
    await expect(readCompositionArchive(writePackage(join(root, 'future.allaytpl'), { 'composition.json': JSON.stringify({ ...updated, formatVersion: 2 }) }))).rejects.toThrow();
  });

  it('T-ARC-6 源码和合成 IPC 不接收路径或无效版本', () => {
    expect(IPC_ARGS[IPC.templates.readSource].safeParse([{ ...sourceRef, version: '..' }]).success).toBe(false);
    expect(IPC_ARGS[IPC.templates.readSource].safeParse([{ ...sourceRef, path: 'template.js' }]).success).toBe(false);
    expect(IPC_ARGS[IPC.templates.importComposition].safeParse(['template.allaytpl']).success).toBe(false);
    expect(IPC_ARGS[IPC.templates.openComposition].safeParse(['../x']).success).toBe(false);
  });
});
