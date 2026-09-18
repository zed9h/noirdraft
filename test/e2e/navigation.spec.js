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

    const storyOutline = window.getByLabel('Story outline');
    const metadataOutline = window.getByLabel('Metadata outline');
    await expect(storyOutline.getByRole('button', { name: 'Chapter', exact: true })).toBeVisible();
    await expect(storyOutline.getByRole('button', { name: 'Scene', exact: true })).toBeVisible();
    await expect(metadataOutline.getByRole('button', { name: 'Maria', exact: true })).toBeVisible();
    await storyOutline.getByRole('button', { name: 'Scene', exact: true }).click();
    expect(await window.evaluate(() => window.__noirDraftTest.models.STORY.selectionStart)).toBe(11);

    await window.getByRole('button', { name: 'Metadata', exact: true }).click();
    await expect(window.getByRole('textbox', { name: 'Metadata source' })).toBeVisible();
    await metadataOutline.getByRole('button', { name: 'Maria', exact: true }).click();
    await metadataOutline.getByRole('button', { name: 'Pin METADATA/Characters/Maria' }).click();
    const pinnedSource = await window.evaluate(() => window.__noirDraftTest.models.METADATA.text);
    expect(pinnedSource).toContain('# Application\n\n## Context\n\n- METADATA/Characters/Maria\n');
    await expect(window.getByLabel('Context pins')).toContainText('1 context pin');

    await metadataOutline.getByRole('button', { name: 'Collapse METADATA/Characters' }).click();
    await expect(metadataOutline.getByRole('button', { name: 'Maria', exact: true })).toBeVisible();
    await expect(window.getByLabel('Context pins').getByRole('button', { name: 'METADATA/Characters/Maria' })).toBeVisible();

    const metadataFold = window.getByRole('button', { name: 'Collapse Metadata', exact: true });
    await metadataFold.focus();
    await window.keyboard.press('ArrowLeft');
    await expect(metadataOutline.getByRole('button', { name: 'Maria', exact: true })).toBeVisible();
    await expect(window.getByLabel('Context pins')).toContainText('1 context pin');
    await window.keyboard.press('ArrowRight');
    await expect(metadataOutline).toBeVisible();

    await window.evaluate(() => {
      const { editors, models } = window.__noirDraftTest;
      const from = models.METADATA.text.indexOf('Maria');
      editors.METADATA.replace(from, from + 5, 'Marie');
    });
    await expect(window.getByLabel('Context pins')).toContainText('unresolved: METADATA/Characters/Maria');
    expect(await window.evaluate(() => window.__noirDraftTest.models.METADATA.text)).toContain('- METADATA/Characters/Maria');
  } finally {
    await application.close();
  }
});
