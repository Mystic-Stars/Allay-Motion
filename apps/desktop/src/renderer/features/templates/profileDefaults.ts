import { sanitizeParams, type ParamValues } from '@allay/template-sdk';
import type { ResourceState } from '../../../shared/resources';
import type { TemplateSource } from '../../templates/catalog';

type Source = Pick<TemplateSource, 'ref' | 'params'>;
type ResourceEdition = { edition: 'java' | 'bedrock'; version: string; release: boolean };

const LOADING = 'allay.builtin.loading-screen';
const TOAST = 'allay.builtin.advancement-toast';
const JAVA_ADVANCEMENT_TIMING = { inDuration: 0.6, hold: 5, outDuration: 0.6 };

export function hasProfileDefaults(id: string): boolean {
  return id === LOADING || id === TOAST;
}

export function boundResourceEdition(state: ResourceState | null, projectProfile?: string, clipProfile?: string): ResourceEdition | null {
  if (!state) return null;
  const boundProfile = clipProfile ?? projectProfile;
  if (boundProfile !== undefined || state.library) {
    const id = boundProfile ?? state.library?.activeProfileId;
    const profile = state.library?.profiles.find((entry) => entry.id === id && !entry.missing);
    if (!profile) return null;
    return {
      edition: profile.source === 'bedrock' ? 'bedrock' : 'java',
      version: profile.versionId,
      release: profile.versionType === undefined || profile.versionType === 'release',
    };
  }
  const { enabled, active, local, cached } = state.vanilla;
  if (!enabled || !active) return null;
  const version = (active === 'local' ? local : cached)?.versionId;
  return version ? { edition: 'java', version, release: true } : null;
}

function scene(id: string, resource: ResourceEdition | null): string | undefined {
  const loading = id === LOADING;
  if (!resource) return loading ? 'javaWorldPanorama' : 'javaAdvancement';
  const { edition, version, release } = resource;
  if (!release) return undefined;
  if (edition === 'bedrock') {
    return version === '1.21.0' ? (loading ? 'bedrockWorld' : 'bedrockAchievement') : undefined;
  }
  if (version === '26.3' || version === '26.3.0') return loading ? 'javaWorld263' : 'javaAdvancement263';
  const match = /^1\.(\d+)(?:\.(\d+))?$/.exec(version);
  if (!match) return undefined;
  const minor = Number(match[1]);
  const patch = Number(match[2] ?? 0);
  if (minor === 21 && patch > 11) return undefined;
  if (!loading) return minor >= 12 && minor <= 21 ? 'javaAdvancement' : undefined;
  if (minor === 21) return patch >= 9 ? 'javaWorldBar' : 'javaWorldPanorama';
  if (minor === 20 && patch >= 5 && patch <= 6) return 'javaWorldPanorama';
  if (minor === 14 && patch === 0) return 'javaWorldDirt114';
  if ((minor === 14 && patch <= 4) || (minor >= 15 && minor < 20) || (minor === 20 && patch <= 4)) return 'javaWorldDirt';
  return undefined;
}

/** 只供显式新建使用；不改变 manifest 默认值或文件恢复的基线。 */
export function creationParams(source: Source, locale: string, resource: ResourceEdition | null, overrides: Readonly<Record<string, unknown>> = {}): ParamValues {
  const recipe: Record<string, unknown> = {};
  if (hasProfileDefaults(source.ref.id)) {
    const key = source.ref.id === LOADING ? 'loadingStyle' : 'toastStyle';
    const style = scene(source.ref.id, resource);
    const def = source.params.find((param) => param.key === key);
    if (def?.type === 'enum') {
      if (style && def.options.some((option) => option.value === style)) recipe[key] = style;
      const effectiveStyle = Object.hasOwn(overrides, key) ? overrides[key] : recipe[key];
      if ((effectiveStyle === 'javaAdvancement' || effectiveStyle === 'javaAdvancement263') && def.options.some((option) => option.value === effectiveStyle)) {
        Object.assign(recipe, JAVA_ADVANCEMENT_TIMING);
        const timing = source.params.find((param) => param.key === 'javaTiming');
        if (timing?.type === 'enum' && timing.options.some((option) => option.value === 'custom')) recipe.javaTiming = 'custom';
        const matchesScale = resource?.edition === 'java' && resource.release && style === effectiveStyle
          && ['1.21.1', '26.3', '26.3.0'].includes(resource.version);
        const scale = source.params.find((param) => param.key === 'guiScaleMode');
        if (matchesScale && !Object.hasOwn(overrides, 'guiScale') && scale?.type === 'enum'
          && scale.options.some((option) => option.value === 'vanillaAuto')) recipe.guiScaleMode = 'vanillaAuto';
      }
    }
  }
  return sanitizeParams(source.params, { ...recipe, ...overrides }, { locale });
}
