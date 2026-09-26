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

    await window.getByRole('button', { name: 'Versions', exact: true }).click();

    // Two revisions genuinely touched this exact text: the one that slowed Maria's
    // entrance, and the one that first introduced this passage from the app's
    // unrelated default document (an honest "similarity hint" boundary hop).
    // The Elias-only revision in between never touched this passage and is dimmed.
    const graph = window.locator('[data-version-graph]');
    await expect(window.locator('.passage-banner')).toContainText('Passage: 2 versions');
    await expect(graph.locator('.graph-node.passage')).toHaveCount(2);
    await expect(graph.locator('.graph-node[data-revision-id="1"]')).toHaveClass(/passage/);
    await expect(graph.locator('.graph-node[data-revision-id="3"]')).toHaveClass(/passage/);
    await expect(graph.locator('.graph-node[data-revision-id="2"]')).not.toHaveClass(/passage/);

    // One click pins every passage version into the pinned panel.
    await window.getByRole('button', { name: 'Pin all passage versions' }).click();
    await expect(window.locator('[data-pinned-panel] .pinned-card')).toHaveCount(2);
    await expect(graph.locator('.graph-node.passage.pinned')).toHaveCount(2);

    // Clearing the highlight restores the plain graph.
    await window.getByRole('button', { name: 'Clear passage highlight' }).click();
    await expect(graph.locator('.graph-node.passage')).toHaveCount(0);

    // The highlight follows the selection once it settles: collapsing it clears the banner,
    // selecting again brings the highlight back.
    await window.evaluate(() => window.__noirDraftTest.editors.STORY.setSelection(0, 0));
    await expect(window.locator('.passage-banner')).toBeHidden();
    await window.evaluate(({ from, to }) => window.__noirDraftTest.editors.STORY.setSelection(from, to), positions);
    await expect(graph.locator('.graph-node.passage')).toHaveCount(2);

    // The card of a node checks it out.
    await graph.getByRole('button', { name: /^Revision 2\b/ }).click();
    await window.getByRole('button', { name: 'Check out revision' }).click();
    const currentText = await window.evaluate(() => window.__noirDraftTest.model.text);
    expect(currentText).toContain('Elias watched silently.');
    expect(currentText).not.toContain('slowly');
  } finally {
    await application.close();
  }
});

test('a passage no revision ever changed highlights the root it traces to', async () => {
  const application = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  });
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.getCommitController()));
    const positions = await window.evaluate(async () => {
      const { model, getCommitController } = window.__noirDraftTest;
      const end = model.text.indexOf('\n') === -1 ? model.text.length : model.text.indexOf('\n');
      model.replace(model.text.length, model.text.length, '\nAppended later.');
      await getCommitController().explicitSave('Appended.');
      return { from: 0, to: end };
    });
    await window.evaluate(({ from, to }) => window.__noirDraftTest.editors.STORY.setSelection(from, to), positions);
    await window.getByRole('button', { name: 'Versions', exact: true }).click();
    const graph = window.locator('[data-version-graph]');
    await expect(window.locator('.passage-banner')).toContainText('never changed');
    await expect(graph.locator('.graph-node.passage')).toHaveCount(1);
    await expect(graph.locator('.graph-node[data-revision-id="0"]')).toHaveClass(/passage/);
  } finally {
    await application.close();
  }
});

test('Use passage replaces only the selected words at once and records the source as a secondary parent', async () => {
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
      editors.STORY.replace(0, model.text.length, model.text.replace('Maria walked in.', 'Maria walked in slowly.').replace('Elias watched.', 'Elias watched closely.'));
      await getCommitController().explicitSave('Slowed Maria entrance.');
      const from = model.text.indexOf('Maria walked in slowly');
      return { from, to: from + 'Maria walked in slowly'.length };
    });
    await window.evaluate(({ from, to }) => window.__noirDraftTest.editors.STORY.setSelection(from, to), positions);
    await window.getByRole('button', { name: 'Versions', exact: true }).click();
    const graph = window.locator('[data-version-graph]');
    await graph.getByRole('button', { name: /^Revision 1\b/ }).click();
    await window.getByRole('button', { name: "Replace the selected passage with revision 1's version" }).click();

    await expect.poll(() => window.evaluate(() => window.__noirDraftTest.getHistory().revisions.size)).toBe(4);
    const state = await window.evaluate(() => {
      const history = window.__noirDraftTest.getHistory();
      return { text: window.__noirDraftTest.model.text, parents: history.revisions.get(history.currentRevision).parents };
    });
    // Only the selected words changed; the unrelated edit elsewhere stays.
    expect(state.text).toContain('Maria walked in.\n');
    expect(state.text).not.toContain('slowly');
    expect(state.text).toContain('Elias watched closely.');
    expect(state.parents).toEqual([2, 1]);
  } finally {
    await application.close();
  }
});
