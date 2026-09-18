import { test, expect, _electron as electron } from '@playwright/test';
import path from 'node:path';

test('launches the secure, menu-free compact shell', async () => {
  const application = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  });

  try {
    const window = await application.firstWindow();
    await expect(window).toHaveTitle('NoirDraft');
    await expect(window.getByRole('heading', { name: 'Untitled story' })).toBeVisible();
    await expect(window.getByLabel('Project views')).toBeVisible();

    const menu = await application.evaluate(({ Menu }) => Menu.getApplicationMenu());
    expect(menu).toBeNull();

    const security = await window.evaluate(() => ({
      hasRequire: typeof window.require !== 'undefined',
      hasRuntimeBridge: Boolean(window.noirDraft?.runtime?.electron),
    }));
    expect(security).toEqual({ hasRequire: false, hasRuntimeBridge: true });

    const editContext = await window.evaluate(() => ({
      available: typeof EditContext === 'function',
      attached: Boolean(document.querySelector('#story-editor').editContext),
    }));
    expect(editContext.available).toBe(true);
    expect(editContext.attached).toBe(true);

    // Developer diagnostics are hidden by default and revealed through the overflow menu.
    const runtimeLabel = window.getByLabel('Runtime version');
    await expect(runtimeLabel).toBeHidden();
    await window.getByLabel('More actions').click();
    await window.getByRole('button', { name: 'Developer info' }).click();
    await expect(runtimeLabel).toBeVisible();
    await expect(runtimeLabel).toContainText('Electron');

    // Both sidebars are collapsible, and the writing area still works once collapsed.
    const sidebarLeft = window.getByLabel('Project views');
    const sidebarRight = window.getByRole('complementary', { name: 'Chat' });
    await expect(sidebarLeft).toBeVisible();
    await expect(sidebarRight).toBeVisible();
    await window.getByLabel('Toggle navigation sidebar').click();
    await expect(sidebarLeft).toBeHidden();
    await window.getByLabel('Toggle chat sidebar').click();
    await expect(sidebarRight).toBeHidden();
    await window.getByLabel('Toggle navigation sidebar').click();
    await window.getByLabel('Toggle chat sidebar').click();
    await expect(sidebarLeft).toBeVisible();
    await expect(sidebarRight).toBeVisible();
  } finally {
    await application.close();
  }
});
