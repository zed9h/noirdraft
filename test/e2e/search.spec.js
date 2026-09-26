import { test, expect, _electron as electron } from '@playwright/test';
import path from 'node:path';

const launch = () => electron.launch({
  args: [path.resolve('.')],
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
});

test('Ctrl+F searches the text: hits replace the outline, arrows navigate, Right/Left/Escape resolve', async () => {
  const application = await launch();
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.editors?.METADATA));
    await window.evaluate(() => {
      const { editors, models, refreshSidebar } = window.__noirDraftTest;
      editors.STORY.replace(0, models.STORY.text.length, '# Chapter\n\nThe lantern swung.\n\n## Scene\n\nAnother lantern burned.\n');
      editors.STORY.setSelection(3, 3);
      refreshSidebar();
    });
    const search = window.getByLabel('Search text', { exact: true });
    const results = window.locator('[data-text-search-results] button');
    const outline = window.locator('.project-folds');
    const selection = () => window.evaluate(() => {
      const { models } = window.__noirDraftTest;
      return [models.STORY.selectionStart, models.STORY.selectionEnd];
    });

    // Clicking into the field and typing must keep every letter typed.
    await window.getByRole('button', { name: 'Open text search' }).click();
    await expect(search).toBeFocused();
    await window.keyboard.type('lan');
    await expect(search).toHaveValue('lan');
    await search.fill('');
    await window.keyboard.press('Escape');

    await window.keyboard.press('Control+f');
    await expect(search).toBeFocused();
    await window.keyboard.type('lantern');
    await expect(search).toHaveValue('lantern');
    await expect(results).toHaveCount(2);
    await expect(outline).toBeHidden();
    expect(await window.evaluate(() => CSS.highlights.get('search-term')?.size)).toBe(1);

    await window.keyboard.press('ArrowDown');
    await expect(results.nth(1)).toHaveClass(/is-active/);

    // Prev/next buttons step without taking focus from the field.
    await window.getByRole('button', { name: 'Next text match' }).click();
    await expect(results.nth(0)).toHaveClass(/is-active/); // wrapped from the last hit
    await window.getByRole('button', { name: 'Previous text match' }).click();
    await expect(results.nth(1)).toHaveClass(/is-active/);
    await expect(search).toBeFocused();

    // Ctrl+Alt+Arrows: Left/Right previous/next, Up/Down first/last.
    await window.keyboard.press('Control+Alt+ArrowUp');
    await expect(results.nth(0)).toHaveClass(/is-active/);
    await window.keyboard.press('Control+Alt+ArrowDown');
    await expect(results.nth(1)).toHaveClass(/is-active/);
    await window.keyboard.press('Control+Alt+ArrowLeft');
    await expect(results.nth(0)).toHaveClass(/is-active/);
    await window.keyboard.press('Control+Alt+ArrowRight');
    await expect(results.nth(1)).toHaveClass(/is-active/);

    // Escape clears the search and puts the caret back where it was.
    await window.keyboard.press('Escape');
    await expect(outline).toBeVisible();
    await expect(search).toHaveValue('');
    expect(await selection()).toEqual([3, 3]);

    // Right goes to the hit and keeps the search.
    await window.keyboard.press('Control+f');
    await window.keyboard.type('lantern');
    await window.keyboard.press('ArrowDown');
    await window.keyboard.press('ArrowRight');
    await expect(results).toHaveCount(2);
    const [start, end] = await selection();
    expect(end - start).toBe('lantern'.length);
    expect(start).toBe(await window.evaluate(() => window.__noirDraftTest.models.STORY.text.lastIndexOf('lantern')));

    // Left clears the search and stays on the hit.
    await window.keyboard.press('Control+f');
    await window.keyboard.press('ArrowLeft');
    await expect(outline).toBeVisible();
    await expect(search).toHaveValue('');
    expect((await selection())[0]).toBe(start);
  } finally {
    await application.close();
  }
});

