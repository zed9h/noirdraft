import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
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
    const card = window.locator('[data-version-detail]');
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

    await window.getByRole('button', { name: 'Check out revision' }).click();
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

test('clicking the selected node again deselects it and hides the detail pane', async () => {
  const application = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  });
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.getCommitController()));
    await window.evaluate(async () => {
      const { model, getCommitController } = window.__noirDraftTest;
      model.replace(model.text.length, model.text.length, '\nOne more line.');
      await getCommitController().explicitSave('Note');
    });
    await window.getByRole('button', { name: 'Versions', exact: true }).click();
    const graph = window.locator('[data-version-graph]');
    const detail = window.locator('[data-version-detail]');
    await expect(detail).toBeHidden();
    await expect(graph.locator('.graph-node.focused')).toHaveCount(0);
    const before = (await graph.boundingBox()).width;

    await graph.getByRole('button', { name: /^Revision 0\b/ }).click();
    await expect(graph.locator('.graph-node.focused')).toHaveCount(1);
    await expect(detail).toBeVisible();
    expect((await graph.boundingBox()).width).toBeLessThan(before);

    // The divider between graph and detail is resizable, and the detail scrolls inside the pane.
    const resizer = window.locator('[data-pane-resizer="detail"]');
    await expect(resizer).toBeVisible();
    const detailWidth = (await detail.boundingBox()).width;
    await resizer.focus();
    await window.keyboard.press('ArrowLeft');
    await expect.poll(async () => (await detail.boundingBox()).width).toBeGreaterThan(detailWidth);
    const paneBox = await window.locator('#versions-view').boundingBox();
    const detailBox = await detail.boundingBox();
    expect(detailBox.y + detailBox.height).toBeLessThanOrEqual(paneBox.y + paneBox.height + 1);

    await graph.getByRole('button', { name: /^Revision 0\b/ }).click();
    await expect(graph.locator('.graph-node.focused')).toHaveCount(0);
    await expect(detail).toBeHidden();
    await expect.poll(async () => (await graph.boundingBox()).width).toBe(before);
  } finally {
    await application.close();
  }
});

test('the Patch prefixes toggle shows the stored + / - / space prefixes in revision diffs and is saved as a project option', async () => {
  // Isolated machine preferences: the toggle persists there and must not touch the real ones.
  const directory = await mkdtemp(path.join(os.tmpdir(), 'noirdraft-e2e-prefs-'));
  const application = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true', NOIRDRAFT_E2E_PREFERENCES_PATH: path.join(directory, 'preferences.json') },
  });
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.getCommitController()));
    await window.evaluate(async () => {
      const { model, getCommitController } = window.__noirDraftTest;
      model.replace(model.text.length, model.text.length, '\nAdded line.');
      await getCommitController().explicitSave('Note');
    });
    await window.getByRole('button', { name: 'Versions', exact: true }).click();
    const graph = window.locator('[data-version-graph]');
    await graph.getByRole('button', { name: /^Revision 1\b/ }).click();
    const added = window.locator('[data-version-detail] .diff-row-add', { hasText: 'Added line.' });
    await expect(added.first()).toContainText('Added line.');
    await expect(added.first()).not.toContainText('+');

    await window.getByRole('button', { name: 'More actions' }).click();
    await window.getByRole('button', { name: 'Patch prefixes' }).click();
    await expect(window.getByRole('button', { name: 'Patch prefixes' })).toHaveAttribute('aria-pressed', 'true');
    await expect(added.first()).toHaveText(/^\+.*Added line\./);
    await expect(window.locator('[data-version-detail] .diff-row-context').first()).toHaveText(/^ /);
    await expect.poll(() => window.evaluate(() => window.__noirDraftTest.models.METADATA.text)).toContain('validPatchDiff: true');

    await window.getByRole('button', { name: 'Patch prefixes' }).click();
    await expect(added.first()).not.toContainText('+');
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
