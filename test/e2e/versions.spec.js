import { test, expect, _electron as electron } from '@playwright/test';
import path from 'node:path';

test('Versions view derives graph nodes, inspects patches, and checks out narrative state', async () => {
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
    const graph = window.getByLabel('Versions graph');
    await expect(graph.locator('.version-node')).toHaveCount(3);
    await expect(graph.locator('.version-node.current')).toContainText('Revision 2');
    await expect(graph.locator('[data-revision-id="1"]')).toContainText('Linear note');
    await expect(graph.locator('[data-revision-id="2"]')).toContainText('Branch note');

    await graph.locator('[data-revision-id="1"]').getByRole('button', { name: 'Revision 1' }).click();
    await expect(graph.getByRole('heading', { name: 'Revision 1' })).toBeVisible();
    await expect(graph.locator('[data-payload-type="patch"]')).toContainText('Linear edit.');

    await graph.locator('[data-revision-id="1"]').getByRole('button', { name: 'Checkout' }).click();
    await expect(graph.locator('[data-revision-id="1"]')).toHaveClass(/current/);
    const state = await window.evaluate(() => ({
      story: window.__noirDraftTest.model.text,
      current: window.__noirDraftTest.getHistory().currentRevision,
    }));
    expect(state).toEqual({ story: `${original}\nLinear edit.`, current: 1 });
  } finally {
    await application.close();
  }
});
