import type { ParamValues, SetupContext } from '@allay/template-sdk';

export type JavaToastProfile = 'javaAchievement' | 'javaAdvancement' | 'javaAdvancement263';

const ACHIEVEMENT = { enter: 375, hold: 2250, exit: 375 };
const ADVANCEMENT = { enter: 600, hold: 5000, exit: 600 };
const ORIGINAL_EDITOR = { enter: 250, hold: 2500, exit: 250 };

export const unit = (value: number): number => Math.max(0, Math.min(1, value));
export const millis = (seconds: number): number => Math.floor(seconds * 1000 + 1e-9);

export function javaToastTiming(profile: JavaToastProfile, params: Readonly<ParamValues>) {
  const vanilla = profile === 'javaAchievement' ? ACHIEVEMENT : ADVANCEMENT;
  const fromSeconds = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value * 1000 : fallback;
  const editor = {
    enter: fromSeconds(params.inDuration, ORIGINAL_EDITOR.enter),
    hold: fromSeconds(params.hold, ORIGINAL_EDITOR.hold),
    exit: fromSeconds(params.outDuration, ORIGINAL_EDITOR.exit),
  };
  const edited = editor.enter !== ORIGINAL_EDITOR.enter || editor.hold !== ORIGINAL_EDITOR.hold || editor.exit !== ORIGINAL_EDITOR.exit;
  const editable = params.javaTiming === 'custom' || (params.javaTiming !== 'vanilla' && edited);
  const spans = editable ? editor : vanilla;
  const outAt = spans.enter + spans.hold;
  return {
    duration: (outAt + spans.exit) / 1000,
    phases: { editable, durations: { inDuration: spans.enter / 1000, hold: spans.hold / 1000, outDuration: spans.exit / 1000 } },
    outAt: outAt / 1000,
    challengeAt: profile === 'javaAdvancement263' ? 0 : (spans.enter + 1) / 1000,
    sample(seconds: number) {
      const time = millis(seconds);
      const entering = unit(time / spans.enter);
      const exiting = unit((time - outAt) / spans.exit);
      return {
        holdAge: Math.floor(Math.max(0, (time - spans.enter) * vanilla.hold / spans.hold)),
        horizontalShown: time < outAt ? entering ** 2 : 1 - exiting ** 2,
        legacyHidden: (1 - entering + exiting) ** 4,
      };
    },
  };
}

export function javaTextAlpha(profile: JavaToastProfile, age: number): { header: number; title: number } {
  const fadingHeader = age < 1500;
  const alpha = Math.floor(fadingHeader ? 255 * unit((1500 - age) / 300) : 252 * unit((age - 1500) / 300));
  const drawAlpha = profile === 'javaAdvancement' ? alpha | 0x04 : alpha;
  const shown = drawAlpha < 26 ? 0 : drawAlpha / 255;
  return { header: fadingHeader ? shown : 0, title: fadingHeader ? 0 : shown };
}

export function cueJavaToast(ctx: Pick<SetupContext, 'params' | 'audio'>, profile: JavaToastProfile, challenge: boolean, timing: ReturnType<typeof javaToastTiming>): void {
  const { params } = ctx;
  const gain = typeof params.volume === 'number' ? params.volume : 0.8;
  const selected = params.sound;
  const vanillaIn = 'minecraft:ui.toast.in';
  const custom = selected === null || (typeof selected === 'string' && selected !== vanillaIn);
  if (params.javaSound === 'custom' || (params.javaSound !== 'vanilla' && custom)) {
    if (typeof selected === 'string') ctx.audio.cue(selected, 0, { gain });
  } else if (profile !== 'javaAchievement') {
    if (challenge && profile === 'javaAdvancement263') ctx.audio.cue('minecraft:ui.toast.challenge_complete', timing.challengeAt, { gain });
    ctx.audio.cue(vanillaIn, 0, { gain });
    if (challenge && profile === 'javaAdvancement') ctx.audio.cue('minecraft:ui.toast.challenge_complete', timing.challengeAt, { gain });
    ctx.audio.cue('minecraft:ui.toast.out', timing.outAt, { gain });
  }
}
