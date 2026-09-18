import { test, expect, _electron as electron } from '@playwright/test';
import path from 'node:path';

test('CHAT has an independent formatted-source pane and heading navigation', async () => {
  const application = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  });
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.editors?.CHAT));
    await window.getByRole('button', { name: 'Chat', exact: true }).click();
    const chat = window.getByRole('textbox', { name: 'Chat source' });
    await expect(chat).toBeVisible();
    const source = '# Chapter 3 / Maria\n\n## User\n\nQuestion?\n\n## Agent\n\nAnswer.\n';
    await window.evaluate((text) => {
      const { editors, models } = window.__noirDraftTest;
      editors.CHAT.replace(0, models.CHAT.text.length, text);
    }, source);
    await expect(chat).toHaveText(source);
    const outline = window.getByLabel('Document outline');
    await expect(outline.getByRole('button', { name: 'Chapter 3 / Maria' })).toBeVisible();
    await expect(outline.getByRole('button', { name: 'User', exact: true })).toBeVisible();
    await expect(outline.getByRole('button', { name: 'Agent', exact: true })).toBeVisible();
    await outline.getByRole('button', { name: 'Agent', exact: true }).click();
    expect(await window.evaluate(() => window.__noirDraftTest.models.CHAT.selectionStart)).toBe(source.indexOf('## Agent'));
    await expect(outline.locator('.pin-toggle')).toHaveCount(0);
  } finally {
    await application.close();
  }
});
