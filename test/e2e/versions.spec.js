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
    await expect(graph.locator('.graph-edges path')).toHaveCount(2);

    await graph.getByRole('button', { name: /^Revision 1\b/ }).click();
    const card = graph.locator('.graph-card');
    await expect(card.getByRole('heading', { name: 'Revision 1' })).toBeVisible();
    await expect(card).toContainText('Linear note');
    await card.getByRole('button', { name: 'Pin revision' }).click();
    await graph.getByRole('button', { name: /^Revision 2\b/ }).click();
    await graph.focus();
    await window.keyboard.press('Space');
    await expect(window.locator('[data-pinned-panel] .pinned-card')).toHaveCount(2);
    await expect(graph.locator('.graph-node.pinned')).toHaveCount(2);

    await graph.focus();
    await window.keyboard.press('ArrowLeft');
    await expect(graph.locator('.graph-node.focused')).toContainText('0');

    await graph.getByRole('button', { name: 'Check out revision' }).click();
    await expect(graph.locator('.graph-node[data-revision-id="0"]')).toHaveClass(/current/);
    await expect(graph.locator('.graph-node.current')).toHaveCount(1);
  } finally {
    await application.close();
  }
});

test('the graph shows the whole history, zooms and pans with the mouse, and search re-centres on any revision', async () => {
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
    await expect(graph.locator('.graph-node')).toHaveCount(7);
    const world = graph.locator('.graph-world');
    const before = await world.evaluate((element) => element.style.transform);
    const box = await graph.boundingBox();
    // Wheel zooms around the pointer; a left-drag on the background pans.
    await window.mouse.move(box.x + 40, box.y + box.height - 30);
    await window.mouse.wheel(0, -300);
    await expect.poll(() => world.evaluate((element) => element.style.transform)).not.toBe(before);
    const zoomed = await world.evaluate((element) => element.style.transform);
    await window.mouse.down();
    await window.mouse.move(box.x + 100, box.y + box.height - 10, { steps: 4 });
    await window.mouse.up();
    await expect.poll(() => world.evaluate((element) => element.style.transform)).not.toBe(zoomed);

    await window.getByRole('button', { name: 'Open revision search' }).click();
    await window.getByLabel('Search revisions').fill('Edit 5');
    // Search highlights and steps to the hit; there is no separate result list.
    await expect(window.locator('[data-version-search-count]')).toHaveText('1 of 1');
    await expect(graph.locator('.graph-node.focused')).toContainText('6');
  } finally {
    await application.close();
  }
});
