// 官网多语言：官网自己的文案（site.*）+ 品牌文案（brand.*）+ 桌面版现成的导出预设与分类名（export.* / gallery.*）。
import { brandMessages } from '@allay/ui/brand';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import desktopEn from '../../../desktop/src/renderer/i18n/locales/en.json';
import desktopZh from '../../../desktop/src/renderer/i18n/locales/zh-CN.json';
import type { SiteLanguage } from '../host/bridge';
import en from './locales/en.json';
import zhCN from './locales/zh-CN.json';

export const resources = {
  'zh-CN': { translation: { site: zhCN, brand: brandMessages['zh-CN'], export: desktopZh.export, gallery: desktopZh.gallery } },
  en: { translation: { site: en, brand: brandMessages.en, export: desktopEn.export, gallery: desktopEn.gallery } },
} as const;

export const missingKeys = new Set<string>();

export async function initSiteI18n(language: SiteLanguage): Promise<typeof i18next> {
  await i18next.use(initReactI18next).init({
    resources,
    lng: language,
    fallbackLng: false,
    interpolation: { escapeValue: false },
    returnNull: false,
    saveMissing: true,
    missingKeyHandler: (_lngs, _ns, key) => {
      missingKeys.add(key);
      console.warn(`[i18n] missing key: ${key}`);
    },
  });
  return i18next;
}

/** 给浏览器宿主（browser-host.ts）提供的双语资源层与导出说明 */
export function hostMessages() {
  return {
    demoPackName: { 'zh-CN': zhCN.host.demoPackName, en: en.host.demoPackName },
    demoPackDescription: { 'zh-CN': zhCN.host.demoPackDescription, en: en.host.demoPackDescription },
    mcPackName: { 'zh-CN': zhCN.host.mcPackName, en: en.host.mcPackName },
    mcPackDescription: { 'zh-CN': zhCN.host.mcPackDescription, en: en.host.mcPackDescription },
    exportTarget: { 'zh-CN': zhCN.host.exportTarget, en: en.host.exportTarget },
  };
}
