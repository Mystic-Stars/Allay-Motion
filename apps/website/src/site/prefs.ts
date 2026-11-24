// 访客的主题、语言偏好。默认跟随系统，手动选过的记在 localStorage（只是这个浏览器里的便利，读写失败就当没有）。
import { useSyncExternalStore } from 'react';
import type { SiteLanguage, SiteTheme } from '../host/bridge';

export type ThemePref = 'system' | SiteTheme;

const THEME_KEY = 'allay-site-theme';
const LANG_KEY = 'allay-site-language';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // 隐私模式等：不记就是了
  }
}

const lightQuery = () => window.matchMedia('(prefers-color-scheme: light)');
const reducedQuery = () => window.matchMedia('(prefers-reduced-motion: reduce)');

export interface Prefs {
  themePref: ThemePref;
  theme: SiteTheme;
  language: SiteLanguage;
  reducedMotion: boolean;
}

function systemLanguage(): SiteLanguage {
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

function compute(): Prefs {
  const t = read(THEME_KEY);
  const themePref: ThemePref = t === 'dark' || t === 'light' ? t : 'system';
  const l = read(LANG_KEY);
  const language: SiteLanguage = l === 'zh-CN' || l === 'en' ? l : systemLanguage();
  return {
    themePref,
    theme: themePref === 'system' ? (lightQuery().matches ? 'light' : 'dark') : themePref,
    language,
    reducedMotion: reducedQuery().matches,
  };
}

let state: Prefs = compute();
const listeners = new Set<() => void>();

function apply(): void {
  const root = document.documentElement;
  root.dataset.theme = state.theme;
  root.dataset.reducedMotion = String(state.reducedMotion);
  root.lang = state.language;
}

function refresh(): void {
  const next = compute();
  if (next.theme === state.theme && next.language === state.language && next.reducedMotion === state.reducedMotion && next.themePref === state.themePref) return;
  state = next;
  apply();
  for (const l of listeners) l();
}

export function initPrefs(): Prefs {
  apply();
  lightQuery().addEventListener('change', refresh);
  reducedQuery().addEventListener('change', refresh);
  return state;
}

export function getPrefs(): Prefs {
  return state;
}

export function setThemePref(pref: ThemePref): void {
  write(THEME_KEY, pref === 'system' ? null : pref);
  refresh();
}

/** 手动选一个主题（与系统相同时也记下，免得系统一变又跟着跑） */
export function setTheme(theme: SiteTheme): void {
  write(THEME_KEY, theme);
  refresh();
}

export function setLanguage(language: SiteLanguage): void {
  write(LANG_KEY, language);
  refresh();
}

export function subscribePrefs(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribePrefs, getPrefs, getPrefs);
}
