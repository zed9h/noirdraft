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

    // Runtime diagnostics live in an on-demand info dialog, never in the editor chrome.
    await window.getByLabel('More actions').click();
    await window.getByRole('button', { name: 'Info…' }).click();
    const info = window.getByRole('dialog', { name: 'NoirDraft' });
    await expect(info).toBeVisible();
    await expect(info.getByText(/words · .* characters ·/)).toHaveCount(3);
    await expect(info.getByText('STORY 1 · 0; METADATA 1 · 0', { exact: false })).toBeVisible();
    await expect(info.getByText(/current Markdown/)).toBeVisible();
    await expect(info.getByText('Electron', { exact: false })).toBeVisible();
    await expect(info.getByText('0.1.0', { exact: false })).toBeVisible();
    await info.getByLabel('Close app info').click();
    await expect(info).toBeHidden();

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

test('navigation, chat, and Versions panes resize from their editor borders', async () => {
  const application = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  });
  try {
    const window = await application.firstWindow();
    const drag = async (resizer, delta) => {
      const box = await resizer.boundingBox();
      await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await window.mouse.down();
      await window.mouse.move(box.x + box.width / 2 + delta.x, box.y + box.height / 2 + delta.y);
      await window.mouse.up();
    };

    const navigation = window.getByLabel('Project views');
    const chat = window.getByRole('complementary', { name: 'Chat' });
    const navigationWidth = (await navigation.boundingBox()).width;
    await drag(window.getByLabel('Resize navigation pane'), { x: 80, y: 0 });
    expect((await navigation.boundingBox()).width).toBeGreaterThan(navigationWidth + 60);

    const chatWidth = (await chat.boundingBox()).width;
    await drag(window.getByLabel('Resize chat pane'), { x: -80, y: 0 });
    expect((await chat.boundingBox()).width).toBeGreaterThan(chatWidth + 60);

    await window.getByRole('button', { name: 'Versions', exact: true }).click();
    const versions = window.getByLabel('Versions graph');
    const versionsHeight = (await versions.boundingBox()).height;
    await drag(window.getByLabel('Resize versions pane'), { x: 0, y: -80 });
    expect((await versions.boundingBox()).height).toBeGreaterThan(versionsHeight + 60);
  } finally {
    await application.close();
  }
});
