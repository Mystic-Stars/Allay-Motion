// 模板开发模式的主进程部分（docs/08-milestones.md MD-a；docs/code-editing-and-mcp-plan.md H8、H10）：
// 监视服务（防抖、内容哈希去重、忽略临时文件、自己写入不触发、原子保存只触发一次、目录外的路径被拒绝）、
// 复制内置模板、写入类型定义与 jsconfig.json、打开文件夹。用临时目录和真实的文件系统事件，模板是测试时生成的。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TemplateWatcher, hashTemplateDir, isIgnoredTemplateFile, type TemplateChangeEvent } from '../../apps/desktop/src/main/templates/dev-watcher';
import { annotateBundledTemplate, TemplateDevService } from '../../apps/desktop/src/main/templates/dev-service';
import { TEMPLATE_API_DTS } from '../../apps/desktop/src/main/templates/template-api-dts';
import type { TemplateService } from '../../apps/desktop/src/main/templates/service';
import { TEMPLATE_JSCONFIG, templateJsconfigText } from '../../apps/desktop/src/shared/template-dev';
import type { TemplateDevChange } from '../../apps/desktop/src/shared/templates';
import { analyzeTemplateCode } from '../../apps/desktop/src/shared/template-code';
import { BASE_CODE, baseManifest, log, makeService } from './helpers/template-fixtures';
import { catalogIds } from '../fixtures/builtin-catalog';
import { buildTemplates } from '../../scripts/build-templates';

const DEBOUNCE = 60;
/** 文件系统事件的到达和防抖都需要时间：等到“安静”之后再判断 */
const settle = (ms = DEBOUNCE * 6 + 300) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(get: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = get();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function writeTemplate(root: string, id: string, version: string, code = BASE_CODE): string {
  const dir = join(root, id, version);
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(baseManifest({ id, version })));
  writeFileSync(join(dir, 'template.js'), code);
  return dir;
}

