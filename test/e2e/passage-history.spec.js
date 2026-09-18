import { test, expect, _electron as electron } from '@playwright/test';
import path from 'node:path';

test('selecting a passage reveals exactly the revisions that changed it', async () => {
  const application = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  });
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.getCommitController()));

    const positions = await window.evaluate(async () => {
      const { model, editors, getCommitController } = window.__noirDraftTest;
      const base = '# Chapter\n\nMaria walked in.\n\nElias watched.\n';
      editors.STORY.replace(0, model.text.length, base);
      await getCommitController().explicitSave('Base state');

      editors.STORY.replace(0, model.text.length, base.replace('Elias watched.', 'Elias watched silently.'));
      await getCommitController().explicitSave('Expanded Elias.');

      editors.STORY.replace(0, model.text.length, model.text.replace('Maria walked in.', 'Maria walked in slowly.'));
      await getCommitController().explicitSave('Slowed Maria entrance.');

      const from = model.text.indexOf('Maria walked in');
      return { from, to: from + 'Maria walked in'.length };
    });

    await window.evaluate(({ from, to }) => {
      const { editors } = window.__noirDraftTest;
      editors.STORY.setSelection(from, to);
    }, positions);

    const passageHistoryButton = window.getByRole('button', { name: 'Passage history…' });
    await expect(passageHistoryButton).toBeVisible();
    await passageHistoryButton.click();

    const list = window.locator('[data-passage-history-list]');
    // Two revisions genuinely touched this exact text: the one that slowed Maria's
    // entrance, and the one that first introduced this passage from the app's
    // unrelated default document (an honest "similarity hint" boundary hop).
    // The Elias-only revision in between never touched this passage and must be absent.
    await expect(list.locator('.passage-history-entry')).toHaveCount(2);
    await expect(list).toContainText('Slowed Maria entrance.');
    await expect(list).toContainText('Base state');
    await expect(list).not.toContainText('Expanded Elias.');

    // Comparing an older entry against the current text renders a word-level diff.
    const baseEntry = list.locator('.passage-history-entry', { hasText: 'Base state' });
    await baseEntry.getByRole('button', { name: 'Compare', exact: true }).click();
    const diff = baseEntry.locator('.passage-diff');
    await expect(diff).toBeVisible();
    await expect(diff.locator('.diff-equal, .diff-delete, .diff-insert').first()).toBeVisible();

    const targetEntry = list.locator('.passage-history-entry', { hasText: 'Slowed Maria entrance.' });
    await targetEntry.getByRole('button', { name: 'Checkout' }).click();
    const currentText = await window.evaluate(() => window.__noirDraftTest.model.text);
    expect(currentText).toContain('Maria walked in slowly.');
  } finally {
    await application.close();
  }
});
