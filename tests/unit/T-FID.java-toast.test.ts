import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { parseUnihex } from '../../packages/assets/src';
import { ease, math, segment } from '../../packages/engine/src/ease';
import { setupText } from '../../packages/engine/src/text';
import { applyPreset, createPreset, defaultParams, diffFromDefaults, isParamVisible, resolveDerived, sanitizeParams, TemplateManifestSchema, type FontPayload, type ParamValues, type SetupContext, type TextOptions } from '../../packages/template-sdk/src';
import manifest from '../../packages/templates/advancement-toast/manifest.json';
import { javaTextAlpha, javaToastTiming } from '../../packages/templates/advancement-toast/src/java-timing';
import { layoutJavaToastText, splitJavaTitle } from '../../packages/templates/advancement-toast/src/java-text';
import { setupVersionedToast, toastProfile } from '../../packages/templates/advancement-toast/src/versioned';

const requireEngine = createRequire(new URL('../../packages/engine/package.json', import.meta.url));
const THREE = await import(pathToFileURL(requireEngine.resolve('three').replace(/three\.cjs$/, 'three.module.js')).href) as SetupContext['THREE'];
const sprite = 'minecraft:gui/sprites/toast/advancement';
const achievementAtlas = 'minecraft:gui/achievement/achievement_background';
const toastAtlas = 'minecraft:gui/toasts';
const mockMetrics = (text: string) => {
  const advance = [...text].reduce((sum, letter) => sum + (letter === ' ' ? 4 : /\p{Script=Han}/u.test(letter) ? 8 : 6), 0);
  return { advance, width: advance, left: 0, above: 7, below: 1 };
};

function fixture(params: ParamValues, assets: string[] = [sprite], locale = 'en') {
  const stage = { width: 480, height: 270, aspect: 16 / 9, fps: 60, pixelScale: 1 };
  const scene = new THREE.Scene();
  const shared = new THREE.Texture();
  const icon = new THREE.Object3D();
  const text = vi.fn((opts: TextOptions) => ({ object: new THREE.Group(), width: mockMetrics(opts.text).width, height: 8, setOpacity: vi.fn() }));
  const optionalTexture = vi.fn(async (id: string) => assets.includes(id) ? shared : null);
  const cue = vi.fn();
  const item = vi.fn(async (id: string) => ({ id, single: () => icon }));
  const warn = vi.fn();
  const unexpected = (): never => { throw new Error('unexpected API'); };
  const ctx: SetupContext = {
    locale, THREE, stage, scene, params, warn, audio: { cue }, camera: new THREE.OrthographicCamera(),
    resources: { optionalTexture, texture: unexpected, block: unexpected, item },
    text: { create: text, measureGui: mockMetrics, prepare: async () => {} }, sprite: { create: unexpected },
    setCamera: unexpected, createStageCamera: unexpected, random: unexpected, noise2D: unexpected, ease, math, time: { segment },
  };
  return { ctx, optionalTexture, item, cue, text, icon, warn, shared, root: () => scene.children[0]! };
}

