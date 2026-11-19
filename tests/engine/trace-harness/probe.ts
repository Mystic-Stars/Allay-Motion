import { EngineHost, type SetupTraceSample } from '../../../apps/desktop/src/renderer/engine-host/EngineHost';
import { DEFAULT_FONT_ID, FALLBACK_FONT_ID, FontUsageFlag, TemplateManifestSchema, diagnosticOf, type CompositionLoadRequest } from '../../../packages/template-sdk/src/index';
import { parseUnihex } from '../../../packages/assets/src/index';

const target = { id: 'test.execution-trace', version: '1.0.0' };
const manifest = TemplateManifestSchema.parse({ formatVersion: 1, ...target, name: 'Trace fixture', category: 'overlay', params: [] });
const output = { width: 32, height: 32, fps: 30 } as const;
const size = output.width;
const code = `const selectX = (isLeft) => isLeft
  ? -100 // 左分支
  : 100; // 右分支
export default { setup({ THREE, scene }) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(500, 500), new THREE.MeshBasicMaterial({ color: 0xc04020, transparent: true, opacity: 0.5 }));
  scene.add(mesh);
  return { duration: 1, update(time) {
    "still a directive"
    if (time < 0.1)
      return mesh.visible = false;
    mesh.visible = true
    for (let index = 0; index < 1; index++)
      mesh.position.x = selectX(time < 0.5);
    if (time < 0.5) mesh.position.y = 100
    else mesh.position.y = -100
    if (time > 0.9) throw new Error('fixture runtime error');
  } };
} };`;

export async function probeExecutionTrace() {
  const host = await EngineHost.create({ mode: 'preview', canvas: document.createElement('canvas'), resolveResource: async () => null, strictDeterminism: true });
  const request = { manifest, code, output, params: {}, resourceStamp: 'fixture' };
  try {
    await host.resize(size, size);
    await host.load(request);
    const baseline = await host.readPreview(0.25);
    const early = await host.render(0, undefined, target);
    const left = await host.render(0.25, undefined, target);
    const traced = await host.readPreview(0.25);
    const right = await host.render(0.75, undefined, target);
    const both = await host.render(0.5, { subframes: 2, shutterAngle: 360 }, target);
    const seek = await host.render(0.25, undefined, target);
    const error = await host.render(0.95, undefined, target).then(() => null, (reason: unknown) => diagnosticOf(reason));
    const off = await host.render(0.25);
    const restored = await host.readPreview(0.25);
    const reloadedCode = `// 新版本的行偏移，模板 ID 和版本保持不变\n${code}`;
    await host.load({ ...request, code: reloadedCode });
    const reloaded = await host.render(0.25, undefined, target);
    const fallbackCode = code.replace('scene.add(mesh);', 'scene.add(mesh); let noop; noop ||= () => 1;');
    await host.load({ ...request, code: fallbackCode });
    const unavailable = await host.render(0.25, undefined, target);
    const fallbackPixels = await host.readPreview(0.25);
    return {
      early: early.trace, left: left.trace, right: right.trace, both: both.trace, seek: seek.trace, off: off.trace, error,
      exactSource: left.traceSource === code && reloaded.traceSource === reloadedCode, reloaded: reloaded.trace,
      hasVisiblePixels: baseline.some((value) => value !== 0),
      equalPixels: baseline.every((value, index) => traced[index] === value && restored[index] === value && fallbackPixels[index] === value),
      unavailable: unavailable.trace,
    };
  } finally {
    host.dispose();
  }
}

export async function probeTraceComposition() {
  const host = await EngineHost.create({ mode: 'preview', canvas: document.createElement('canvas'), resolveResource: async () => null });
  const { fps } = output;
  const request: CompositionLoadRequest = {
    output,
    sources: [{ template: target, manifest, code, resourceStamp: 'fixture' }],
    composition: {
      formatVersion: 1, fps, durationFrames: 24,
      tracks: [{ id: 'track', name: 'Track', muted: false, locked: false, clips: [
        { id: 'red', template: target, params: {}, startFrame: 0, sourceInFrame: 5, durationFrames: 24 },
        { id: 'blue', template: target, params: {}, startFrame: 5, sourceInFrame: 16, durationFrames: 10 },
      ] }],
    },
  };
  try {
    await host.resize(size, size);
    await host.loadComposition(request, [async () => null]);
    const at = 7 / fps;
    const baseline = await host.readPreview(at);
    const red = await host.render(at, undefined, { ...target, clipId: 'red' });
    const redPixels = await host.readPreview(at);
    const blue = await host.render(at, undefined, { ...target, clipId: 'blue' });
    const bluePixels = await host.readPreview(at);
    const inactive = await host.render(4 / fps, undefined, { ...target, clipId: 'blue' });
    const wrongVersion = await host.render(at, undefined, { ...target, version: '9.9.9', clipId: 'blue' });
    return {
      red: red.trace, blue: blue.trace, inactive: inactive.trace, wrongVersion: wrongVersion.trace,
      equalPixels: baseline.every((value, index) => redPixels[index] === value && bluePixels[index] === value),
    };
  } finally {
    host.dispose();
  }
}

