import { test, expect, _electron as electron } from '@playwright/test';
import path from 'node:path';

test('Versions view derives a bounded local graph, inspects patches, and checks out narrative state', async () => {
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
    await expect(graph.locator('.graph-node')).toHaveCount(3);
    await expect(graph.locator('.graph-node.current')).toContainText('Revision 2');
    await expect(graph.locator('.graph-node[data-revision-id="1"]')).toContainText('Linear note');
    await expect(graph.locator('.graph-node[data-revision-id="2"]')).toContainText('Branch note');

    await graph.locator('.graph-node[data-revision-id="1"]').getByRole('button', { name: 'Revision 1' }).click();
    await expect(window.getByRole('heading', { name: 'Revision 1' })).toBeVisible();
    await expect(window.locator('[data-payload-type="patch"]')).toContainText('Linear edit.');

    await graph.locator('.graph-node[data-revision-id="1"]').getByRole('button', { name: 'Checkout' }).click();
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
    const graph = window.getByLabel('Versions graph');
    // Current revision is 6; radius 2 shows 4,5,6 and hides the earlier root revisions.
    await expect(graph.locator('.graph-node')).toHaveCount(3);
    const jump = graph.locator('.graph-jump[data-direction="ancestor"]');
    await expect(jump).toContainText('earlier revision');
    await jump.click();
    // One jump re-centers on the nearest hidden node (revision 3); the true
    // root (revision 0) is still one more hop further back from there.
    await expect(graph.locator('.graph-node.focused')).toContainText('Revision 3');
    await expect(graph.locator('.graph-jump[data-direction="ancestor"]')).toBeVisible();

    await window.getByLabel('Search revisions').fill('Edit 5');
    const results = window.locator('[data-version-search-results] button');
    await expect(results).toHaveCount(1);
    await results.first().click();
    await expect(graph.locator('.graph-node.focused')).toContainText('Revision 6');
  } finally {
    await application.close();
  }
});
