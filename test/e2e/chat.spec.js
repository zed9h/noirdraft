import { test, expect, _electron as electron } from '@playwright/test';
import path from 'node:path';

test('CHAT has an independent formatted-source pane in the collapsible sidebar with heading navigation', async () => {
  const application = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  });
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.editors?.CHAT));

    const chat = window.getByRole('textbox', { name: 'Chat source' });
    await expect(chat).toBeVisible();
    const source = '# Chapter 3 / Maria\n\n## User\n\nQuestion?\n\n## Agent\n\nAnswer.\n';
    await window.evaluate((text) => {
      const { editors, models } = window.__noirDraftTest;
      editors.CHAT.replace(0, models.CHAT.text.length, text);
    }, source);
    await expect(chat).toHaveText(source);

    const chatOutline = window.getByLabel('Chat outline');
    await expect(chatOutline.getByRole('button', { name: 'Chapter 3 / Maria' })).toBeVisible();
    await expect(chatOutline.getByRole('button', { name: 'User', exact: true })).toBeVisible();
    await expect(chatOutline.getByRole('button', { name: 'Agent', exact: true })).toBeVisible();
    await chatOutline.getByRole('button', { name: 'Agent', exact: true }).click();
    expect(await window.evaluate(() => window.__noirDraftTest.models.CHAT.selectionStart)).toBe(source.indexOf('## Agent'));
    await expect(chatOutline.locator('.pin-toggle')).toHaveCount(0);

    // Chat stays visible alongside STORY, and the sidebar can be collapsed independently.
    await expect(window.getByRole('textbox', { name: 'Story source' })).toBeVisible();
    await window.getByLabel('Toggle chat sidebar').click();
    await expect(chat).toBeHidden();
  } finally {
    await application.close();
  }
});
