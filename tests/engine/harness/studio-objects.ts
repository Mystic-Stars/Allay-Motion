import { mixFrames, mixOffline } from '../../../apps/desktop/src/renderer/audio/mix';
import { scheduleCues } from '../../../apps/desktop/src/renderer/audio/schedule';
import { SoundBank } from '../../../apps/desktop/src/renderer/audio/sound-bank';
import { encodeWav } from '../../../apps/desktop/src/renderer/audio/wav';
import { EngineHost, type ResourceResolver } from '../../../apps/desktop/src/renderer/engine-host/EngineHost';
import { studioMaterialRefs, type CompositionClip, type CompositionLoadRequest, type ParamValues } from '../../../packages/template-sdk/src/index';

const size = 80;
const fps = 30;
const draft = { subframes: 1, shutterAngle: 0 };
const image = 'file:152b09cf-7a04-4a64-bf21-d857311aee01';
const sound = `user-audio:${'1'.repeat(32)}`;
const alternateFont = 'test:alternate';

function rgba(width: number, height: number, color: number[]) {
  const data = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set(color, offset);
  return { width, height, data };
}

function summarize(bytes: Uint8Array) {
  let left = size, right = -1, top = size, bottom = -1;
  for (let index = 3; index < bytes.length; index += 4) {
    if (!bytes[index]) continue;
    const pixel = (index - 3) / 4;
    const column = pixel % size;
    const row = Math.floor(pixel / size);
    left = Math.min(left, column);
    right = Math.max(right, column);
    top = Math.min(top, row);
    bottom = Math.max(bottom, row);
  }
  const center = ((size / 2) * size + size / 2) * 4;
  return { width: Math.max(0, right - left + 1), height: Math.max(0, bottom - top + 1), center: [...bytes.subarray(center, center + 4)] };
}

export async function probeStudioObjects() {
  const template = studioMaterialRefs.object;
  const resolver = (replacement: boolean): ResourceResolver => async (kind, id) => {
    if (kind === 'texture' && id === image) return { kind: 'rgba', ...rgba(8, 4, [255, 32, 0, 128]) };
    if (kind === 'texture' && id === 'minecraft:block/stone') return { kind: 'rgba', ...rgba(4, 4, replacement ? [0, 255, 0, 255] : [0, 0, 255, 255]) };
    if (kind === 'font' && (id === 'minecraft:default' || id === alternateFont)) {
      return { kind: 'font', providers: [{ type: 'bitmap', ascent: 8, height: 8, rows: [[65]], image: rgba(id === alternateFont ? 8 : 2, 8, [255, 255, 255, 255]) }], skipped: [] };
    }
    if (kind === 'sound-meta' && id === sound) return { kind: 'sound', variants: [{ file: sound, kind: 'music', volume: 1, pitch: 1, weight: 1 }] };
    return null;
  };
  const request = (params: ParamValues, options: { sourceIn?: number; frames?: number; length?: number; replacement?: boolean } = {}): CompositionLoadRequest => {
    const clip: CompositionClip = { id: 'object', template, params, startFrame: 30, sourceInFrame: options.sourceIn ?? 0, durationFrames: options.length ?? 30 };
    return {
      sources: [{ template, resourceStamp: options.replacement ? 'pack' : 'base' }],
      output: { width: size, height: size, fps },
      composition: { formatVersion: 1, fps, durationFrames: options.frames ?? 65,
        tracks: [{ id: 'test', name: 'test', locked: false, muted: false, clips: [clip] }] },
    };
  };
  const exported = await EngineHost.create({ mode: 'export', resolveResource: resolver(false), strictDeterminism: true });
  const preview = await EngineHost.create({ mode: 'preview', canvas: document.createElement('canvas'), resolveResource: resolver(false), strictDeterminism: true });
  try {
    await preview.resize(size, size);
    async function visual(params: ParamValues, replacement = false) {
      const req = request(params, { sourceIn: 4 * fps, replacement });
      const loaded = await exported.loadComposition(req, [resolver(replacement)]);
      const frame = async (index: number) => summarize(await exported.renderFrame(index, draft));
      const first = await frame(30);
      const after = await frame(60);
      const last = await frame(59);
      const before = await frame(29);
      const deterministic = await exported.checkDeterminism(45, [60, 59, 29, 30], draft);
      await preview.loadComposition(req, [resolver(replacement)]);
      const previewFrame = summarize(await preview.readPreview(1));
      return { first, last, before, after, previewFrame, deterministic, cues: loaded.audioCues };
    }
    const visuals = {
      image: await visual({ kind: 'image', image, sound }),
      text: await visual({ kind: 'text', text: 'A', textSize: 25, sound }),
      alternateText: await visual({ kind: 'text', text: 'A', textSize: 25, font: alternateFont }),
      block: await visual({ kind: 'block', sound }),
      packedBlock: await visual({ kind: 'block' }, true),
      emptyImage: await visual({ kind: 'image' }),
    };

    const req = request({ kind: 'sound', sound, image, text: 'A' }, { sourceIn: 120 * fps, frames: 300 * fps, length: 299 * fps });
    const loaded = await exported.loadComposition(req, [resolver(false)]);
    await preview.loadComposition(req, [resolver(false)]);
    const audioPixels = [];
    for (const index of [8999, 29, 30]) audioPixels.push(summarize(await exported.renderFrame(index, draft)));
    const audioPreview = summarize(await preview.readPreview(120));
    const rate = 8000;
    const samples = new Float32Array(300 * rate).fill(0.2, 120 * rate, 121 * rate).fill(0.6, 297 * rate, 298 * rate);
    const bytes = encodeWav([samples, samples], rate);
    const bank = new SoundBank(async (id) => id === sound ? bytes : null);
    const mixed = await mixOffline(loaded.audioCues, mixFrames(loaded.totalFrames!, fps), bank);
    if (!mixed.wav) throw new Error('missing audio mix');
    const pcm = new DataView(mixed.wav.buffer, mixed.wav.byteOffset, mixed.wav.byteLength);
    const sampleAt = (seconds: number) => pcm.getInt16(44 + Math.round(seconds * 48_000) * 4, true) / 32767;
    const { voices } = await bank.prepare(loaded.audioCues);
    const tail = new OfflineAudioContext(2, 24_000, 48_000);
    scheduleCues(tail, tail.destination, voices, { from: 178, startAt: 0, until: 178.5 });
    const sought = await tail.startRendering();
    const trimmed = await exported.loadComposition(request({ kind: 'sound', sound }, { sourceIn: 120 * fps, length: 15 }), [resolver(false)]);
    const cut = await mixOffline(trimmed.audioCues, mixFrames(trimmed.totalFrames!, fps), bank);
    if (!cut.wav) throw new Error('missing trimmed audio mix');
    const cutPcm = new DataView(cut.wav.buffer, cut.wav.byteOffset, cut.wav.byteLength);
    const cutSamples = [1.25, 1.75].map((seconds) => cutPcm.getInt16(44 + seconds * 48_000 * 4, true) / 32767);
    return { visuals, audioPixels, audioPreview, cues: loaded.audioCues, duration: loaded.duration,
      wavBytes: mixed.wav.byteLength, samples: [0.75, 1.5, 2.25, 178.25, 181.25, 299.5].map(sampleAt), sought: sought.getChannelData(0)[12000], cutSamples };
  } finally {
    preview.dispose();
    exported.dispose();
  }
}
