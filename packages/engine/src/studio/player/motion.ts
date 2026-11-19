export type Action = 'idle' | 'walk' | 'sprint' | 'jump';
export type Edition = 'java' | 'bedrock';

const REFERENCE = {
  java: { walkHz: 1.55, sprintHz: 2.25, walkSwing: 0.61, sprintSwing: 1.04, lean: 0.18, jumpTime: 0.68, jumpHeight: 6.1, bob: 0.85 },
  bedrock: { walkHz: 1.65, sprintHz: 2.45, walkSwing: 0.50, sprintSwing: 0.88, lean: 0.12, jumpTime: 0.72, jumpHeight: 5.5, bob: 0.57 },
} as const;

export function sampleMotion(t: number, action: Action, edition: Edition, bobStrength: number) {
  const preset = REFERENCE[edition];
  const stride = action === 'walk' || action === 'sprint';
  const sprint = action === 'sprint';
  const phase = t * Math.PI * 2 * (sprint ? preset.sprintHz : preset.walkHz);
  const wave = stride ? Math.sin(phase) : 0;
  const step = stride ? (1 - Math.cos(2 * phase)) / 2 : 0;
  const jump = action === 'jump' ? Math.max(0, Math.min(1, (t - 0.14) / preset.jumpTime)) : 0;
  const arc = 4 * jump * (1 - jump);
  const leg = wave * (sprint ? preset.sprintSwing : preset.walkSwing);
  const sway = Math.sin(t * Math.PI * 1.4);
  const bob = preset.bob * bobStrength * (sprint ? 1.5 : 1);
  return {
    lift: arc * preset.jumpHeight + step * (sprint ? 0.9 : 0.36),
    lean: sprint ? preset.lean : action === 'walk' ? 0.04 : arc * 0.12,
    headYaw: action === 'idle' ? sway * 0.095 : wave * 0.018,
    rightLeg: leg - 0.47 * arc,
    leftLeg: -leg + 0.25 * arc,
    rightArm: -leg * 0.88 - 0.38 * arc + sway * 0.026,
    leftArm: leg * 0.88 - 0.56 * arc - sway * 0.026,
    bobX: wave * bob * 0.48,
    bobY: -step * bob * 0.76,
    roll: wave * bob * 0.025,
  };
}
