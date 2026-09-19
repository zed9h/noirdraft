import { test, expect, _electron as electron } from '@playwright/test';
import path from 'node:path';

test('CHAT projects KoboldCpp turns as a history with a visible context range', async () => {
  const application = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  });
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.editors?.CHAT));

    const source = '{{[INPUT]}}\n# Question?\n{{[OUTPUT]}}\n**Answer.**\n\n{{[INPUT]}}\nAgain?\n{{[OUTPUT]}}\nYes.\n';
    await window.evaluate((text) => {
      const { editors, models } = window.__noirDraftTest;
      editors.CHAT.replace(0, models.CHAT.text.length, text);
    }, source);
    const history = window.getByLabel('Chat history');
    await expect(history.getByText('Question?')).toBeVisible();
    await expect(history.getByText('Answer.')).toBeVisible();
    await expect(history.getByText('user', { exact: true })).toHaveCount(2);
    await expect(history.getByText('agent', { exact: true })).toHaveCount(2);
    await expect(history.locator('.chat-input .block-heading')).toHaveCount(1);
    await expect(history.locator('.chat-output .token-strong')).toHaveCount(1);
    await expect(history.getByRole('button', { name: 'Use context from turn 1' })).toHaveCount(1);
    await window.getByRole('button', { name: 'Use context from turn 1' }).click();
    await expect(history.getByRole('button', { name: 'Unpin context start' })).toHaveCount(1);
    await expect(window.getByLabel('Chat prompt')).toBeVisible();

    // Chat stays visible alongside STORY, and the sidebar can be collapsed independently.
    await expect(window.getByRole('textbox', { name: 'Story source' })).toBeVisible();
    await window.getByLabel('Toggle chat sidebar').click();
    await expect(history).toBeHidden();
  } finally {
    await application.close();
  }
});