export async function probeSetupTrace() {
  const setupMarker = 'test:trace-setup-marker';
  const setupCalls: Record<string, number> = {};
  let executions = 0;
  const resolveResource: Parameters<typeof EngineHost.create>[0]['resolveResource'] = async (kind, id) => {
    if (kind === 'texture' && id === setupMarker) executions++;
    return null;
  };
  const host = await EngineHost.create({ mode: 'preview', canvas: document.createElement('canvas'), resolveResource });
  const setupManifest = TemplateManifestSchema.parse({ ...manifest, params: [{ key: 'alternate', type: 'boolean', label: 'Alternate', default: false }] });
  const source = `async function prepare(ctx) {
  await ctx.resources.texture(${JSON.stringify(setupMarker)});
  if (ctx.params.alternate)
    return 2;
  return 1;
}
export default { async setup(ctx) {
  let declaration;
  const neverCalled = () => {
    throw new Error('not called');
  };
  const value = await prepare(ctx);
  if (value === 1) ctx.scene.visible = true;
  else ctx.scene.visible = false;
  return { duration: 1, update() {
    ctx.scene.position.x = value;
  } };
} };`;
  const request = { manifest: setupManifest, code: source, output, params: {}, resourceStamp: 'setup' };
  const render = async (time: number, selection = target as typeof target & { clipId?: string }) => {
    let setup: SetupTraceSample | null = null;
    const { trace } = await host.render(time, undefined, selection, (sample) => { setup = sample; });
    return { setup: setup as SetupTraceSample | null, trace };
  };
  try {
    await host.resize(size, size);
    await host.load(request, target);
    setupCalls.initialLoad = executions;
    const first = await render(0.25);
    await host.render(0.25);
    const reopened = await render(0.75);
    setupCalls.reopened = executions;
    await host.setParams({ alternate: true }, target);
    setupCalls.paramsChanged = executions;
    const changed = await render(0.25);
    setupCalls.paramsRendered = executions;
    await host.load(request);
    setupCalls.untracedLoad = executions;
    const late = await render(0.25);
    setupCalls.lateSelection = executions;
    await host.render(0.25);
    await render(0.75);
    setupCalls.lateReopened = executions;

    const composition: CompositionLoadRequest = {
      output,
      sources: [{ template: target, manifest: setupManifest, code: source, resourceStamp: 'setup-composition' }],
      composition: { formatVersion: 1, fps: 30, durationFrames: 24,
        tracks: [{ id: 'track', name: 'Track', muted: false, locked: false, clips: [
          { id: 'a', template: target, params: {}, startFrame: 0, sourceInFrame: 0, durationFrames: 20 },
          { id: 'b', template: target, params: { alternate: true }, startFrame: 2, sourceInFrame: 0, durationFrames: 20 },
        ] }] },
    };
    const firstClip = { ...target, clipId: 'a' };
    const secondClip = { ...target, clipId: 'b' };
    await host.loadComposition(composition, [resolveResource], firstClip);
    setupCalls.compositionLoaded = executions;
    const a = await render(0.25, firstClip);
    const b = await render(0.25, secondClip);
    setupCalls.secondClipSelected = executions;
    const inactive = await render(0, secondClip);
    const back = await render(0.25, firstClip);
    setupCalls.firstClipReselected = executions;
    return { first, reopened, changed, late, a, b, inactive, back, setupCalls };
  } finally {
    host.dispose();
  }
}

