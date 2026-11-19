import type { CSSProperties } from 'react';

let nativeMacChrome = false;

export function setTitlebarPlatform(platform: string): void {
  nativeMacChrome = platform === 'darwin';
}

export function hasNativeMacChrome(): boolean {
  return nativeMacChrome;
}

const overlayInsets: CSSProperties = {
  paddingLeft: 'calc(env(titlebar-area-x, 0px) + 8px)',
  paddingRight: 'calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw) + 6px)',
};

export function titlebarInsets(onboarding = false): CSSProperties | undefined {
  return !onboarding || nativeMacChrome ? overlayInsets : undefined;
}
