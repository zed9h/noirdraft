import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startFakeKoboldServer } from '../support/fake-kobold-server.js';

test('including a compared passage as an AI reference shows it as included and sends it in the next request', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'noirdraft-e2e-prefs-'));
  const preferencesPath = path.join(directory, 'preferences.json');
  await writeFile(preferencesPath, JSON.stringify({ koboldUrl: 'http://127.0.0.1:1' }), 'utf8');
  const application = await electron.launch({
    args: [path.resolve('.')],
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      NOIRDRAFT_E2E_PREFERENCES_PATH: preferencesPath,
    },
  });
  const server = await startFakeKoboldServer({ tokens: ['Rewritten.'] });
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.getCommitController()));

    const positions = await window.evaluate(async () => {
      const { model, editors, getCommitController } = window.__noirDraftTest;
      const base = '# Chapter\n\nThe room was cold.\n\nElias waited.\n';
      editors.STORY.replace(0, model.text.length, base);
      await getCommitController().explicitSave('Base state');
      editors.STORY.replace(0, model.text.length, model.text.replace('The room was cold.', 'The room felt icy.'));
      await getCommitController().explicitSave('Rewrite.');
      const from = model.text.indexOf('The room');
      return { from, to: from + 'The room'.length };
    });

    await window.evaluate((url) => window.__noirDraftTest.connectToKobold(url), server.url);
    await window.evaluate(({ from, to }) => window.__noirDraftTest.editors.STORY.setSelection(from, to), positions);
    await window.getByRole('button', { name: 'Versions', exact: true }).click();

    await window.locator('[data-version-graph]').getByRole('button', { name: /^Revision 1\b/ }).click();
    const card = window.locator('.graph-card');
    await card.getByRole('button', { name: 'Include as AI reference' }).click();
    await expect(card.getByRole('button', { name: 'Remove from AI reference' })).toBeVisible();

    const includedBeforeGenerate = await window.evaluate(() => window.__noirDraftTest.getAgentReferences());
    expect(includedBeforeGenerate).toHaveLength(1);
    expect(includedBeforeGenerate[0].text).toContain('The room was cold.');

    // Selecting a fresh target and generating must actually send this reference.
    const selectionForGenerate = await window.evaluate(() => {
      const { model } = window.__noirDraftTest;
      const from = model.text.indexOf('Elias waited.');
      return { from, to: from + 'Elias waited.'.length };
    });
    await window.evaluate(({ from, to }) => window.__noirDraftTest.editors.STORY.setSelection(from, to), selectionForGenerate);
    await window.getByLabel('Chat prompt').fill('Rewrite this.');
    await window.getByRole('button', { name: 'Send' }).click();
    await expect(window.getByLabel('Chat history')).toContainText('Done.', { timeout: 5000 });

    // Prove the reference was actually sent to the model, not just tracked in the UI.
    const sentText = server.getChatRequests().flatMap(({ messages }) => messages.map(({ content }) => String(content))).join('\n');
    expect(sentText).toContain('REFERENCE Revision 1 passage (user)');
    expect(sentText).toContain('The room was cold.');

    // Removing it must clear the reference again. The button's accessible name
    // changed after the first click, so re-query it rather than reusing the
    // stale "Include as AI reference" locator.
    await card.getByRole('button', { name: 'Remove from AI reference' }).click();
    await expect(card.getByRole('button', { name: 'Include as AI reference' })).toBeVisible();
    const includedAfterRemove = await window.evaluate(() => window.__noirDraftTest.getAgentReferences());
    expect(includedAfterRemove).toHaveLength(0);
  } finally {
    await server.close();
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
