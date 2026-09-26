import { test, expect, _electron as electron } from '@playwright/test';
import path from 'node:path';

test('header Undo and branch-aware Redo walk one STORY graph', async () => {
  const application = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  });
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.getCommitController()));

    const original = await window.evaluate(() => window.__noirDraftTest.model.text);
    await window.evaluate(() => {
      const { model } = window.__noirDraftTest;
      model.replace(model.text.length, model.text.length, '\nFirst branch.');
    });
    await window.evaluate(async () => {
      const { model, getCommitController } = window.__noirDraftTest;
      model.replace(model.text.length, model.text.length, '\nFirst branch.');
      await getCommitController().explicitSave('First branch');
      await getCommitController().undo();
      model.replace(model.text.length, model.text.length, '\nSecond branch.');
      await getCommitController().explicitSave('Second branch');
      await getCommitController().undo();
    });
    await window.evaluate(() => window.__noirDraftTest.refreshSidebar());
    const redo = window.getByRole('button', { name: 'Redo', exact: true });
    await expect(redo).toBeEnabled();
    await redo.click();

    // With more than one branch, Redo opens a dropdown of the choices
    // instead of checking one out directly.
    const redoMenu = window.getByLabel('Redo branches');
    await expect(redoMenu).toBeVisible();
    await redoMenu.getByRole('button', { name: /^Revision 2/ }).click();
    await expect.poll(() => window.evaluate(() => window.__noirDraftTest.model.text)).toContain('Second branch.');
    const graph = await window.evaluate(() => {
      const history = window.__noirDraftTest.getHistory();
      return {
        current: history.currentRevision,
        revisions: [...history.revisions.values()].map(({ id, parents }) => ({ id, parents })),
      };
    });
    expect(graph.current).toBe(2);
    expect(graph.revisions).toEqual([
      { id: 0, parents: [] },
      { id: 1, parents: [0] },
      { id: 2, parents: [0] },
    ]);
  } finally {
    await application.close();
  }
});
