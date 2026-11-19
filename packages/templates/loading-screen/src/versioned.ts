import type { ParamValue, SetupContext, TemplateInstance } from '@allay/template-sdk';
import { setupJavaLoading, type JavaLoadingProfile } from './java-loading';

const JAVA = {
  javaStartupWhite: { scene: 'startup', background: 'white', layout: 'splash' },
  javaStartupRed: { scene: 'startup', background: 'red', layout: 'splash' },
  javaReloadWhite: { scene: 'reload', background: 'white', layout: 'reload' },
  javaReloadRed: { scene: 'reload', background: 'red', layout: 'reload' },
  javaWorldDirt114: { scene: 'world', background: 'dirt', layout: 'percent', grid: 45, targetGrid: 23, gap: 1 },
  javaWorldDirt: { scene: 'world', background: 'dirt', layout: 'percent', grid: 43, targetGrid: 21 },
  javaWorldPanorama: { scene: 'world', background: 'javaPanorama', layout: 'percent', grid: 29, targetGrid: 7 },
  javaWorldBar: { scene: 'world', background: 'javaPanorama', layout: 'chunkBar', grid: 35 },
  javaWorld263: { scene: 'world', background: 'javaPanorama', layout: 'chunkBar', grid: 35, modern: true },
  javaTravelDirt: { scene: 'dimension', background: 'dirt', layout: 'terrain' },
  javaTravelNether: { scene: 'dimension', background: 'netherPortal', layout: 'terrain' },
  javaTravelEnd: { scene: 'dimension', background: 'endPortal', layout: 'terrain' },
  javaTravelOverworld: { scene: 'dimension', background: 'javaPanorama', layout: 'terrain' },
  javaTravelNether263: { scene: 'dimension', background: 'netherPortal', layout: 'terrain', modern: true },
  javaTravelEnd263: { scene: 'dimension', background: 'endPortal', layout: 'terrain', modern: true },
  javaTravelOverworld263: { scene: 'dimension', background: 'javaPanorama', layout: 'terrain', modern: true },
} as const satisfies Record<string, JavaLoadingProfile>;

const BEDROCK_PROFILE_METADATA = {
  bedrockStartup: { scene: 'startup', background: 'gray', layout: 'bedrockSplash' },
  bedrockPacks: { scene: 'reload', background: 'bedrockPanorama', layout: 'bedrockPanel' },
  bedrockWorld: { scene: 'world', background: 'bedrockPanorama', layout: 'bedrockPanel' },
  bedrockTravelNether: { scene: 'dimension', background: 'netherrack', layout: 'bedrockPanel' },
  bedrockTravelEnd: { scene: 'dimension', background: 'endStone', layout: 'bedrockPanel' },
  bedrockTravelOverworld: { scene: 'dimension', background: 'dirt', layout: 'bedrockPanel' },
} as const;

export function loadingProfile(value: ParamValue | undefined) {
  if (typeof value !== 'string') return undefined;
  if (Object.hasOwn(JAVA, value)) return JAVA[value as keyof typeof JAVA];
  if (Object.hasOwn(BEDROCK_PROFILE_METADATA, value)) return BEDROCK_PROFILE_METADATA[value as keyof typeof BEDROCK_PROFILE_METADATA];
  return undefined;
}

const SCHEDULES = {
  resource: [[0, 0], [0.14, 0.08], [0.31, 0.57], [0.58, 0.57], [0.79, 0.91], [0.94, 1]],
  chunks: [[0, 0], [0.18, 0.07], [0.31, 0.26], [0.43, 0.26], [0.72, 0.82], [0.96, 1]],
  bedrock: [[0, 0], [0.20, 0.29], [0.43, 0.29], [0.67, 0.76], [0.8, 0.76], [0.98, 1]],
} as const;

export function loadingProgress(mode: keyof typeof SCHEDULES, time: number): number {
  const schedule = SCHEDULES[mode];
  const progress = Math.min(1, Math.max(0, time));
  for (let index = 1; index < schedule.length; index++) {
    const [end, next] = schedule[index]!;
    if (progress <= end) {
      const [start, previous] = schedule[index - 1]!;
      return previous + (next - previous) * ((progress - start) / (end - start));
    }
  }
  return 1;
}

export function setupVersionedLoading(ctx: SetupContext, profile: NonNullable<ReturnType<typeof loadingProfile>>): Promise<TemplateInstance> {
  if (profile.layout === 'bedrockSplash' || profile.layout === 'bedrockPanel') throw new Error('Bedrock loading requires its own setup');
  return setupJavaLoading(ctx, profile, loadingProgress);
}
