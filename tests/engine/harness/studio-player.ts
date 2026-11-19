import { EngineHost } from '../../../apps/desktop/src/renderer/engine-host/EngineHost';
import { studioMaterialRefs, type CompositionLoadRequest, type ParamValues } from '../../../packages/template-sdk/src/index';
import { fakeResolveResource } from './fake-resources';

/** 玩家是工作台内部素材，通过合成管线验证，不借用已撤下的模板包。 */
export async function probeStudioPlayer(params: ParamValues) {
  const template = studioMaterialRefs.player;
  const fps = 30;
  const request: CompositionLoadRequest = {
    output: { width: 256, height: 144, fps },
    sources: [{ template, resourceStamp: 'native-player-test' }],
    composition: { formatVersion: 1, fps, durationFrames: 90, tracks: [
      { id: 'player', name: 'player', locked: false, muted: false, clips: [
        { id: 'actor', template, params, startFrame: 0, sourceInFrame: 0, durationFrames: 90 },
      ] },
    ] },
  };
  const host = await EngineHost.create({ mode: 'export', strictDeterminism: true, resolveResource: fakeResolveResource });
  try {
    const loaded = await host.loadComposition(request, [fakeResolveResource]);
    const quality = { subframes: 1, shutterAngle: 0 };
    const frames: Uint8Array[] = [];
    for (const index of [0, 15, 30, 45, 60, 75, 89]) frames.push(await host.renderFrame(index, quality));
    const distinct = new Set(frames.map((frame) => Array.from(frame).join(','))).size;
    const maxAlpha = Math.max(...frames.map((frame) => {
      let max = 0;
      for (let index = 3; index < frame.length; index += 4) max = Math.max(max, frame[index]!);
      return max;
    }));
    const deterministic = await host.checkDeterminism(30, [75, 15, 60, 0, 89], quality);
    return { warnings: loaded.warnings, distinct, maxAlpha, deterministic };
  } finally {
    host.dispose();
  }
}
