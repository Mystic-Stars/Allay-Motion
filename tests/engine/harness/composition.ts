import { EngineHost } from '../../../apps/desktop/src/renderer/engine-host/EngineHost';
import { TemplateManifestSchema, type CompositionLoadRequest, type ResourcePayload } from '../../../packages/template-sdk/src/index';

const template = { id: 'test.engine.composition', version: '1.0.0' };
const manifest = TemplateManifestSchema.parse({ formatVersion: 1, ...template, name: 'Fixture', category: 'overlay', params: [] });
const code = `export default { async setup(ctx) {
  const { THREE, stage } = ctx;
  const map = await ctx.resources.texture('asset:identical.png');
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(stage.width / 2, stage.height), new THREE.MeshBasicMaterial({ map }));
  mesh.position.x = -stage.width / 4;
  ctx.scene.add(mesh);
  const original = ctx.camera;
  const camera = original.clone();
  camera.position.x = -stage.width / 4;
  ctx.audio.cue('test:shared', 0);
  return { duration: 1, update(time) { ctx.setCamera(time >= 2 / 30 ? camera : original); } };
}};`;

const size = 64;
const fps = 30;
const draft = { subframes: 1, shutterAngle: 180 };
const blur = { subframes: 2, shutterAngle: 360 };
const point = (pixels: Uint8Array, x: number) => [...pixels.subarray((32 * size + x) * 4, (32 * size + x) * 4 + 4)];

export async function probeComposition() {
  let textureReads = 0;
  const resources = [[255, 0, 0, 255], [0, 0, 255, 255]].map((rgba) => async (kind: string): Promise<ResourcePayload | null> => {
    if (kind === 'texture') {
      textureReads++;
      return { kind: 'rgba', width: 1, height: 1, data: new Uint8Array(rgba) };
    }
    if (kind === 'sound-meta') return { kind: 'sound', variants: [{ file: 'test:shared', volume: 1, pitch: 1, weight: 1 }] };
    return null;
  });
  const request: CompositionLoadRequest = {
    output: { width: size, height: size, fps },
    sources: ['red', 'blue'].map((profile) => ({ template, profile, code, manifest, resourceStamp: profile })),
    composition: {
      formatVersion: 1, fps, durationFrames: 4, defaultProfile: 'red',
      tracks: [
        { id: 'bottom', name: 'bottom', muted: false, locked: true, clips: [
          { id: 'red', template, params: {}, startFrame: 0, sourceInFrame: 0, durationFrames: 2, transform: { opacity: 0.5 } },
        ] },
        { id: 'top', name: 'top', muted: false, locked: false, clips: [
          { id: 'blue', template, params: {}, startFrame: 1, sourceInFrame: 2, durationFrames: 2, profile: 'blue', transform: { opacity: 0.5 } },
        ] },
        { id: 'mute', name: 'mute', muted: true, locked: false, clips: [
          { id: 'muted', template: { id: 'test.engine.missing', version: '1.0.0' }, params: {}, startFrame: 0, sourceInFrame: 0, durationFrames: 4 },
        ] },
      ],
    },
  };
  const exported = await EngineHost.create({ mode: 'export', resolveResource: async () => null, strictDeterminism: true });
  const preview = await EngineHost.create({ mode: 'preview', canvas: document.createElement('canvas'), resolveResource: async () => null, strictDeterminism: true });
  try {
    const loaded = await exported.loadComposition(request, resources);
    await preview.resize(size, size);
    await preview.loadComposition(request, resources);
    const overlap = point(await exported.renderFrame(1, draft), 24);
    const independent = point(await exported.renderFrame(1, draft), 40);
    const previewPixel = point(await preview.readPreview(1 / fps), 24);
    const first = point(await exported.renderFrame(0, draft), 24);
    const afterRed = point(await exported.renderFrame(2, draft), 24);
    const transparent = point(await exported.renderFrame(3, draft), 24);
    const opaque = point(await exported.renderFrame(3, draft, { key: '#00ff00' }), 24);
    const seek = await exported.checkDeterminism(1, [3, 2, 0, 2, 3], blur);
    const invalid = await exported.renderFrame(4, draft).then(() => false, () => true);
    const edited = structuredClone(request);
    edited.composition.tracks[0]!.clips[0]!.durationFrames = 1;
    for (const track of edited.composition.tracks.slice(0, 2)) track.clips[0]!.transform = { opacity: 1 };
    const readsBeforeEdit = textureReads;
    await exported.loadComposition(edited, resources);
    const editTextureReads = textureReads - readsBeforeEdit;
    const shutter = point(await exported.renderFrame(1, blur), 24);
    const editedSource = edited.sources[1];
    if (!editedSource || !('code' in editedSource)) throw new Error('missing script fixture');
    editedSource.code = 'export default { setup() { throw new Error("reject change"); } };';
    const rejected = await exported.loadComposition(edited, resources).then(() => false, () => true);
    const afterReject = point(await exported.renderFrame(1, blur), 24);
    await preview.clear();
    return { loaded, overlap, independent, previewPixel, first, afterRed, transparent, opaque, seek, invalid, shutter,
      editTextureReads, rejected, afterReject, cleared: point(await preview.readPreview(1 / fps), 24) };
  } finally {
    preview.dispose();
    exported.dispose();
  }
}