describe('H10 模板目录的监视服务', () => {
  let base: string;
  let root: string;
  let watcher: TemplateWatcher;
  let events: TemplateChangeEvent[];

  beforeEach(async () => {
    // 真实路径：CI 上 TEMP 是 8.3 短名（RUNNER~1），被测代码按真实路径（长名）比较
    base = realpathSync.native(mkdtempSync(join(tmpdir(), 'allay-watch-')));
    root = join(base, 'templates');
    writeTemplate(root, 'user.test.a', '1.0.0');
    watcher = new TemplateWatcher({ root, log, debounceMs: DEBOUNCE });
    events = [];
    watcher.onChange((e) => events.push(e));
    await watcher.start();
  });

  afterEach(() => {
    watcher.close();
    rmSync(base, { recursive: true, force: true });
  });

  it('启动时记下现有模板的哈希；改 template.js 报一次 changed，带新的内容哈希', async () => {
    const before = watcher.hashOf('user.test.a', '1.0.0');
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(join(root, 'user.test.a', '1.0.0', 'template.js'), `${BASE_CODE}\n// edited\n`);
    await waitFor(() => events[0]);
    await settle();
    expect(events).toHaveLength(1);
    const hash = await hashTemplateDir(join(root, 'user.test.a', '1.0.0'));
    expect(events[0]).toEqual({ id: 'user.test.a', version: '1.0.0', change: 'changed', hash });
    expect(hash).not.toBe(before);
  });

  it('内容没变（原样重写、只改了时间戳）不报', async () => {
    const file = join(root, 'user.test.a', '1.0.0', 'template.js');
    writeFileSync(file, readFileSync(file));
    await settle();
    expect(events).toEqual([]);
  });

  it('原子保存（写临时文件再改名覆盖）只触发一次', async () => {
    const dir = join(root, 'user.test.a', '1.0.0');
    for (let i = 0; i < 3; i++) {
      // 编辑器常见的做法：写 .tmp / ~ 文件，再改名覆盖目标；连续保存三次
      const tmp = join(dir, `template.js.${i}.tmp`);
      writeFileSync(tmp, `${BASE_CODE}\n// save ${i}\n`);
      renameSync(tmp, join(dir, 'template.js'));
    }
    await waitFor(() => events[0]);
    await settle();
    expect(events.map((e) => e.change)).toEqual(['changed']);
    expect(events[0]!.hash).toBe(await hashTemplateDir(dir));
  });

  it('临时文件、交换文件、类型定义、jsconfig、.vscode 的改动不报', async () => {
    const dir = join(root, 'user.test.a', '1.0.0');
    for (const name of ['template.js~', '.template.js.swp', '#template.js#', 'template.js.crswap', '4913', 'template-api.d.ts', 'jsconfig.json', 'notes.md']) writeFileSync(join(dir, name), 'x');
    mkdirSync(join(dir, '.vscode'));
    writeFileSync(join(dir, '.vscode', 'settings.json'), '{}');
    // 版本目录旁边的安装元数据、暂存区也不算
    writeFileSync(join(root, 'user.test.a', '1.0.0.meta.json'), '{}');
    mkdirSync(join(root, '.staging', 'x'), { recursive: true });
    writeFileSync(join(root, '.staging', 'x', 'template.js'), 'x');
    await settle();
    expect(events).toEqual([]);
  });

  it('assets/ 里的图片算模板内容', async () => {
    writeFileSync(join(root, 'user.test.a', '1.0.0', 'assets', 'logo.png'), 'png');
    await waitFor(() => events[0]);
    expect(events[0]).toMatchObject({ id: 'user.test.a', change: 'changed' });
  });

  it('新出现的模板报 added，删掉的报 removed（hash 为 null）', async () => {
    writeTemplate(root, 'user.test.b', '2.0.0');
    await waitFor(() => events.find((e) => e.id === 'user.test.b'));
    rmSync(join(root, 'user.test.a'), { recursive: true, force: true });
    await waitFor(() => events.find((e) => e.id === 'user.test.a'));
    await settle();
    expect(events.map((e) => `${e.id}@${e.version}:${e.change}:${e.hash === null ? 'null' : 'hash'}`).sort()).toEqual(['user.test.a@1.0.0:removed:null', 'user.test.b@2.0.0:added:hash']);
  });

  it('自己写入不触发事件（ownWrite 期间的事件不报，之后按新内容比较）', async () => {
    await watcher.ownWrite('user.test.a', '1.0.0', async () => {
      writeFileSync(join(root, 'user.test.a', '1.0.0', 'template.js'), `${BASE_CODE}\n// by the app\n`);
      // 模拟慢的写入：事件在写入期间就到了、防抖也到点了
      await settle(DEBOUNCE * 3);
      writeFileSync(join(root, 'user.test.a', '1.0.0', 'manifest.json'), JSON.stringify(baseManifest({ id: 'user.test.a', version: '1.0.0', name: 'renamed' })));
    });
    await settle();
    expect(events).toEqual([]);
    expect(watcher.hashOf('user.test.a', '1.0.0')).toBe(await hashTemplateDir(join(root, 'user.test.a', '1.0.0')));
    // 之后用户自己改，照常报
    writeFileSync(join(root, 'user.test.a', '1.0.0', 'template.js'), `${BASE_CODE}\n// by the user\n`);
    await waitFor(() => events[0]);
    expect(events[0]).toMatchObject({ change: 'changed' });
  });

  it('目录外的路径被拒绝：非法的 id 和版本、穿越、指向目录外的目录联接', async () => {
    expect(await watcher.resolveDir('user.test.a', '1.0.0')).toBe(join(root, 'user.test.a', '1.0.0'));
    expect(await watcher.resolveDir('..', '1.0.0')).toBeNull();
    expect(await watcher.resolveDir('user.test.a', '..')).toBeNull();
    expect(await watcher.resolveDir('user.test.a', '../../x')).toBeNull();
    expect(await watcher.resolveDir('C:\\Windows', '1.0.0')).toBeNull();
    expect(await watcher.resolveDir('user.test.missing', '1.0.0')).toBeNull();
    // 用户模板目录里的一个版本目录其实是指向外面的目录联接（Windows 上不需要管理员权限）
    const outside = join(base, 'outside');
    writeTemplate(outside, 'user.test.c', '1.0.0');
    mkdirSync(join(root, 'user.test.c'), { recursive: true });
    symlinkSync(join(outside, 'user.test.c', '1.0.0'), join(root, 'user.test.c', '1.0.0'), 'junction');
    expect(await watcher.resolveDir('user.test.c', '1.0.0')).toBeNull();
  });

  it('isIgnoredTemplateFile：只认 manifest.json、template.js、assets/**', () => {
    expect(isIgnoredTemplateFile('template.js')).toBe(false);
    expect(isIgnoredTemplateFile('manifest.json')).toBe(false);
    expect(isIgnoredTemplateFile('assets/a/b.png')).toBe(false);
    for (const p of ['template.js~', 'assets/.x.png.swp', 'jsconfig.json', 'template-api.d.ts', 'README.md', '../template.js', 'assets/../template.js', 'assets/~$x.png']) {
      expect(isIgnoredTemplateFile(p), p).toBe(true);
    }
  });
});

