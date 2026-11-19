import { describe, expect, it, vi } from 'vitest';
import { diffFromDefaults, isParamVisible, LoadRequestSchema, parseManifest, sanitizeParams, type LoadRequest } from '../../packages/template-sdk/src';
import { openStill } from '../../apps/desktop/src/renderer/engine-host/still';
import { creationParams } from '../../apps/desktop/src/renderer/features/templates/profileDefaults';
import type { TemplateSource } from '../../apps/desktop/src/renderer/templates/catalog';
import { computeStage } from '../../packages/engine/src/stage';
import manifestJson from '../../packages/templates/advancement-toast/manifest.json';
import { javaGuiProjection, vanillaGuiScale } from '../../packages/templates/advancement-toast/src/java-gui-scale';

const parsed = parseManifest(manifestJson);
if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
const manifest = parsed.manifest;
const params = manifest.params ?? [];
const source: TemplateSource = { ref: { id: manifest.id, version: manifest.version }, manifest, params, hidden: [], code: 'export default {};', assets: null };

describe('T-FID Java 进度 GUI 缩放', () => {
  it.each([[1920, 1080, 4], [1280, 720, 3], [854, 480, 2], [640, 360, 1], [720, 1280, 2]])('%i×%i 选 %i 倍输出像素', (width, height, multiplier) => {
    const stage = computeStage({ width, height, fps: 60 });
    expect(vanillaGuiScale(width, height)).toBe(multiplier);
    expect(javaGuiProjection(stage).scale * stage.pixelScale).toBeCloseTo(multiplier);
  });

  it('奇数尺寸的右锚点按原版 GUI 宽取整，仍用未取整的画面投影', () => {
    const stage = computeStage({ width: 1921, height: 1081, fps: 60 });
    const { right, scale } = javaGuiProjection(stage);
    expect((right + stage.width / 2 - 160 * scale) * stage.pixelScale).toBeCloseTo(1924 - 640);
  });

  it.each(['1.21.1', '26.3', '26.3.0'])('只有新建且匹配 Java %s 时用原版自动，显式值优先', (version) => {
    const resource = { edition: 'java', version, release: true } as const;
    const created = creationParams(source, 'en', resource);
    expect(created.guiScaleMode).toBe('vanillaAuto');
    expect(diffFromDefaults(params, created).guiScaleMode).toBe('vanillaAuto');
    expect(creationParams(source, 'en', resource, { guiScale: 6 })).toMatchObject({ guiScaleMode: 'manual', guiScale: 6 });
    expect(creationParams(source, 'en', resource, { guiScaleMode: 'manual' }).guiScaleMode).toBe('manual');
    expect(creationParams(source, 'en', resource, { toastStyle: 'generic' }).guiScaleMode).toBe('manual');
  });

  it('旧 Java、通用、基岩与非匹配版本保留手动数值，自动模式只隐藏对应的滑杆', () => {
    const slider = params.find(({ key }) => key === 'guiScale')!;
    const mode = params.find(({ key }) => key === 'guiScaleMode')!;
    for (const toastStyle of ['javaAdvancement', 'javaAdvancement263', 'generic', 'bedrockAchievement', 'javaAchievement']) {
      const restored = sanitizeParams(params, { toastStyle, guiScale: 7 });
      expect(restored).toMatchObject({ guiScaleMode: 'manual', guiScale: 7 });
      expect(isParamVisible(slider, restored)).toBe(true);
      const isModern = toastStyle === 'javaAdvancement' || toastStyle === 'javaAdvancement263';
      expect(isParamVisible(mode, restored)).toBe(isModern);
      expect(isParamVisible(slider, { ...restored, guiScaleMode: 'vanillaAuto' })).toBe(!isModern);
    }
    for (const resource of [null, { edition: 'java', version: '1.21.9', release: true } as const]) {
      expect(creationParams(source, 'en', resource).guiScaleMode).toBe('manual');
    }
  });

  it('480 静帧是 1920 输出的投影，真正 480 项目按倍率 1；封面可以给定参考尺寸', async () => {
    const load = vi.fn(async (request: LoadRequest) => {
      LoadRequestSchema.parse(request);
      return { duration: 6.2, cutTime: null, audioCues: [], warnings: [] };
    });
    const host = { load, renderFrame: vi.fn() };
    const common = { source, params: {}, fps: 60, locale: 'en' };
    await openStill(host, { ...common, width: 1920, height: 1080, maxEdge: 480 });
    await openStill(host, { ...common, width: 480, height: 270 });
    await openStill(host, { ...common, width: 320, height: 180, referenceSize: { width: 1920, height: 1080 } });
    await openStill(host, { ...common, width: 1280, height: 720, maxEdge: 480 });
    const [reduced, native, cover, hd] = load.mock.calls.map(([request]) => request);
    expect(reduced).toMatchObject({ output: { width: 480, height: 270 }, referenceSize: { width: 1920, height: 1080 } });
    expect(native?.referenceSize).toBeUndefined();
    const projectedWidths = [reduced!, native!, cover!, hd!].map(({ output, referenceSize }) => {
      const stage = computeStage(output, referenceSize);
      expect(stage.referenceSize === undefined || Object.isFrozen(stage.referenceSize)).toBe(true);
      return 160 * javaGuiProjection(stage).scale * stage.pixelScale;
    });
    expect(projectedWidths[0]).toBeCloseTo(160);
    expect(projectedWidths[1]).toBeCloseTo(160);
    expect(projectedWidths[2]).toBeCloseTo(640 / 6);
    expect(projectedWidths[3]).toBeCloseTo(180);
    const invalid = { ...reduced, referenceSize: { width: 8193, height: 1080 } };
    expect(LoadRequestSchema.safeParse(invalid).success).toBe(false);
    expect(LoadRequestSchema.safeParse({ ...invalid, referenceSize: { width: 1920, height: 1080, path: 'x' } }).success).toBe(false);
  });
});
