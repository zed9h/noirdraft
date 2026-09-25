import { test, expect, _electron as electron } from '@playwright/test';
import path from 'node:path';

test('Story and Metadata folds keep both outlines available while pins remain visible', async () => {
  const application = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  });
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.editors?.METADATA));
    await window.evaluate(() => {
      const { editors, models, refreshSidebar } = window.__noirDraftTest;
      editors.STORY.replace(0, models.STORY.text.length, '# Chapter\n\n## Scene\nStory.\n');
      editors.METADATA.replace(0, models.METADATA.text.length, '# Characters\n\n## Maria\nDetails.\n');
      refreshSidebar();
    });

    const storyOutline = window.getByLabel('Story outline', { exact: true });
    const metadataOutline = window.getByLabel('Metadata outline', { exact: true });
    await expect(storyOutline.getByRole('button', { name: 'Chapter', exact: true })).toBeVisible();
    await expect(storyOutline.getByRole('button', { name: 'Scene', exact: true })).toBeVisible();
    await expect(metadataOutline.getByRole('button', { name: 'Maria', exact: true })).toBeVisible();
    await storyOutline.getByRole('button', { name: 'Scene', exact: true }).click();
    // Clicking a section returns to the caret's last position in it (the setup
    // edit left the caret at the end of "Scene"), so assert it landed inside
    // the section rather than exactly on its heading.
    expect(await window.evaluate(() => window.__noirDraftTest.models.STORY.selectionStart)).toBeGreaterThanOrEqual(11);

    await window.getByRole('button', { name: 'Metadata', exact: true }).click();
    await expect(window.getByRole('textbox', { name: 'Metadata source' })).toBeVisible();
    await metadataOutline.getByRole('button', { name: 'Maria', exact: true }).click();
    await metadataOutline.getByRole('button', { name: 'Pin METADATA/Characters/Maria' }).click();
    const pinnedSource = await window.evaluate(() => window.__noirDraftTest.models.METADATA.text);
    expect(pinnedSource).toContain('# Application\n\n## Context\n\n- METADATA/Characters/Maria\n');
    // Pin state is shown on the outline's own toggle.
    await expect(metadataOutline.getByRole('button', { name: 'Unpin METADATA/Characters/Maria' })).toBeVisible();

    // A pinned row is prefixed with a pin marker, so it is located by its outline entry.
    await metadataOutline.getByRole('button', { name: 'Collapse METADATA/Characters' }).click();
    await expect(metadataOutline.locator('.outline-target', { hasText: 'Maria' })).toBeVisible();
    await expect(metadataOutline.getByRole('button', { name: 'Unpin METADATA/Characters/Maria' })).toBeVisible();

    const metadataFold = window.getByRole('button', { name: 'Collapse Metadata', exact: true });
    await metadataFold.focus();
    await window.keyboard.press('ArrowLeft');
    await expect(metadataOutline.locator('.outline-target', { hasText: 'Maria' })).toBeVisible();
    await expect(metadataOutline.getByRole('button', { name: 'Unpin METADATA/Characters/Maria' })).toBeVisible();
    await window.keyboard.press('ArrowRight');
    await expect(metadataOutline).toBeVisible();

    await window.evaluate(() => {
      const { editors, models } = window.__noirDraftTest;
      const from = models.METADATA.text.indexOf('Maria');
      editors.METADATA.replace(from, from + 5, 'Marie');
    });
    // The renamed heading no longer matches the stored pin, so once its fold is
    // expanded it is offered as an unpinned heading.
    await metadataOutline.getByRole('button', { name: 'Expand METADATA/Characters' }).click();
    await expect(metadataOutline.getByRole('button', { name: 'Pin METADATA/Characters/Marie' })).toBeVisible();
    // At the next commit the stale pin is dropped from the application context.
    await window.evaluate(() => window.__noirDraftTest.getMetadataCommitController().explicitSave());
    await expect.poll(() => window.evaluate(() => window.__noirDraftTest.models.METADATA.text)).not.toContain('- METADATA/Characters/Maria');
  } finally {
    await application.close();
  }
});

test('the outline highlight follows the caret while shift extends a selection, and shift-clicking a heading extends into it', async () => {
  const application = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  });
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.editors?.METADATA));
    const source = '# One\nAlpha body.\n# Two\nBeta body.\n# Three\nGamma body.\n';
    const offsets = await window.evaluate((text) => {
      const { editors, models, refreshSidebar } = window.__noirDraftTest;
      editors.STORY.replace(0, models.STORY.text.length, text);
      const oneOffset = text.indexOf('Alpha') + 1;
      editors.STORY.setSelection(oneOffset, oneOffset);
      refreshSidebar();
      return { one: oneOffset, two: text.indexOf('# Two'), three: text.indexOf('# Three') };
    }, source);

    const storyOutline = window.getByLabel('Story outline', { exact: true });
    const isCurrentLeaf = (name) => storyOutline.getByRole('button', { name, exact: true })
      .evaluate((element) => element.closest('.outline-row').classList.contains('is-current-leaf'));

    await expect(storyOutline.getByRole('button', { name: 'One', exact: true })).toBeVisible();
    expect(await isCurrentLeaf('One')).toBe(true);

    // Extend the selection with shift far enough to cross into "Two": the
    // anchor (fixed at oneOffset) must not be what the outline tracks, or
    // the highlight would stay stuck on "One".
    await window.getByRole('textbox', { name: 'Story source' }).focus();
    for (let index = 0; index < 12; index += 1) await window.keyboard.press('Shift+ArrowRight');
    await expect.poll(() => window.evaluate(() => window.__noirDraftTest.models.STORY.selectionEnd))
      .toBeGreaterThanOrEqual(offsets.two);
    expect(await isCurrentLeaf('Two')).toBe(true);
    // The anchor must still be exactly where shift was first held.
    expect(await window.evaluate(() => window.__noirDraftTest.models.STORY.selectionStart)).toBe(offsets.one);

    // Shift-click a heading in the same root: extend to it, keep the same
    // anchor, and leave keyboard focus in the editor (not on the button).
    await storyOutline.getByRole('button', { name: 'Three', exact: true }).click({ modifiers: ['Shift'] });
    const afterShiftClick = await window.evaluate(() => {
      const { models } = window.__noirDraftTest;
      return {
        selection: [models.STORY.selectionStart, models.STORY.selectionEnd],
        activeIsEditor: document.activeElement === document.querySelector('#story-editor'),
      };
    });
    expect(afterShiftClick.selection).toEqual([offsets.one, offsets.three]);
    expect(afterShiftClick.activeIsEditor).toBe(true);

    // A plain (non-shift) click on a heading in another root still just
    // navigates there and collapses the selection.
    await window.getByRole('button', { name: 'Metadata', exact: true }).click();
    await window.getByRole('button', { name: 'Story', exact: true }).click();
    await storyOutline.getByRole('button', { name: 'One', exact: true }).click();
    expect(await window.evaluate(() => {
      const { models } = window.__noirDraftTest;
      return models.STORY.selectionStart === models.STORY.selectionEnd;
    })).toBe(true);
  } finally {
    await application.close();
  }
});