describe('模板开发模式：复制内置模板、写类型定义、打开文件夹', () => {
  let base: string;
  let svc: TemplateService;
  let dev: TemplateDevService;
  let opened: string[];
  let changes: TemplateDevChange[];

  beforeAll(async () => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), 'allay-dev-')));
    await buildTemplates(join(base, 'builtin'));
  }, 60_000);

  afterAll(() => rmSync(base, { recursive: true, force: true }));

  beforeEach(async () => {
    const userData = mkdtempSync(join(base, 'user-'));
    svc = await makeService(userData, join(base, 'builtin'));
    opened = [];
    changes = [];
    dev = new TemplateDevService({
      templates: svc,
      watcher: new TemplateWatcher({ root: join(userData, 'templates'), log, debounceMs: DEBOUNCE }),
      templateApiDts: TEMPLATE_API_DTS,
      openFolder: async (dir) => {
        opened.push(dir);
        return '';
      },
      log,
    });
    dev.onChange((c) => changes.push(c));
    await dev.start();
  });

  afterEach(() => dev.close());

  it('复制内置模板：新的用户 id（不以 allay. 开头）、版本 1.0.0、文件夹里有类型定义和 jsconfig；自己的写入不触发事件', async () => {
    const r = await dev.copyBuiltin({ id: 'allay.builtin.block-wipe', version: '1.0.0', name: '我的方块擦除' });
    if (!r.ok) throw new Error(r.error);
    expect(r.entry.id).toMatch(/^user\.[0-9a-f]{6}\.block-wipe$/);
    expect(r.entry).toMatchObject({ version: '1.0.0', source: 'user', kind: 'script' });
    expect(r.entry.manifest.name).toBe('我的方块擦除');
    expect(svc.list().some((e) => e.id === r.entry.id)).toBe(true);
    const dir = svc.userTemplateDir(r.entry.id, '1.0.0')!;
    expect(readFileSync(join(dir, 'template-api.d.ts'), 'utf8')).toBe(TEMPLATE_API_DTS);
    expect(readFileSync(join(dir, 'jsconfig.json'), 'utf8')).toBe(templateJsconfigText());
    // 读回来能装载：代码与内置的同源（只多一行类型注解），manifest 的参数不变
    const bundle = await svc.read(r.entry.id, '1.0.0');
    const builtin = await svc.read('allay.builtin.block-wipe', '1.0.0');
    expect(bundle!.code).toContain("/** @type {import('./template-api').TemplateModule} */");
    expect(bundle!.code.replace("/** @type {import('./template-api').TemplateModule} */\n", '')).toBe(builtin!.code);
    expect(bundle!.resolved.params).toEqual(builtin!.resolved.params);
    await settle();
    expect(changes).toEqual([]);
    // 重启后照样在
    const again = await makeService(join(dir, '..', '..', '..'), join(base, 'builtin'));
    expect(again.list().some((e) => e.id === r.entry.id && e.source === 'user')).toBe(true);
  });

  it('复制出来的每个内置模板，按写进去的 jsconfig 做 checkJs：除了已知的一处都没有错误', async () => {
    const options = { ...ts.convertCompilerOptionsFromJson(TEMPLATE_JSCONFIG.compilerOptions, base).options, allowJs: true, noEmit: true };
    // 已知的例外：T3 的源码里有 `tex.image as { width?: number; height?: number }`，打包时类型断言被去掉了，
    // 而 three 把 Texture.image 声明为 unknown（类型面与它一致，见 three-surface.d.ts）。外部编辑器里会在这两行标红，
    // 运行不受影响。别的模板、别的错误一律不许有
    const known: Record<string, string[]> = {
      'allay.builtin.item-stinger': [
        "Property 'width' does not exist on type 'unknown'.",
        "Property 'height' does not exist on type 'unknown'.",
        "Property 'width' does not exist on type 'unknown'.",
        "Property 'height' does not exist on type 'unknown'.",
      ],
    };
    const builtins = svc.list().filter((x) => x.source === 'builtin');
    expect(builtins.map(({ id }) => id).sort()).toEqual(catalogIds);
    const files = new Map<string, string>();
    for (const e of builtins) {
      const r = await dev.copyBuiltin({ id: e.id, version: e.version });
      if (!r.ok) throw new Error(r.error);
      const dir = svc.userTemplateDir(r.entry.id, '1.0.0')!;
      files.set(e.id, join(dir, 'template.js'));
      // 复制出来的代码照样通过安装时的源码预检，没有规则提示
      expect(await analyzeTemplateCode(readFileSync(join(dir, 'template.js'), 'utf8'))).toEqual([]);
    }
    const program = ts.createProgram({ rootNames: [...files.values()], options });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    for (const [id, file] of files) {
      expect(diagnostics.filter(diagnostic => diagnostic.file?.fileName === file.replaceAll('\\', '/'))
        .map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), id).toEqual(known[id] ?? []);
    }
    expect(diagnostics).toHaveLength(Object.values(known).flat().length);
  }, 120_000);

  it('只能复制内置的脚本模板', async () => {
    expect(await dev.copyBuiltin({ id: 'allay.builtin.nope', version: '1.0.0' })).toEqual({ ok: false, error: 'not-found' });
    const r = await dev.copyBuiltin({ id: 'allay.builtin.block-wipe', version: '1.0.0' });
    if (!r.ok) throw new Error(r.error);
    expect(await dev.copyBuiltin({ id: r.entry.id, version: '1.0.0' })).toEqual({ ok: false, error: 'not-builtin' });
  });

  it('外部改动：模板服务按新内容刷新，再通知；manifest 坏了时 valid 为 false 并从列表移除', async () => {
    const r = await dev.copyBuiltin({ id: 'allay.builtin.block-wipe', version: '1.0.0' });
    if (!r.ok) throw new Error(r.error);
    const dir = svc.userTemplateDir(r.entry.id, '1.0.0')!;
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...manifest, name: 'renamed outside' }));
    await waitFor(() => changes[0]);
    expect(changes[0]).toMatchObject({ id: r.entry.id, version: '1.0.0', change: 'changed', valid: true });
    expect(svc.list().find((e) => e.id === r.entry.id)?.manifest.name).toBe('renamed outside');

    writeFileSync(join(dir, 'manifest.json'), '{ not json');
    await waitFor(() => changes[1]);
    expect(changes[1]).toMatchObject({ change: 'changed', valid: false });
    expect(svc.list().some((e) => e.id === r.entry.id)).toBe(false);
  });

  it('删除、安装等模板服务自己的写入不触发事件', async () => {
    const r = await dev.copyBuiltin({ id: 'allay.builtin.block-wipe', version: '1.0.0' });
    if (!r.ok) throw new Error(r.error);
    expect(await svc.remove(r.entry.id, '1.0.0')).toBe(true);
    await settle();
    expect(changes).toEqual([]);
  });

  it('写类型定义、打开文件夹：只对用户模板，路径由主进程决定；内置模板和不存在的模板被拒绝', async () => {
    const r = await dev.copyBuiltin({ id: 'allay.builtin.block-wipe', version: '1.0.0' });
    if (!r.ok) throw new Error(r.error);
    const dir = svc.userTemplateDir(r.entry.id, '1.0.0')!;
    rmSync(join(dir, 'template-api.d.ts'));
    expect(await dev.writeDevFiles({ id: r.entry.id, version: '1.0.0' })).toEqual({ ok: true });
    expect(existsSync(join(dir, 'template-api.d.ts'))).toBe(true);

    expect(await dev.openFolder({ id: r.entry.id, version: '1.0.0' })).toEqual({ ok: true });
    // 打开的是文件夹，不是 template.js
    expect(opened).toEqual([dir]);

    for (const bad of [
      { id: 'allay.builtin.block-wipe', version: '1.0.0' },
      { id: 'user.test.none', version: '1.0.0' },
      { id: '..', version: '..' },
    ]) {
      expect(await dev.openFolder(bad)).toEqual({ ok: false, error: 'not-user' });
      expect(await dev.writeDevFiles(bad)).toEqual({ ok: false, error: 'not-user' });
    }
    expect(opened).toEqual([dir]);
    await settle();
    expect(changes).toEqual([]);
  });

  it('模板的文件夹被换成指向外面的目录联接：拒绝（outside），不写也不打开', async () => {
    const r = await dev.copyBuiltin({ id: 'allay.builtin.block-wipe', version: '1.0.0' });
    if (!r.ok) throw new Error(r.error);
    const dir = svc.userTemplateDir(r.entry.id, '1.0.0')!;
    const outside = join(base, `outside-${r.entry.id}`);
    renameSync(dir, outside);
    symlinkSync(outside, dir, 'junction');
    expect(await dev.writeDevFiles({ id: r.entry.id, version: '1.0.0' })).toEqual({ ok: false, error: 'outside' });
    // 写入拒绝后，监视器可能先发现坏联接并移除该模板；两种情况下都必须安全拒绝。
    expect(await dev.openFolder({ id: r.entry.id, version: '1.0.0' })).toMatchObject({ ok: false, error: expect.stringMatching(/^(outside|not-user)$/) });
    expect(opened).toEqual([]);
  });

  it('annotateBundledTemplate：认不出形状时原样返回', () => {
    expect(annotateBundledTemplate('export default {};')).toBe('export default {};');
    const code = 'var template = {\n  setup() {}\n};\nvar index_default = template;\nexport {\n  index_default as default\n};\n';
    expect(annotateBundledTemplate(code)).toBe(`/** @type {import('./template-api').TemplateModule} */\n${code}`);
  });
});