describe('T-FID.java-toast', () => {
  it('保留 generic 默认及旧 ID，并注册 26.3 专用样式', () => {
    const { params = [] } = TemplateManifestSchema.parse(manifest);
    const styles = params.find((param) => param.key === 'toastStyle');
    expect(styles?.type === 'enum' && styles.options.map(({ value }) => value)).toEqual(expect.arrayContaining(['generic', 'javaAchievement', 'javaAdvancement', 'javaAdvancement263']));
    expect(defaultParams(params).toastStyle).toBe('generic');
    expect(toastProfile('generic')).toBeUndefined();
    expect(toastProfile('bedrockAchievement')).toBeUndefined();
  });

  it('用各年代资源裁固定面板，不变异资源缓存，不盲目警告', async () => {
    for (const [profile, ids, rect] of [
      ['javaAchievement', [achievementAtlas], [96 / 256, 22 / 256, 1, 54 / 256]],
      ['javaAchievement', ['minecraft:gui/achievement/bg'], [96 / 256, 22 / 256, 1, 54 / 256]],
      ['javaAdvancement', [toastAtlas, sprite], [0, 224 / 256, 160 / 256, 1]],
      ['javaAdvancement', [sprite], [0, 0, 1, 1]],
      ['javaAdvancement263', [toastAtlas, sprite], [0, 0, 1, 1]],
    ] as const) {
      const fx = fixture({}, [...ids]);
      const instance = await setupVersionedToast(fx.ctx, profile);
      const panel = fx.root().children[0];
      if (!(panel instanceof THREE.Mesh)) throw new Error('missing panel');
      const uv = panel.geometry.getAttribute('uv');
      expect([uv.getX(0), uv.getY(2), uv.getX(1), uv.getY(0)]).toEqual(rect);
      const positions = panel.geometry.getAttribute('position');
      expect([positions.getX(1) - positions.getX(0), positions.getY(0) - positions.getY(2)]).toEqual([160, 32]);
      expect(fx.shared.offset.toArray()).toEqual([0, 0]);
      expect(fx.shared.repeat.toArray()).toEqual([1, 1]);
      expect(fx.warn).not.toHaveBeenCalled();
      instance.dispose?.();
    }
    const missing = fixture({}, [], 'zh-CN');
    await setupVersionedToast(missing.ctx, 'javaAchievement');
    expect(missing.warn).toHaveBeenCalledOnce();
    expect(missing.warn).toHaveBeenCalledWith(expect.stringContaining(achievementAtlas));
    expect(missing.root().children.some((child) => child instanceof THREE.Mesh)).toBe(false);
  });

  it('还原进入、停留、退出和端点；倒序取样不改变状态', async () => {
    const classic = javaToastTiming('javaAdvancement', {});
    const modern = fixture({ guiScale: 1 });
    const animation = await setupVersionedToast(modern.ctx, 'javaAdvancement263');
    expect([animation.duration, classic.duration, classic.outAt]).toEqual([6.2, 6.2, 5.6]);
    const sample = (time: number) => { animation.update(time); return [modern.root().visible, ...modern.root().position.toArray()]; };
    expect(sample(0.15)).toEqual([true, 310, 119, 0]);
    expect(sample(0.3)).toEqual([true, 280, 119, 0]);
    expect(sample(0.6)).toEqual([true, 160, 119, 0]);
    expect(sample(5.9)).toEqual([true, 200, 119, 0]);
    expect(sample(animation.duration - 0.005)[0]).toBe(false);
    expect(sample(0.005)[0]).toBe(false);
    expect(sample(0.15)).toEqual([true, 310, 119, 0]);

    const legacy = fixture({ guiScale: 1 }, [achievementAtlas]);
    const achievement = await setupVersionedToast(legacy.ctx, 'javaAchievement');
    expect(achievement.duration).toBe(3);
    for (const [time, top] of [[0.075, 14], [0.15, 4], [0.375, 0], [2.625, 0], [2.925, 14]] as const) {
      achievement.update(time);
      expect(legacy.root().position.toArray()).toEqual([160, 119 + top, 0]);
    }
  });

  it('短文按 GUI 左边界排版，使用选定语言、颜色、字体和图标', async () => {
    for (const [frame, expected, color] of [['task', '进度已达成！', '#FFFF00'], ['goal', '目标已达成！', '#FFFF00'], ['challenge', '挑战已完成！', '#FF88FF']] as const) {
      const fx = fixture({ frame, title: 'Example', headerFont: 'custom:header', titleFont: 'custom:title', icon: 'minecraft:apple' }, [sprite], 'zh-CN');
      await setupVersionedToast(fx.ctx, 'javaAdvancement263');
      expect(fx.text.mock.calls.slice(-2).map(([opts]) => opts)).toEqual([
        { text: expected, font: 'custom:header', size: 1, align: 'left', color, shadow: false, origin: 'guiBaseline' },
        { text: 'Example', font: 'custom:title', size: 1, align: 'left', color: '#FFFFFF', shadow: false, origin: 'guiBaseline' },
      ]);
      expect(fx.root().children.slice(1, 3).map((child) => child.position.toArray())).toEqual([[-50, 2, 3], [-50, -9, 3]]);
      expect(fx.item).toHaveBeenCalledWith('minecraft:apple');
      expect(fx.icon.position.toArray()).toEqual([-64, 0, 4]);
      expect(fx.icon.scale.toArray()).toEqual([16, 16, 1]);
    }
  });

  it('按 125 GUI 像素分行，在 1500ms 换段而非交叉淡化', async () => {
    expect(splitJavaTitle('AAAAAAAAAAAA AAAAAAAA AAAAAAA', mockMetrics)).toEqual(['AAAAAAAAAAAA AAAAAAAA', 'AAAAAAA']);
    expect(splitJavaTitle('中'.repeat(17), mockMetrics)).toEqual(['中'.repeat(15), '中'.repeat(2)]);
    expect(javaTextAlpha('javaAdvancement263', 1350)).toEqual({ header: 127 / 255, title: 0 });
    expect(javaTextAlpha('javaAdvancement263', 1490)).toEqual({ header: 0, title: 0 });
    expect(javaTextAlpha('javaAdvancement263', 1500)).toEqual({ header: 0, title: 0 });
    expect(javaTextAlpha('javaAdvancement', 1500)).toEqual({ header: 0, title: 0 });
    expect(javaTextAlpha('javaAdvancement263', 1650)).toEqual({ header: 0, title: 126 / 255 });
    expect(javaTextAlpha('javaAdvancement263', 1800)).toEqual({ header: 0, title: 252 / 255 });
    const fx = fixture({ title: 'AAAAAAAAAAAA AAAAAAAA AAAAAAA' });
    const animation = await setupVersionedToast(fx.ctx, 'javaAdvancement263');
    const labels = fx.text.mock.results.slice(-3).map(({ value }) => value!);
    expect(fx.text).toHaveBeenCalledTimes(3);
    expect(labels.map((label) => label.object.position.toArray())).toEqual([[-50, -2, 3], [-50, 2, 3], [-50, -7, 3]]);
    animation.update(2.25);
    expect(labels.map((label) => label.setOpacity.mock.lastCall)).toEqual([[0], [126 / 255], [126 / 255]]);
    animation.update(1);
    expect(labels.map((label) => label.setOpacity.mock.lastCall)).toEqual([[1], [0], [0]]);
  });

  it.each([
    ['custom', '进度已达成！', 'auto', 'en', 'task', '进度已达成！'],
    ['custom', '进度已达成！', 'en', 'en', 'challenge', '进度已达成！'],
    ['custom', 'Advancement Made!', 'zh-CN', 'zh-CN', 'goal', 'Advancement Made!'],
    ['custom', '', 'zh-CN', 'en', 'challenge', ''],
    ['follow', '旧的自定义字面', 'auto', 'en', 'challenge', 'Challenge Complete!'],
    ['follow', '', 'en', 'zh-CN', 'challenge', 'Challenge Complete!'],
    ['follow', '', 'zh-CN', 'en', 'goal', '目标已达成！'],
    ['follow', '', 'auto', 'zh-CN', 'task', '进度已达成！'],
    ['custom', '我的  钻石！', 'en', 'en', 'challenge', '我的  钻石！'],
  ])('经典头部 %s / %j / %s / %s / %s', async (javaHeadingMode, javaHeader, toastLanguage, locale, frame, expected) => {
    const fx = fixture({ javaHeadingMode, javaHeader, toastLanguage, frame, title: '钻石！' }, [sprite], locale);
    await setupVersionedToast(fx.ctx, 'javaAdvancement');
    expect(fx.text.mock.calls.map(([opts]) => opts.text)).toEqual([expected, '钻石！']);
    expect(fx.text.mock.calls[0]?.[0].color).toBe(frame === 'challenge' ? '#FF88FF' : '#FFFF00');
    expect(fx.cue.mock.calls.some(([sound]) => sound === 'minecraft:ui.toast.challenge_complete')).toBe(frame === 'challenge');
  });

  it('中文界面的自动标题不受英文名称影响', async () => {
    const fx = fixture({ javaHeadingMode: 'follow', toastLanguage: 'auto', javaTitle: 'Diamonds!', frame: 'goal' }, [sprite], 'zh-CN');
    await setupVersionedToast(fx.ctx, 'javaAdvancement');
    expect(fx.text.mock.calls.map(([opts]) => opts.text)).toEqual(['目标已达成！', 'Diamonds!']);
  });

  it('标题来源与输入、预设语言互斥；不影响名称、类型或旧样式控件', () => {
    const { params = [] } = TemplateManifestSchema.parse(manifest);
    for (const [toastStyle, javaHeadingMode, visible] of [
      ['javaAdvancement', 'follow', ['frame', 'javaHeadingMode', 'toastLanguage', 'javaTitle']],
      ['javaAdvancement263', 'custom', ['frame', 'javaHeadingMode', 'javaHeader', 'javaTitle']],
      ['javaAchievement', 'custom', ['javaHeadingMode', 'javaHeader', 'javaTitle']],
      ['bedrockAchievement', 'custom', ['toastLanguage', 'title']],
      ['generic', 'custom', ['frame', 'header', 'title']],
    ] as const) {
      const keys = ['frame', 'javaHeadingMode', 'toastLanguage', 'header', 'javaHeader', 'title', 'javaTitle'];
      const values = sanitizeParams(params, { toastStyle, javaHeadingMode });
      expect(params.filter((def) => keys.includes(def.key) && isParamVisible(def, values)).map(({ key }) => key)).toEqual(visible);
    }
  });

  it.each(['Advancement Made!', '进度已达成！', ''])('显式自定义 %j 可跨语言与预设保存恢复', (javaHeader) => {
    const base = TemplateManifestSchema.parse(manifest);
    const params = base.params ?? [];
    const custom = sanitizeParams(params, { toastStyle: 'javaAdvancement', javaHeadingMode: 'custom', javaHeader, frame: 'challenge' });
    const follow = sanitizeParams(params, { ...custom, javaHeadingMode: 'follow' });
    expect(follow.javaHeader).toBe(javaHeader);
    for (const state of [custom, follow]) {
      const saved = createPreset(base, 'heading', params, state, new Date(0), { locale: 'zh-CN' });
      const reopened = applyPreset(params, saved, { locale: 'en' });
      expect(reopened).toMatchObject({ javaHeadingMode: state.javaHeadingMode, javaHeader, frame: 'challenge' });
      expect(sanitizeParams(params, { ...reopened, javaHeadingMode: 'custom' }).javaHeader).toBe(javaHeader);
    }
  });

  it('旧完整片段、预设和脚本的默认标题仍跟随类型，明确字面保留', async () => {
    const base = TemplateManifestSchema.parse(manifest);
    const defs = base.params ?? [];
    for (const [overrides, mode, expected] of [
      [{ header: 'Advancement Made!' }, 'follow', 'Challenge Complete!'],
      [{ header: '进度已达成！' }, 'follow', 'Challenge Complete!'],
      [{ header: '' }, 'follow', 'Challenge Complete!'],
      [{ header: '我的标题' }, 'custom', '我的标题'],
      [{ javaHeader: 'Advancement Made!' }, 'custom', 'Advancement Made!'],
      [{ javaHeader: '进度已达成！' }, 'custom', '进度已达成！'],
      [{ javaHeadingMode: 'custom', javaHeader: '' }, 'custom', ''],
      [{ javaHeadingMode: 'follow', javaHeader: '我的标题' }, 'follow', 'Challenge Complete!'],
    ] as const) {
      const { javaHeadingMode: _mode, javaHeader: _heading, javaTitle: _title, ...oldDefaults } = defaultParams(defs, { locale: 'zh-CN' });
      const raw = { ...oldDefaults, toastStyle: 'javaAdvancement', frame: 'challenge', toastLanguage: 'en', ...overrides };
      const clean = sanitizeParams(defs, raw);
      expect(clean.javaHeadingMode).toBe(mode);
      const preset = { ...createPreset(base, 'legacy', defs, {}, new Date(0)), params: raw };
      expect(applyPreset(defs, preset)).toEqual(clean);
      for (const params of [raw, clean]) {
        const fx = fixture(params);
        await setupVersionedToast(fx.ctx, 'javaAdvancement');
        expect(fx.text.mock.calls[0]?.[0].text).toBe(expected);
      }
    }
    expect(sanitizeParams(defs, { toastStyle: 'javaAdvancement', javaHeader: '', header: '未生效的旧值' }).javaHeadingMode).toBe('follow');
    expect(sanitizeParams(defs, { toastStyle: 'javaAdvancement' }).javaHeadingMode).toBe('follow');
  });

  it('迁移旧长名称，但没有第二个可编辑字段覆盖新名称', () => {
    const { params = [] } = TemplateManifestSchema.parse(manifest);
    const migrated = sanitizeParams(params, { toastStyle: 'javaAdvancement', title: '旧短字段', javaLongTitle: '实际生效的旧名称' });
    expect(migrated.javaTitle).toBe('实际生效的旧名称');
    expect(migrated).not.toHaveProperty('javaLongTitle');
    const saved = diffFromDefaults(params, { ...migrated, javaTitle: '新编辑名称' });
    expect(sanitizeParams(params, saved).javaTitle).toBe('新编辑名称');
    expect(sanitizeParams(params, { ...migrated, javaLongTitle: '保留在旧片段中的字段', javaTitle: '新编辑名称' }).javaTitle).toBe('新编辑名称');
    expect(sanitizeParams(params, { toastStyle: 'javaAdvancement', javaLongTitle: '', title: '旧短字段' }).javaTitle).toBe('旧短字段');
    expect(sanitizeParams(params, { title: '旧通用名称', javaLongTitle: '隐藏的旧字段' }).title).toBe('旧通用名称');
    const header = sanitizeParams(params, { toastStyle: 'javaAdvancement', header: '进度已达成！' });
    expect(header.javaHeader).toBe('进度已达成！');
    expect(sanitizeParams(params, diffFromDefaults(params, header), { locale: 'en' }).javaHeader).toBe('进度已达成！');
    const cleared = diffFromDefaults(params, { ...header, header: '旧自定义行', javaHeader: '' });
    expect(sanitizeParams(params, cleared).javaHeader).toBe('');
    expect(sanitizeParams(params, { toastStyle: 'javaAdvancement' }, { locale: 'zh-CN' }).javaHeader).toBe('');
    const localized = sanitizeParams(params, { toastStyle: 'javaAdvancement', title: '钻石！' });
    expect(sanitizeParams(params, diffFromDefaults(params, localized, { locale: 'zh-CN' }), { locale: 'en' }).javaTitle).toBe('钻石！');
  });

  it('旧派生模板的 Java 名称覆盖能迁移，新字段仍优先', () => {
    const base = TemplateManifestSchema.parse(manifest);
    const derived = TemplateManifestSchema.parse({
      formatVersion: 1, id: 'test.toast', version: '1.0.0', name: 'Toast fixture', category: 'overlay',
      extends: { id: base.id, version: base.version },
      overrides: { defaults: { toastStyle: 'javaAdvancement', title: '旧短名', javaLongTitle: '旧长名', header: 'Advancement Made!' }, hidden: ['javaLongTitle'] },
    });
    const resolved = resolveDerived(derived, base);
    expect(defaultParams(resolved.params)).toMatchObject({ javaTitle: '旧长名', javaHeadingMode: 'follow' });
    expect(resolved.hidden).toContain('javaTitle');
    expect(sanitizeParams(resolved.params, { javaTitle: '新覆盖' }).javaTitle).toBe('新覆盖');
    for (const [defaults, heading] of [
      [{ javaHeader: 'Advancement Made!' }, 'Advancement Made!'],
      [{ javaHeadingMode: 'custom', javaHeader: '进度已达成！' }, '进度已达成！'],
      [{ javaHeadingMode: 'custom', javaHeader: '' }, ''],
    ] as const) {
      const overridden = resolveDerived({ ...derived, overrides: { defaults: { ...derived.overrides?.defaults, ...defaults } } }, base);
      expect(defaultParams(overridden.params)).toMatchObject({ javaHeadingMode: 'custom', javaHeader: heading });
    }
  });

  it('真实栅格化：Unihex 为 8 GUI 像素，高清图集和混排不丢源行，量字不建贴图', async () => {
    const latin = new Uint8Array(12 * 16 * 4);
    for (let y = 0; y < 16; y++) latin[(y * 12 + (y % 2) * 10) * 4 + 3] = 255;
    const tables = parseUnihex(`4E2D:${'8001'.repeat(16)}\n`)!;
    const font: FontPayload = { kind: 'font', skipped: [], providers: [
      { type: 'space', advances: [[32, 4]] },
      { type: 'bitmap', ascent: 7, height: 8, rows: [[65]], image: { width: 12, height: 16, data: latin } },
      { type: 'unihex', tables },
    ] };
    const owned: Parameters<typeof setupText>[3] = [];
    const painter = await setupText([], (id) => Promise.resolve(id === 'minecraft:default' ? font : null), vi.fn(), owned, () => true);
    expect(painter.measureGui('A 中')).toEqual({ advance: 20, width: 20, left: 0, above: 7, below: 1 });
    expect(painter.measureGui('中')).toEqual({ advance: 9, width: 9, left: 0, above: 7, below: 1 });
    expect(owned).toHaveLength(0);
    const label = painter.create({ text: 'A中', size: 1, origin: 'guiBaseline' });
    expect(label.height).toBe(8);
    const image = owned[0]?.image as { width: number; height: number; data: Uint8Array };
    expect([image.width, image.height]).toEqual([32, 16]);
    expect([image.data[3], image.data[(image.width + 10) * 4 + 3], image.data[29 * 4 + 3]]).toEqual([0, 0, 255]);
    expect(image.data[10 * 4 + 3]).toBe(255);
    const bounds = new THREE.Box3().setFromObject(label.object);
    expect([bounds.min.y, bounds.max.y]).toEqual([-1, 7]);
    expect(painter.create({ text: '中', size: 1 }).height).toBe(16);
    owned.forEach((texture) => texture.dispose());
  });

  it('限定三行容量，必要时省略而不压缩普通字号；高字形保留完整上下部', () => {
    const large = (text: string) => ({ ...mockMetrics(text), above: 12, below: 3 });
    const result = layoutJavaToastText('进度已达成！', '超长名称'.repeat(16), large, large, false);
    expect(result.alternating).toBe(true);
    expect(result.titles).toHaveLength(1);
    expect(result.titles[0]?.text).toMatch(/…$/u);
    expect([result.header, ...result.titles].every(({ baseline, above, below, scale }) => baseline - above >= 3 && baseline + below <= 29 && scale === 1)).toBe(true);
    const layout = layoutJavaToastText('进度已达成！', '钻石！', mockMetrics, large, false);
    expect(layout.alternating).toBe(false);
    expect(layout.titles[0]!.baseline + layout.titles[0]!.below).toBeLessThanOrEqual(29);
    expect(layout.titles[0]!.baseline - layout.titles[0]!.above).toBeGreaterThan(layout.header.baseline + layout.header.below);
  });

  it('经典中文两行使用原版 GUI 基线且不碰框底', async () => {
    const words = '进度已达成！钻石';
    const tables = parseUnihex(Array.from(words, (letter) => `${letter.codePointAt(0)!.toString(16)}:${'8001'.repeat(16)}`).join('\n'))!;
    const owned: Parameters<typeof setupText>[3] = [];
    const font: FontPayload = { kind: 'font', skipped: [], providers: [{ type: 'unihex', tables }] };
    const text = await setupText([], (id) => Promise.resolve(id === 'minecraft:default' ? font : null), vi.fn(), owned, () => true);
    const { params = [] } = TemplateManifestSchema.parse(manifest);
    const values = sanitizeParams(params, { toastStyle: 'javaAdvancement', javaHeadingMode: 'custom', javaHeader: '进度已达成！', javaTitle: '钻石！' }, { locale: 'en' });
    const fx = fixture(values);
    try {
      await setupVersionedToast({ ...fx.ctx, text }, 'javaAdvancement');
      expect(owned).toHaveLength(2);
      expect(fx.root().children.slice(1, 3).map((object) => {
        const bounds = new THREE.Box3().setFromObject(object);
        return [16 - bounds.max.y, 16 - bounds.min.y];
      })).toEqual([[7, 15], [18, 26]]);
      expect(fx.warn).not.toHaveBeenCalled();
    } finally { owned.forEach((texture) => texture.dispose()); }
  });

  it('区分三代音效，保留自定义节拍与自选音效', async () => {
    for (const [profile, expected] of [
      ['javaAchievement', []],
      ['javaAdvancement', [['minecraft:ui.toast.in', 0], ['minecraft:ui.toast.challenge_complete', 0.601], ['minecraft:ui.toast.out', 5.6]]],
      ['javaAdvancement263', [['minecraft:ui.toast.challenge_complete', 0], ['minecraft:ui.toast.in', 0], ['minecraft:ui.toast.out', 5.6]]],
    ] as const) {
      const fx = fixture({ frame: 'challenge', sound: 'minecraft:ui.toast.in' });
      await setupVersionedToast(fx.ctx, profile);
      expect(fx.cue.mock.calls.map(([id, at]) => [id, at])).toEqual(expected);
    }
    const fx = fixture({ javaTiming: 'custom', inDuration: 0.25, hold: 2.5, outDuration: 0.25, sound: 'custom:cue', volume: 0.4 });
    expect((await setupVersionedToast(fx.ctx, 'javaAdvancement263')).duration).toBe(3);
    expect(fx.cue.mock.calls).toEqual([['custom:cue', 0, { gain: 0.4 }]]);
    const old = javaToastTiming('javaAdvancement', { inDuration: 0.2, hold: 1, outDuration: 0.3 });
    expect(old.duration).toBe(1.5);
    expect(old.sample(0.5).holdAge).toBe(1500);
    expect(javaToastTiming('javaAdvancement', { javaTiming: 'vanilla', hold: 1 }).duration).toBe(6.2);
  });
});
