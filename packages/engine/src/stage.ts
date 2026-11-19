// 舞台坐标（docs/02-engine.md 2.5）：画面短边恒为 1080 设计单位，原点在中心，+y 向上，相机看向 −z。
import { MathUtils, OrthographicCamera, PerspectiveCamera } from 'three';
import type { StageInfo } from '@allay/template-sdk';

export const STAGE_SHORT_SIDE = 1080;

export function computeStage(output: { width: number; height: number; fps: number }, referenceSize?: StageInfo['referenceSize']): StageInfo {
  const short = Math.min(output.width, output.height);
  const k = STAGE_SHORT_SIDE / short;
  return {
    width: output.width * k,
    height: output.height * k,
    aspect: output.width / output.height,
    fps: output.fps,
    pixelScale: short / STAGE_SHORT_SIDE,
    ...(referenceSize && { referenceSize: Object.freeze({ width: referenceSize.width, height: referenceSize.height }) }),
  };
}

/** 相机离 z = 0 平面的距离，正交相机用同一个值，留出足够的前后景深 */
function depthRange(stage: StageInfo): { distance: number; near: number; far: number } {
  const span = Math.max(stage.width, stage.height);
  return { distance: span * 4, near: span * 0.01, far: span * 16 };
}

/** 默认相机：正交相机，刚好覆盖整个舞台 */
export function createDefaultCamera(stage: StageInfo): OrthographicCamera {
  const { distance, near, far } = depthRange(stage);
  const cam = new OrthographicCamera(-stage.width / 2, stage.width / 2, stage.height / 2, -stage.height / 2, near, far);
  cam.position.set(0, 0, distance);
  cam.lookAt(0, 0, 0);
  cam.updateProjectionMatrix();
  return cam;
}

/** 透视相机，位置已经算好，使 z = 0 平面恰好填满舞台（fov 是垂直视角，度） */
export function createStageCamera(stage: StageInfo, fov: number): PerspectiveCamera {
  const f = Math.min(170, Math.max(1, Number.isFinite(fov) ? fov : 30));
  const distance = stage.height / 2 / Math.tan(MathUtils.degToRad(f) / 2);
  const span = Math.max(stage.width, stage.height);
  const cam = new PerspectiveCamera(f, stage.aspect, Math.max(1, distance * 0.02), distance + span * 8);
  cam.position.set(0, 0, distance);
  cam.lookAt(0, 0, 0);
  cam.updateProjectionMatrix();
  return cam;
}