test('Alt+Shift+F searches revision notes and change sets from the Versions pane', async () => {
  const application = await launch();
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.getCommitController()));
    await window.evaluate(async () => {
      const { editors, models, getCommitController } = window.__noirDraftTest;
      editors.STORY.replace(0, models.STORY.text.length, '# Chapter\n\nA violin hummed.\n');
      await getCommitController().explicitSave('First pass');
      editors.STORY.replace(0, models.STORY.text.length, '# Chapter\n\nA violin hummed. Thunderclap.\n');
      await getCommitController().explicitSave('Weather');
    });
    const search = window.getByLabel('Search revisions');
    const count = window.locator('[data-version-search-count]');

    await window.locator('[data-story-editor], #story-editor').first().focus();
    await window.keyboard.press('Alt+Shift+F');
    await expect(search).toBeFocused();
    await window.keyboard.type('thunderclap');
    await expect(count).toHaveText('1 of 1'); // only the change set of "Weather" contains it
    await expect(window.locator('.graph-node.focused')).toBeVisible();

    await window.keyboard.press('Escape');
    await expect(search).toHaveValue('');
    await expect(window.locator('#story-editor')).toBeFocused();

    await window.keyboard.press('Alt+Shift+F');
    await window.keyboard.type('first pass');
    await expect(count).toHaveText('1 of 1');
    await window.keyboard.press('ArrowRight');
    await expect(window.locator('[data-version-graph]')).toBeFocused();
    await expect(count).toHaveText('1 of 1'); // search kept

    // Navigation mode: F3 steps through the highlighted nodes from the graph.
    await window.keyboard.press('Escape'); // graph: ends the search
    await expect(count).toBeHidden();
    await window.evaluate(async () => {
      const { editors, models, getCommitController } = window.__noirDraftTest;
      editors.STORY.replace(0, models.STORY.text.length, '# Chapter\n\nA violin hummed again.\n');
      await getCommitController().explicitSave('Weather again');
    });
    await window.keyboard.press('Alt+Shift+F');
    await window.keyboard.type('weather');
    await expect(count).toHaveText('1 of 2');
    await expect(window.locator('.graph-node.search-hit')).not.toHaveCount(0);
    await window.keyboard.press('ArrowRight');
    await expect(window.locator('[data-version-graph]')).toBeFocused();
    await window.keyboard.press('F3');
    await expect(count).toHaveText('2 of 2');
    await window.keyboard.press('Shift+F3');
    await expect(count).toHaveText('1 of 2');
    await window.keyboard.press('Control+Alt+ArrowDown');
    await expect(count).toHaveText('2 of 2');
    await window.keyboard.press('Control+Alt+ArrowUp');
    await expect(count).toHaveText('1 of 2');
    await window.keyboard.press('Control+Alt+ArrowRight');
    await expect(count).toHaveText('2 of 2');
    await window.keyboard.press('Control+Alt+ArrowLeft');
    await expect(count).toHaveText('1 of 2');
    await window.getByRole('button', { name: 'Next matching revision' }).click();
    await expect(count).toHaveText('2 of 2');
    await window.getByRole('button', { name: 'Previous matching revision' }).click();
    await expect(count).toHaveText('1 of 2');
  } finally {
    await application.close();
  }
});

test('clicking a version node keeps focus inside the Versions pane', async () => {
  const application = await launch();
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.getCommitController()));
    await window.evaluate(async () => {
      const { editors, models, getCommitController } = window.__noirDraftTest;
      editors.STORY.replace(0, models.STORY.text.length, '# Chapter\n\nOne.\n');
      await getCommitController().explicitSave('First');
      editors.STORY.replace(0, models.STORY.text.length, '# Chapter\n\nTwo.\n');
      await getCommitController().explicitSave('Second');
    });
    await window.getByRole('button', { name: 'Versions', exact: true }).click();
    await window.locator('.graph-node').first().click();
    await expect.poll(() => window.evaluate(() => Boolean(document.activeElement?.closest('#versions-view')))).toBe(true);
    await window.locator('.graph-node').last().click();
    await expect.poll(() => window.evaluate(() => Boolean(document.activeElement?.closest('#versions-view')))).toBe(true);
  } finally {
    await application.close();
  }
});