export async function probeFontUsage() {
  const latin = parseUnihex(`0041:${'3c'.repeat(16)}`)!;
  const complete = parseUnihex(`4E2D:${'3c'.repeat(16)}`)!;
  const requested = new Set<string>();
  const host = await EngineHost.create({ mode: 'preview', canvas: document.createElement('canvas'), resolveResource: hostResources });
  const code = `export default { setup(ctx) {
    ctx.text.measureGui('中', 'minecraft:default');
    ctx.text.create({ text: '中', size: 20 });
    const labels = [
      ctx.text.create({ text: 'A', size: 20, origin: 'guiBaseline' }),
      ctx.text.create({ text: '中', size: 20, origin: 'guiBaseline' }),
      ctx.text.create({ text: 'A中', size: 20, origin: 'guiBaseline' }),
      ctx.text.create({ text: 'A中\\n中', size: 20 }),
      ctx.text.create({ text: 'A中', font: ${JSON.stringify(FALLBACK_FONT_ID)}, size: 20 }),
      ctx.text.create({ text: 'A中', font: 'test:complete', size: 20 }),
    ];
    for (const text of labels) ctx.scene.add(text.object);
    return { duration: 8, update(time) {
      labels.forEach((label, index) => { label.object.visible = index === Math.floor(time); label.setOpacity(time < 0.5 ? 0 : 1); });
    } };
  } };`;
  const fontManifest = TemplateManifestSchema.parse({ ...manifest, params: [{ key: 'font', type: 'font', label: 'Synthetic', default: 'test:complete' }] });
  try {
    await host.resize(size, size);
    await host.load({ manifest: fontManifest, code, output, params: {}, resourceStamp: 'font-usage' });
    const results = [];
    for (const time of [0.1, 0.75, 1.2, 2.2, 3.2, 4.2, 5.2, 7, 1.2]) results.push((await host.render(time)).fontUsage?.map(({ flags }) => flags) ?? []);
    const fps = output.fps;
    await host.loadComposition({ output, sources: [{ template: target, manifest: fontManifest, code, resourceStamp: 'font-usage' }], composition: {
      formatVersion: 1, fps, durationFrames: 60, tracks: [{ id: 'track', name: 'Track', muted: false, locked: false, clips: [
        { id: 'whole', template: target, params: {}, startFrame: 0, sourceInFrame: 30, durationFrames: 30 },
        { id: 'partial', template: target, params: {}, startFrame: 0, sourceInFrame: 60, durationFrames: 60 },
      ] }],
    } }, [hostResources]);
    const overlap = (await host.render(0.2)).fontUsage;
    const single = (await host.render(1.2)).fontUsage;
    return { results, overlap, single, flags: FontUsageFlag, requested: [...requested] };
  } finally { host.dispose(); }

  async function hostResources(kind: string, id: string) {
    if (kind !== 'font') return null;
    requested.add(id);
    if (id === DEFAULT_FONT_ID || id === 'test:complete') return { kind: 'font' as const, skipped: [], providers: [{ type: 'unihex' as const, tables: structuredClone(id === DEFAULT_FONT_ID ? latin : complete) }] };
    return null;
  }
}

export async function probeSystemFont() {
  const requested: string[] = [];
  const resolveResource = async (kind: string, id: string) => {
    if (kind === 'font') requested.push(id);
    return null;
  };
  const output = { width: 512, height: 256, fps: 30 };
  const preview = await EngineHost.create({ mode: 'preview', canvas: document.createElement('canvas'), resolveResource });
  const exported = await EngineHost.create({ mode: 'export', resolveResource });
  const source = `export default {setup(ctx) {
    const entries = ['Aj', '中', 'あ', '한', ' ', 'Aj 中あ한', 'j', '\\t'];
    for (const text of entries) {
      const measure = ctx.text.measureGui(text);
      const label = ctx.text.create({text, size: 1, origin: 'guiBaseline'});
      const {data, width, height} = label.object.children[0].material.map.image;
      const alpha = data.filter((_, index) => index % 4 === 3);
      let hash = 0;
      for (const byte of alpha) hash = (Math.imul(hash, 31) + byte) | 0;
      const {min, max} = new ctx.THREE.Box3().setFromObject(label.object);
      ctx.warn('glyph-test:' + JSON.stringify({measure, width, height, hash, ink: alpha.some((x) => x > 0), edge: alpha.some((x) => x > 0 && x < 255), geometry: [label.width, label.height], bounds: [min.x, min.y, max.y]}));
    }
    const old = 'user-font:' + 'a'.repeat(64);
    const alias = ctx.text.create({text: 'Aj 中あ한', font: old, size: 24, origin: 'guiBaseline'});
    alias.object.position.x = -alias.width / 2;
    ctx.scene.add(alias.object);
    const other = ctx.text.create({text: 'Aj 中あ한', size: 24});
    other.object.position.set(-other.width / 2, -250, 0);
    ctx.scene.add(other.object);
    ctx.text.create({text: '\\u{10FFFD}\\u{10FFFD}', size: 1});
    ctx.warn('font-globals:' + typeof globalThis.fonts + '/' + typeof globalThis.queryLocalFonts + '/' + typeof globalThis.document);
    return {duration: 1, update() {}};
  }};`;
  try {
    const request = { manifest, code: source, output, params: {}, resourceStamp: 'empty-fonts', locale: 'en' } as const;
    await preview.resize(output.width, output.height);
    const loaded = await preview.load(request);
    await exported.load({ ...request, locale: 'zh-CN' });
    const stats = await preview.render(0);
    const actual = await preview.readPreview(0);
    const frame = await exported.renderFrame(0, { subframes: 1, shutterAngle: 0 });
    return {
      requested,
      warnings: loaded.warnings,
      flags: stats.fontUsage,
      anyInk: frame.some((value, index) => index % 4 === 3 && value > 0),
      anyEdge: frame.some((value, index) => index % 4 === 3 && value > 0 && value < 255),
      equal: actual.length === frame.length && actual.every((value, index) => {
        const alpha = frame[index - index % 4 + 3]!;
        const expected = index % 4 === 3 ? alpha : Math.round(frame[index]! * alpha / 255);
        return Math.abs(value - expected) <= 1;
      }),
    };
  } finally {
    preview.dispose();
    exported.dispose();
  }
}

Object.assign(window, { executionTraceHarness: { probeExecutionTrace, probeTraceComposition, probeSetupTrace, probeFontUsage, probeSystemFont } });
