import { expect, test } from '@playwright/test';
import { CONTENT_SECURITY_POLICY } from '../../apps/desktop/src/main/security-policy';
import type { CodeInspectorChildApi } from '../../apps/desktop/src/shared/code-inspector';
import { launchApp, makeUserDataDir, removeUserDataDir, type Launched } from './helpers';

test('T-ARC-6 原生代码副窗口只暴露窄接口，离屏模式重开不抢焦点', async () => {
  const dir = makeUserDataDir();
  let launched: Launched | undefined;
  try {
    launched = await launchApp(dir);
    const { app, page } = launched;
    const open = () => page.evaluate(() => window.allay.codeInspector!.open());
    const first = app.waitForEvent('window');
    await open();
    const inspector = await first;
    expect(inspector.url()).toBe('app://renderer/code-inspector.html');
    expect(await inspector.evaluate(async () => ({
      api: Object.keys(window.allayCodeInspector satisfies CodeInspectorChildApi).sort(),
      parentApi: typeof window.allay,
      csp: (await fetch(location.href)).headers.get('content-security-policy'),
    }))).toEqual({ api: ['action', 'onPacket', 'ready', 'setDirty'], parentApi: 'undefined', csp: CONTENT_SECURITY_POLICY });
    expect(await page.evaluate(() => typeof window.allayCodeInspector)).toBe('undefined');
    const nativeWindow = await app.browserWindow(inspector);
    await open();
    expect(app.windows()).toHaveLength(2);
    expect(await nativeWindow.evaluate((win) => [win.isVisible(), win.isFocused(), win.isModal()])).toEqual([false, false, false]);

    const closed = inspector.waitForEvent('close');
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().endsWith('/code-inspector.html'))?.close();
    });
    await closed;
    const next = app.waitForEvent('window');
    await open();
    const reopened = await next;
    expect(reopened.url()).toBe(inspector.url());
    expect(reopened).not.toBe(inspector);
    expect(app.windows()).toHaveLength(2);
    await app.close();
    launched = undefined;
    expect(reopened.isClosed()).toBe(true);
  } finally {
    await launched?.app.close();
    removeUserDataDir(dir);
  }
});
