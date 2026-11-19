import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Composition, CompositionClip } from '../../packages/template-sdk/src/composition';
import { FileGrants } from '../../apps/desktop/src/main/file-grants';
import { ProjectService } from '../../apps/desktop/src/main/project/service';
import type { ProjectData, QuickProjectData } from '../../apps/desktop/src/shared/project';
import { ProjectDataSchema } from '../../apps/desktop/src/shared/project';
import { applyUiPatch, defaultUiSettings, UiSettingsPatchSchema, UiSettingsSchema } from '../../apps/desktop/src/shared/settings';

// 工程文件 .allay 的读写（01-product-architecture.md 1.9）。主进程对话框的路径由这里的服务层测试覆盖，
// e2e 用测试开关 ALLAY_E2E_PROJECT_PATH 走通界面（decisions.md M4）。

const log = { info() {}, warn() {}, error() {} } as unknown as ConstructorParameters<typeof ProjectService>[0]['log'];

function data(params: QuickProjectData['params'] = {}): QuickProjectData {
  return {
    name: 'demo',
    template: { id: 'allay.builtin.block-wipe', version: '1.0.0' },
    params,
    output: { width: 1920, height: 1080, fps: 60 },
    export: { preset: 'prores4444', quality: 'standard', shutterAngle: 180, key: '#00FF00' },
    preview: { background: 'checker' },
    resourceHint: ['vanilla'],
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'allay-project-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('工程文件', () => {
  function compositionProject(params: CompositionClip['params']): ProjectData & { composition: Composition } {
    const { template, params: _, ...common } = data();
    return { ...common, composition: { formatVersion: 1, fps: 60, durationFrames: 18_000, tracks: [
      { id: 'track', name: 'Art', muted: true, locked: false, clips: [
        { id: 'a', startFrame: 0, durationFrames: 60, sourceInFrame: 0, template, params, profile: 'profile-a', keyframes: [{ frame: 20, opacity: 0.5 }] },
        { id: 'b', startFrame: 60, durationFrames: 30, sourceInFrame: 2, template, params: { cols: 10 } },
      ] },
    ] } };
  }

  it('T-STUDIO v2 保存独立参数；重启后从本地授权恢复嵌套图片，磁盘工程不带路径或字节', async () => {
    const grants = new FileGrants();
    const service = new ProjectService({ userDataDir: dir, appVersion: '0.1.0', grants, log });
    const image = join(dir, 'art.png');
    writeFileSync(image, 'image-fixture');
    const ref = grants.grant(image);
    const path = join(dir, 'studio.allay');
    const project = compositionProject({ layers: [{ image: `file:${ref}`, packageTexture: 'asset:art.png' }], second: `file:${ref}` });
    expect(await service.saveTo(path, project)).toMatchObject({ ok: true });
    const serialized = readFileSync(path, 'utf8');
    const token = JSON.parse(serialized).files[0] as string;
    expect(serialized).not.toContain(image);
    expect(serialized).not.toContain(ref);
    expect(serialized).not.toContain('image-fixture');
    expect(JSON.parse(serialized)).toMatchObject({ formatVersion: 2, composition: { durationFrames: 18_000 }, files: [token] });
    const reopenedGrants = new FileGrants();
    const reopened = new ProjectService({ userDataDir: dir, appVersion: '0.1.0', grants: reopenedGrants, log });
    const opened = await reopened.openPath(path);
    if (opened.canceled || !opened.ok || !('composition' in opened.data)) throw new Error('open failed');
    const params = opened.data.composition.tracks[0]!.clips[0]!.params;
    expect(reopenedGrants.resolve(String(params.second).slice(5))).toBe(image);
    expect(params.layers).toEqual([{ image: params.second, packageTexture: 'asset:art.png' }]);
    expect(opened.data.composition.tracks[0]!.clips[1]).toEqual(project.composition.tracks[0]!.clips[1]);
    expect(opened.data.composition.tracks[0]!.clips[0]!.profile).toBe('profile-a');
    rmSync(image);
    const missing = await reopened.openPath(path);
    expect(missing).toMatchObject({ ok: true, missingFiles: ['a'] });
    if (missing.canceled || !missing.ok || !('composition' in missing.data)) throw new Error('open failed');
    expect(missing.data.composition.tracks[0]!.clips[0]!.params.second).toBe(`unlinked-file:${token}`);
  });

  it('T-STUDIO 不信任未授权图片令牌，v2 不接受路径映射或输出帧率冲突', async () => {
    const token = randomUUID();
    const project = compositionProject({ logo: `file:${token}` });
    const service = new ProjectService({ userDataDir: dir, appVersion: '0.1.0', grants: new FileGrants(), log });
    const path = join(dir, 'external.allay');
    writeFileSync(path, JSON.stringify({ ...project, formatVersion: 2, files: [token] }));
    expect(await service.openPath(path)).toMatchObject({ ok: true, missingFiles: ['a'] });
    writeFileSync(path, JSON.stringify({ ...project, formatVersion: 2, files: { [token]: join(dir, 'art.png') } }));
    expect(await service.openPath(path)).toMatchObject({ ok: false, error: 'invalid' });
    expect(ProjectDataSchema.safeParse({ ...project, output: { ...project.output, fps: 24 } }).success).toBe(false);
  });
  it('保存后再打开，参数、输出、导出设置原样回来；格式与 1.9 一致', async () => {
    const svc = new ProjectService({ userDataDir: dir, appVersion: '0.1.0', grants: new FileGrants(), log });
    const file = join(dir, 'a.allay');
    const saved = await svc.saveTo(file, data({ cols: 16, inPattern: 'diagonal' }));
    expect(saved).toMatchObject({ ok: true, name: 'a' });
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    expect(raw).toMatchObject({ formatVersion: 1, appVersion: '0.1.0', template: { id: 'allay.builtin.block-wipe' }, params: { cols: 16 }, files: {} });
    const opened = await svc.openPath(file);
    expect(opened.canceled).toBeFalsy();
    if (opened.canceled || !opened.ok || !('params' in opened.data)) throw new Error('open failed');
    expect(opened.data.params).toEqual({ cols: 16, inPattern: 'diagonal' });
    expect(opened.name).toBe('a');
    expect(svc.pathOf(opened.handle)).toBe(file);
    expect((await svc.recents()).map((r) => r.name)).toEqual(['a']);
  });

  it('file: 引用保存为本机路径，打开时签发新的引用；文件丢了回到默认值并报告', async () => {
    const grants = new FileGrants();
    const svc = new ProjectService({ userDataDir: dir, appVersion: '0.1.0', grants, log });
    const img = join(dir, 'logo.png');
    writeFileSync(img, 'x');
    const ref = grants.grant(img);
    const file = join(dir, 'b.allay');
    await svc.saveTo(file, data({ logo: `file:${ref}`, bogus: 'file:3f2504e0-4f89-41d3-9a0c-0305e82c3301' }));
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    expect(raw.files).toEqual({ logo: img });
    expect(raw.params).toEqual({});
    const opened = await svc.openPath(file);
    if (opened.canceled || !opened.ok || !('params' in opened.data)) throw new Error('open failed');
    const v = opened.data.params.logo as string;
    expect(v).toMatch(/^file:[0-9a-f-]{36}$/);
    expect(v).not.toBe(`file:${ref}`);
    expect(grants.resolve(v.slice(5))).toBe(img);
    rmSync(img);
    const again = await svc.openPath(file);
    if (again.canceled || !again.ok || !('params' in again.data)) throw new Error('open failed');
    expect(again.missingFiles).toEqual(['logo']);
    expect(again.data.params.logo).toBeUndefined();
  });

  it('更高的 formatVersion、坏 JSON、缺字段、太大的文件都打不开', async () => {
    const svc = new ProjectService({ userDataDir: dir, appVersion: '0.1.0', grants: new FileGrants(), log });
    const write = (name: string, text: string) => {
      const p = join(dir, name);
      writeFileSync(p, text);
      return p;
    };
    expect(await svc.openPath(write('new.allay', JSON.stringify({ formatVersion: 3 })))).toMatchObject({ ok: false, error: 'too-new' });
    expect(await svc.openPath(write('invalid-v2.allay', JSON.stringify({ formatVersion: 2 })))).toMatchObject({ ok: false, error: 'invalid' });
    expect(await svc.openPath(write('bad.allay', '{nope'))).toMatchObject({ ok: false, error: 'unreadable' });
    expect(await svc.openPath(write('half.allay', JSON.stringify({ formatVersion: 1 })))).toMatchObject({ ok: false, error: 'invalid' });
    expect(await svc.openPath(write('big.allay', 'x'.repeat(3 * 1024 * 1024)))).toMatchObject({ ok: false, error: 'too-large' });
    expect(await svc.openPath(join(dir, 'none.allay'))).toMatchObject({ ok: false, error: 'missing' });
  });

  it('渲染进程交来的工程数据：多出的字段（例如路径）一律拒绝', () => {
    expect(ProjectDataSchema.safeParse(data()).success).toBe(true);
    expect(ProjectDataSchema.safeParse({ ...data(), files: { logo: 'C:\\x.png' } }).success).toBe(false);
    expect(ProjectDataSchema.safeParse({ ...data(), output: { width: 1920, height: 1080, fps: 61 } }).success).toBe(false);
  });

  it('最近的工程：最多 10 个，最新的在前，重复打开不重复列出', async () => {
    const svc = new ProjectService({ userDataDir: dir, appVersion: '0.1.0', grants: new FileGrants(), log });
    for (let i = 0; i < 12; i++) await svc.saveTo(join(dir, `p${i}.allay`), data());
    await svc.saveTo(join(dir, 'p3.allay'), data());
    const names = (await svc.recents()).map((r) => r.name);
    expect(names).toHaveLength(10);
    expect(names[0]).toBe('p3');
    expect(new Set(names).size).toBe(10);
    const reloaded = new ProjectService({ userDataDir: dir, appVersion: '0.1.0', grants: new FileGrants(), log });
    expect((await reloaded.recents()).map((r) => r.name)).toEqual(names);
  });
});

describe('编辑器偏好（settings.json 的 ui.editor）', () => {
  it('缺失或坏掉时回到默认值；修改是部分替换', () => {
    const ui = UiSettingsSchema.parse({ theme: 'light', language: 'en', reducedMotion: 'off', layout: { left: { size: 280, collapsed: false }, right: { size: 320, collapsed: false } } });
    expect(ui.editor.background).toBe('checker');
    const broken = UiSettingsSchema.parse({ ...ui, editor: { background: 'video', guides: 'yes', recent: 1 } });
    expect(broken.editor).toMatchObject({ background: 'checker', guides: false, recent: { color: [] } });
    const patch = UiSettingsPatchSchema.parse({ editor: { guides: true } });
    const next = applyUiPatch(defaultUiSettings(), patch);
    expect(next.editor.guides).toBe(true);
    expect(next.editor.background).toBe('checker');
    expect(UiSettingsPatchSchema.safeParse({ editor: { recent: { color: Array(13).fill('#000000'), block: [], item: [], texture: [] } } }).success).toBe(false);
  });
});
