import { test, expect, _electron as electron } from '@playwright/test';
import path from 'node:path';

test('launches the secure Electron shell', async () => {
  const application = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  });

  try {
    const window = await application.firstWindow();
    await expect(window).toHaveTitle('NoirDraft');
    await expect(window.getByRole('heading', { name: 'Untitled story' })).toBeVisible();
    await expect(window.getByLabel('Project views')).toBeVisible();
    await expect(window.getByLabel('Runtime version')).toContainText('Electron');

    const security = await window.evaluate(() => ({
      hasRequire: typeof window.require !== 'undefined',
      hasRuntimeBridge: Boolean(window.noirDraft?.runtime?.electron),
    }));
    expect(security).toEqual({ hasRequire: false, hasRuntimeBridge: true });

    const editContext = await window.evaluate(() => ({
      available: typeof EditContext === 'function',
      attached: Boolean(document.querySelector('#story-editor').editContext),
      chrome: window.noirDraft.runtime.chromium,
    }));
    expect(editContext.available).toBe(true);
    expect(editContext.attached).toBe(true);
    expect(editContext.chrome).toBeTruthy();
  } finally {
    await application.close();
  }
});
