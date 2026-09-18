import { test, expect, _electron as electron } from '@playwright/test';
import path from 'node:path';

test('adopting a compared passage opens an editable Composite, tracks provenance, and commits without losing source revisions', async () => {
  const application = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  });
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.getCommitController()));

    // All three commits touch the same single paragraph, so the (single-hunk)
    // diff between any two of them stays confined to that paragraph, keeping
    // the unrelated second paragraph a safe, untouched place for a manual edit.
    const positions = await window.evaluate(async () => {
      const { model, editors, getCommitController } = window.__noirDraftTest;
      const base = '# Chapter\n\nThe room was cold.\n\nThis paragraph never changes.\n';
      editors.STORY.replace(0, model.text.length, base);
      await getCommitController().explicitSave('Base state');

      editors.STORY.replace(0, model.text.length, model.text.replace('The room was cold.', 'The room felt icy.'));
      await getCommitController().explicitSave('First rewrite.');

      editors.STORY.replace(0, model.text.length, model.text.replace('The room felt icy.', 'The room felt icy and dark.'));
      await getCommitController().explicitSave('Second rewrite.');

      const from = model.text.indexOf('The room');
      return { from, to: from + 'The room'.length };
    });
    const originalStory = await window.evaluate(() => window.__noirDraftTest.model.text);

    await window.evaluate(({ from, to }) => window.__noirDraftTest.editors.STORY.setSelection(from, to), positions);
    await window.getByRole('button', { name: 'Passage history…' }).click();

    const baseEntry = window.locator('.passage-history-entry', { hasText: 'Base state' });
    await baseEntry.getByRole('button', { name: 'Use this version' }).click();

    // Adopting opens the Composite view; the checked-out STORY must stay untouched.
    const compositeEditor = window.getByRole('textbox', { name: 'Composite source' });
    await expect(compositeEditor).toBeVisible();
    await expect(compositeEditor).toContainText('The room was cold.');
    await expect(compositeEditor).toContainText('This paragraph never changes.');
    const storyDuringComposite = await window.evaluate(() => window.__noirDraftTest.model.text);
    expect(storyDuringComposite).toBe(originalStory);

    const provenance = window.locator('[data-composite-provenance] p');
    await expect(provenance).toHaveCount(1);
    await expect(provenance.first()).toContainText('revision 1');

    // Direct manual edits on the composite must also work, since it uses the same editor model.
    await window.evaluate(() => {
      const { editors, models } = window.__noirDraftTest;
      const marker = models.COMPOSITE.text.indexOf('This paragraph never changes.');
      editors.COMPOSITE.replace(marker, marker + 'This paragraph never changes.'.length, 'Manually edited paragraph.');
    });
    await expect(compositeEditor).toContainText('Manually edited paragraph.');

    await window.getByRole('button', { name: 'Commit composite' }).click();

    // Committing must not disturb the source revisions (still 4: root + 3 edits),
    // and the composite becomes a new, distinct fifth revision from the exact base.
    const finalState = await window.evaluate(() => {
      const history = window.__noirDraftTest.getHistory();
      return {
        revisionCount: history.revisions.size,
        current: history.currentRevision,
        parents: history.revisions.get(history.currentRevision).parents,
        story: window.__noirDraftTest.model.text,
      };
    });
    expect(finalState.revisionCount).toBe(5);
    expect(finalState.current).toBe(4);
    expect(finalState.parents).toEqual([3]);
    expect(finalState.story).toContain('The room was cold.');
    expect(finalState.story).toContain('Manually edited paragraph.');
    expect(finalState.story).not.toContain('icy');

    // Composite view closes and returns to STORY after commit.
    await expect(window.getByRole('textbox', { name: 'Story source' })).toBeVisible();
  } finally {
    await application.close();
  }
});

test('discarding a composite creates no revision and leaves every source revision untouched', async () => {
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
      editors.STORY.replace(0, model.text.length, base.replace('Maria walked in.', 'Maria walked in slowly.'));
      await getCommitController().explicitSave('Slowed Maria entrance.');
      const from = model.text.indexOf('Maria walked in');
      return { from, to: from + 'Maria walked in'.length };
    });

    await window.evaluate(({ from, to }) => window.__noirDraftTest.editors.STORY.setSelection(from, to), positions);
    await window.getByRole('button', { name: 'Passage history…' }).click();
    await window.locator('.passage-history-entry', { hasText: 'Base state' }).getByRole('button', { name: 'Use this version' }).click();

    const revisionCountBefore = await window.evaluate(() => window.__noirDraftTest.getHistory().revisions.size);
    await window.getByRole('button', { name: 'Discard' }).click();

    await expect(window.getByRole('textbox', { name: 'Story source' })).toBeVisible();
    const state = await window.evaluate(() => ({
      revisionCount: window.__noirDraftTest.getHistory().revisions.size,
      composite: window.__noirDraftTest.getCompositeState(),
    }));
    expect(state.revisionCount).toBe(revisionCountBefore);
    expect(state.composite).toBeNull();
  } finally {
    await application.close();
  }
});
