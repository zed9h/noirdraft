import { test, expect, _electron as electron } from '@playwright/test';
import path from 'node:path';

test('selecting two passage-history entries compares those two revisions directly, with surrounding context', async () => {
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
      editors.STORY.replace(0, model.text.length, model.text.replace('Maria walked in.', 'Maria walked in slowly.'));
      await getCommitController().explicitSave('Slowed Maria entrance.');
      const from = model.text.indexOf('Maria walked in');
      return { from, to: from + 'Maria walked in'.length };
    });
    await window.evaluate(({ from, to }) => window.__noirDraftTest.editors.STORY.setSelection(from, to), positions);

    await window.getByRole('button', { name: 'Passage history…' }).click();
    const list = window.locator('[data-passage-history-list]');
    await expect(list.locator('.passage-history-entry')).toHaveCount(2);

    const multiCompare = window.locator('[data-passage-multi-compare]');
    await expect(multiCompare).toBeHidden();

    const baseEntry = list.locator('.passage-history-entry', { hasText: 'Base state' });
    const slowedEntry = list.locator('.passage-history-entry', { hasText: 'Slowed Maria entrance.' });

    // Selecting only one entry must not open the two-revision comparison yet.
    await baseEntry.getByRole('button', { name: 'Select to compare' }).click();
    await expect(multiCompare).toBeHidden();
    await expect(baseEntry).toHaveClass(/selected-for-compare/);

    await slowedEntry.getByRole('button', { name: 'Select to compare' }).click();
    await expect(multiCompare).toBeVisible();
    await expect(multiCompare).toContainText('Comparing revision 1 with revision 2');
    // This is a direct revision-vs-revision diff, not either compared against
    // the current text, and includes surrounding context around the passage.
    await expect(multiCompare).toContainText('Maria walked in');
    await expect(multiCompare.locator('.diff-delete, .diff-insert').first()).toBeVisible();

    // Deselecting one collapses the comparison again.
    await baseEntry.getByRole('button', { name: 'Selected for comparison' }).click();
    await expect(multiCompare).toBeHidden();
  } finally {
    await application.close();
  }
});
