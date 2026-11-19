import type { ResourceProfileInfo } from '../../../shared/resources';

const labels = {
  en: { manage: 'Manage assets…', current: 'Asset version', download: 'Download assets…', latest: 'Download latest release' },
  zh: { manage: '管理素材…', current: '素材版本', download: '下载素材…', latest: '下载最新正式版' },
};

export function resourceLabels(language: string) {
  return labels[language.startsWith('zh') ? 'zh' : 'en'];
}

export function profileName(profile: ResourceProfileInfo): string {
  return profile.name === profile.versionId ? profile.name : `${profile.name} · ${profile.versionId}`;
}
