import { test, expect, _electron as electron } from '@playwright/test';
import path from 'node:path';

test('the bottom Versions panel renders explorable graph nodes and pinned variations', async () => {
  const application = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  });
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.getCommitController()));
    const original = await window.evaluate(() => window.__noirDraftTest.model.text);
    await window.evaluate(async () => {
      const { model, getCommitController } = window.__noirDraftTest;
      model.replace(model.text.length, model.text.length, '\nLinear edit.');
      await getCommitController().explicitSave('Linear note');
      await getCommitController().undo();
      model.replace(model.text.length, model.text.length, '\nBranch edit.');
      await getCommitController().explicitSave('Branch note');
    });

    await window.getByRole('button', { name: 'Versions', exact: true }).click();
    const graph = window.locator('[data-version-graph]');
    await expect(graph.locator('.graph-node')).toHaveCount(3);
    await expect(graph.locator('.graph-node.current')).toContainText('2');
    await expect(graph.locator('.graph-edges line')).toHaveCount(2);

    await graph.getByRole('button', { name: 'Revision 1' }).click();
    const inspector = window.getByLabel('Pinned variations');
    await expect(inspector.getByRole('heading', { name: 'Revision 1' })).toBeVisible();
    await expect(window.locator('[data-payload-type="patch"]')).toContainText('Linear edit.');
    await inspector.getByRole('button', { name: 'Pin variation' }).click();
    // Once something is pinned the inspector lists only pinned revisions, so a
    // further node is pinned from the graph with Space (Enter just inspects).
    await graph.getByRole('button', { name: 'Revision 2' }).click();
    await graph.focus();
    await window.keyboard.press('Space');
    await expect(inspector.getByRole('heading', { name: 'Automatic comparison' })).toBeVisible();

    await graph.focus();
    await window.keyboard.press('ArrowLeft');
    await expect(graph.locator('.graph-node.focused')).toContainText('0');

    await inspector.getByRole('button', { name: 'Checkout' }).first().click();
    await expect(graph.locator('.graph-node[data-revision-id="1"]')).toHaveClass(/current/);
    const state = await window.evaluate(() => ({
      story: window.__noirDraftTest.model.text,
      current: window.__noirDraftTest.getHistory().currentRevision,
    }));
    expect(state).toEqual({ story: `${original}\nLinear edit.`, current: 1 });
  } finally {
    await application.close();
  }
});

test('the local graph collapses distant revisions into a searchable jump, and search can re-center on any revision', async () => {
  const application = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  });
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.getCommitController()));

    await window.evaluate(async () => {
      const { model, getCommitController } = window.__noirDraftTest;
      for (let index = 0; index < 6; index += 1) {
        model.replace(model.text.length, model.text.length, `\nEdit ${index}.`);
        await getCommitController().explicitSave(`Edit ${index}`);
      }
    });

    await window.getByRole('button', { name: 'Versions', exact: true }).click();
    const graph = window.locator('[data-version-graph]');
    // Current revision is 6; radius 2 shows 4,5,6 and hides the earlier root revisions.
    await expect(graph.locator('.graph-node')).toHaveCount(3);
    const jump = graph.locator('.graph-jump[data-direction="ancestor"]');
    await expect(jump).toContainText('earlier revision');
    await jump.click();
    // One jump re-centers on the nearest hidden node (revision 3); the true
    // root (revision 0) is still one more hop further back from there.
    await expect(graph.locator('.graph-node.focused')).toContainText('3');
    await expect(graph.locator('.graph-jump[data-direction="ancestor"]')).toBeVisible();

    await window.getByLabel('Search revisions').fill('Edit 5');
    const results = window.locator('[data-version-search-results] button');
    await expect(results).toHaveCount(1);
    await results.first().click();
    await expect(graph.locator('.graph-node.focused')).toContainText('6');
  } finally {
    await application.close();
  }
});
