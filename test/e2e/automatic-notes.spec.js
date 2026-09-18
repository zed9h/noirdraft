import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startFakeKoboldServer } from '../support/fake-kobold-server.js';

async function launchIsolated() {
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
  const window = await application.firstWindow();
  await window.waitForFunction(() => Boolean(window.__noirDraftTest?.getCommitController()));
  return { application, window, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

async function enableAutoNotes(window) {
  await window.getByLabel('More actions').click();
  await window.getByRole('button', { name: 'Automatic revision notes' }).click();
}

test('a delayed successful note attaches to the existing node without creating another revision', async () => {
  const { application, window, cleanup } = await launchIsolated();
  const server = await startFakeKoboldServer({ tokens: ['Shortened ', 'the ', 'opening.'], tokenDelayMs: 40 });
  try {
    await enableAutoNotes(window);
    await window.evaluate((url) => window.__noirDraftTest.connectToKobold(url), server.url);

    await window.evaluate(async () => {
      const { model, getCommitController } = window.__noirDraftTest;
      model.replace(model.text.length, model.text.length, '\nA new sentence.');
      await getCommitController().explicitSave(null);
    });

    const revisionCountBeforeNote = await window.evaluate(() => window.__noirDraftTest.getHistory().revisions.size);
    await window.getByRole('button', { name: 'Versions', exact: true }).click();
    await expect(window.locator('.graph-node[data-revision-id="1"]')).toContainText('Generating note…');

    await expect(window.locator('.graph-node[data-revision-id="1"]')).toContainText('Shortened the opening.', { timeout: 5000 });
    const revisionCountAfterNote = await window.evaluate(() => window.__noirDraftTest.getHistory().revisions.size);
    expect(revisionCountAfterNote).toBe(revisionCountBeforeNote);
  } finally {
    await server.close();
    await application.close();
    await cleanup();
  }
});

test('a failed note generation leaves the revision usable with no note and no extra revision', async () => {
  const { application, window, cleanup } = await launchIsolated();
  const server = await startFakeKoboldServer({ tokens: [] });
  try {
    await enableAutoNotes(window);
    await window.evaluate((url) => window.__noirDraftTest.connectToKobold(url), server.url);

    await window.evaluate(async () => {
      const { model, getCommitController } = window.__noirDraftTest;
      model.replace(model.text.length, model.text.length, '\nAnother sentence.');
      await getCommitController().explicitSave(null);
    });

    await window.getByRole('button', { name: 'Versions', exact: true }).click();
    // An empty response resolves immediately, so the transient "Generating
    // note…" state may not be observable here; only the settled state matters.
    await expect(window.locator('.graph-node[data-revision-id="1"]')).toContainText('[no note]', { timeout: 5000 });
    const revisionCount = await window.evaluate(() => window.__noirDraftTest.getHistory().revisions.size);
    expect(revisionCount).toBe(2);
    // The manual "Generate note" control must remain available to retry later.
    await expect(window.locator('.graph-node[data-revision-id="1"]').getByRole('button', { name: 'Generate note' })).toBeVisible();
  } finally {
    await server.close();
    await application.close();
    await cleanup();
  }
});

test('a disconnected server never blocks editor work and never creates a revision for the note', async () => {
  const { application, window, cleanup } = await launchIsolated();
  try {
    await enableAutoNotes(window);
    // Preferences point at an unreachable port; koboldClient stays disconnected.

    await window.evaluate(async () => {
      const { model, getCommitController } = window.__noirDraftTest;
      model.replace(model.text.length, model.text.length, '\nYet another sentence.');
      await getCommitController().explicitSave(null);
    });

    await window.getByRole('button', { name: 'Versions', exact: true }).click();
    await expect(window.locator('.graph-node[data-revision-id="1"]')).toContainText('[no note]');
    await expect(window.locator('.graph-node[data-revision-id="1"]')).not.toContainText('Generating note…');
    const revisionCount = await window.evaluate(() => window.__noirDraftTest.getHistory().revisions.size);
    expect(revisionCount).toBe(2);
  } finally {
    await application.close();
    await cleanup();
  }
});

test('automatic notes stay off by default and can be disabled again, leaving revisions unaffected', async () => {
  const { application, window, cleanup } = await launchIsolated();
  const server = await startFakeKoboldServer({ tokens: ['Should ', 'not ', 'appear.'], tokenDelayMs: 10 });
  try {
    await window.evaluate((url) => window.__noirDraftTest.connectToKobold(url), server.url);

    await window.evaluate(async () => {
      const { model, getCommitController } = window.__noirDraftTest;
      model.replace(model.text.length, model.text.length, '\nDisabled-by-default sentence.');
      await getCommitController().explicitSave(null);
    });

    await window.getByRole('button', { name: 'Versions', exact: true }).click();
    await window.waitForTimeout(200);
    await expect(window.locator('.graph-node[data-revision-id="1"]')).toContainText('[no note]');

    // Explicitly toggle on, then off again; the off state must also stay quiet.
    await enableAutoNotes(window);
    await enableAutoNotes(window);
    await window.evaluate(async () => {
      const { model, getCommitController } = window.__noirDraftTest;
      model.replace(model.text.length, model.text.length, '\nSecond sentence while disabled again.');
      await getCommitController().explicitSave(null);
    });
    await window.waitForTimeout(300);
    await expect(window.locator('.graph-node[data-revision-id="2"]')).toContainText('[no note]');
    const revisionCount = await window.evaluate(() => window.__noirDraftTest.getHistory().revisions.size);
    expect(revisionCount).toBe(3);
  } finally {
    await server.close();
    await application.close();
    await cleanup();
  }
});
