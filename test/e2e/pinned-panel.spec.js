import { test, expect, _electron as electron } from '@playwright/test';
import path from 'node:path';

test('pinned versions open a read-only cherry-pick panel; Enter checks out, Tab enters the panel, and a copied passage becomes a dotted secondary parent', async () => {
  const application = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  });
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.getCommitController()));
    await window.evaluate(async () => {
      const { model, getCommitController } = window.__noirDraftTest;
      model.replace(model.text.length, model.text.length, '\nBranch rain fell over the quiet harbor tonight.');
      await getCommitController().explicitSave('Branch');
      await getCommitController().undo();
      model.replace(model.text.length, model.text.length, '\nMain edit.');
      await getCommitController().explicitSave('Main');
    });
    await window.getByRole('button', { name: 'Versions', exact: true }).click();
    const graph = window.locator('[data-version-graph]');
    const panel = window.locator('[data-pinned-panel]');
    await expect(panel).toBeHidden();

    // Space pins several nodes at once.
    await graph.getByRole('button', { name: 'Revision 1' }).click();
    await graph.focus();
    await window.keyboard.press('Space');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.pinned-card')).toHaveCount(1);
    await expect(panel.locator('.pinned-passage')).toHaveText('Branch rain fell over the quiet harbor tonight.');
    await graph.getByRole('button', { name: 'Revision 2' }).click();
    await graph.focus();
    await window.keyboard.press('Space');
    await expect(panel.locator('.pinned-card')).toHaveCount(2);

    // Holding a node pins it; navigation inside the panel is by arrows.
    const three = graph.getByRole('button', { name: 'Revision 0' });
    // Parallel Electron windows share one virtual display, and a stray pointer
    // move from another window cancels a hold, so the hold is retried.
    await expect(async () => {
      await three.hover();
      await window.mouse.down();
      await window.waitForTimeout(800);
      await window.mouse.up();
      await expect(panel.locator('.pinned-card')).toHaveCount(3, { timeout: 500 });
    }).toPass({ timeout: 9000 });
    await panel.locator('.pinned-card').first().focus();
    await window.keyboard.press('ArrowDown');
    await expect(panel.locator('.pinned-card').nth(1)).toBeFocused();
    await window.keyboard.press('ArrowRight');
    await expect(panel.locator('.pinned-card').nth(2)).toBeFocused();
    await window.keyboard.press('ArrowLeft');
    await expect(panel.locator('.pinned-card').first()).toBeFocused();
    await window.keyboard.press('ArrowUp');
    await expect(panel.locator('.pinned-card').first()).toBeFocused();
    await graph.getByRole('button', { name: 'Revision 0' }).click();
    await graph.focus();
    await window.keyboard.press('Space');
    await expect(panel.locator('.pinned-card')).toHaveCount(2);

    // Enter checks out the focused node and returns to the editor.
    await graph.getByRole('button', { name: 'Revision 0' }).click();
    await graph.focus();
    await window.keyboard.press('Enter');
    await expect(graph.locator('.graph-node[data-revision-id="0"]')).toHaveClass(/current/);
    await expect(window.locator('#story-editor')).toBeFocused();

    // Double-clicking a node does the same as Enter.
    await window.locator('[data-pinned-close]').focus();
    await graph.getByRole('button', { name: 'Revision 1' }).dblclick();
    await expect(graph.locator('.graph-node[data-revision-id="1"]')).toHaveClass(/current/);
    await expect(window.locator('#story-editor')).toBeFocused();
    await graph.getByRole('button', { name: 'Revision 0' }).click();
    await graph.focus();
    await window.keyboard.press('Enter');
    await expect(window.locator('#story-editor')).toBeFocused();

    // Tab from the editor enters the panel instead of typing a tab.
    const before = await window.evaluate(() => window.__noirDraftTest.model.text);
    await window.keyboard.press('Tab');
    await expect(panel.locator('.pinned-card').first()).toBeFocused();
    expect(await window.evaluate(() => window.__noirDraftTest.model.text)).toBe(before);
    await window.keyboard.press('Escape');
    await expect(window.locator('#story-editor')).toBeFocused();

    // The panel resizes like the other panes.
    const resizer = window.locator('[data-pane-resizer="pinned"]');
    const height = (await panel.boundingBox()).height;
    await resizer.focus();
    await window.keyboard.press('ArrowDown');
    expect((await panel.boundingBox()).height).toBeLessThan(height);

    // Copy the branch passage from its card and paste it into the text.
    const card = panel.locator('.pinned-card[data-revision-id="1"]');
    await card.focus();
    await window.keyboard.press('Control+C');
    await window.locator('#story-editor').focus();
    await window.keyboard.press('Control+End');
    await window.keyboard.press('Control+V');
    await window.evaluate(async () => window.__noirDraftTest.getCommitController().explicitSave('Pasted'));
    const parents = await window.evaluate(() => {
      const history = window.__noirDraftTest.getHistory();
      return history.revisions.get(history.currentRevision).parents;
    });
    expect(parents).toEqual([0, 1]);
    await expect(graph.locator('.graph-edges line.secondary')).toHaveCount(1);

    // Closing the panel unpins everything.
    await panel.getByRole('button', { name: /Close pinned versions/ }).click();
    await expect(panel).toBeHidden();
    await expect(graph.locator('.graph-node.pinned')).toHaveCount(0);
  } finally {
    await application.close();
  }
});
