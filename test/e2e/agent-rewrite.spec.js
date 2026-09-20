import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startFakeKoboldServer } from '../support/fake-kobold-server.js';

test('generating a stable rewrite applies it immediately as a reversible STORY revision', async () => {
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
  const server = await startFakeKoboldServer({ tokens: ['The ', 'room ', 'was ', 'freezing.'], tokenDelayMs: 10 });
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.getCommitController()));

    const positions = await window.evaluate(() => {
      const { editors, models } = window.__noirDraftTest;
      const story = '# Chapter\n\nThe room was cold.\n\nShe sat down slowly.\n';
      editors.STORY.replace(0, models.STORY.text.length, story);
      const from = models.STORY.text.indexOf('The room was cold.');
      return { from, to: from + 'The room was cold.'.length };
    });
    await window.evaluate(({ from, to }) => window.__noirDraftTest.editors.STORY.setSelection(from, to), positions);

    await window.evaluate((url) => window.__noirDraftTest.connectToKobold(url), server.url);
    await window.getByLabel('Chat prompt').fill('Make it colder.');
    await window.getByRole('button', { name: 'Send' }).click();
    await expect(window.getByLabel('Chat history')).toContainText('freezing', { timeout: 5000 });

    // The setup edit above is revision 1; because it stayed stable while the
    // request ran, the agent child becomes current revision 2 immediately.
    await expect.poll(() => window.evaluate(() => window.__noirDraftTest.model.text)).toContain('freezing');
    const graph = await window.evaluate(() => {
      const history = window.__noirDraftTest.getHistory();
      return { currentRevision: history.currentRevision, applied: history.revisions.get(2) };
    });
    expect(graph.currentRevision).toBe(2);
    expect(graph.applied.origin).toBe('agent');
    expect(graph.applied.parents).toEqual([1]);
  } finally {
    await server.close();
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('an empty chat rewrite shows a failed call row and never applies text', async () => {
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
  const server = await startFakeKoboldServer({ tokens: [] });
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.getCommitController()));

    await window.evaluate(() => {
      const { editors, models } = window.__noirDraftTest;
      editors.STORY.replace(0, models.STORY.text.length, 'Some text here.\n');
      editors.STORY.setSelection(0, 4);
    });
    await window.evaluate((url) => window.__noirDraftTest.connectToKobold(url), server.url);

    await window.getByLabel('Chat prompt').fill('Rewrite this.');
    await window.getByRole('button', { name: 'Send' }).click();
    await expect(window.locator('.chat-call-failed')).toContainText('failed', { timeout: 5000 });
    // The setup edit was committed as revision 1 (the user->agent commit
    // boundary); the failed generation itself must add nothing further.
    const revisionCount = await window.evaluate(() => window.__noirDraftTest.getHistory().revisions.size);
    expect(revisionCount).toBe(2);
  } finally {
    await server.close();
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a stable METADATA selection is rewritten into its own revision graph', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'noirdraft-e2e-prefs-'));
  const preferencesPath = path.join(directory, 'preferences.json');
  await writeFile(preferencesPath, JSON.stringify({ koboldUrl: 'http://127.0.0.1:1' }), 'utf8');
  const application = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true', NOIRDRAFT_E2E_PREFERENCES_PATH: preferencesPath },
  });
  const server = await startFakeKoboldServer({ tokens: ['A retired detective.'] });
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.getMetadataCommitController()));
    await window.evaluate(() => {
      const { editors, models, switchView } = window.__noirDraftTest;
      editors.METADATA.replace(0, models.METADATA.text.length, '# Character\n\nA detective.\n');
      switchView('METADATA');
      const from = models.METADATA.text.indexOf('A detective.');
      editors.METADATA.setSelection(from, from + 'A detective.'.length);
    });
    await window.evaluate((url) => window.__noirDraftTest.connectToKobold(url), server.url);
    await window.getByLabel('Chat prompt').fill('Make the character older.');
    await window.getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => window.evaluate(() => window.__noirDraftTest.models.METADATA.text)).toContain('retired detective');
    const state = await window.evaluate(() => {
      const history = window.__noirDraftTest.getMetadataHistory();
      return { current: history.currentRevision, origin: history.revisions.get(history.currentRevision).origin };
    });
    expect(state).toEqual({ current: 2, origin: 'agent' });
  } finally {
    await server.close();
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('an advanced root leaves its completed rewrite as a merge-later alternative', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'noirdraft-e2e-prefs-'));
  const preferencesPath = path.join(directory, 'preferences.json');
  await writeFile(preferencesPath, JSON.stringify({ koboldUrl: 'http://127.0.0.1:1' }), 'utf8');
  const application = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true', NOIRDRAFT_E2E_PREFERENCES_PATH: preferencesPath },
  });
  const server = await startFakeKoboldServer({ tokens: ['Replacement.'], tokenDelayMs: 120 });
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.getCommitController()));
    await window.evaluate(() => {
      const { editors, models } = window.__noirDraftTest;
      editors.STORY.replace(0, models.STORY.text.length, 'Original.\n');
      editors.STORY.setSelection(0, 'Original.'.length);
    });
    await window.evaluate((url) => window.__noirDraftTest.connectToKobold(url), server.url);
    await window.getByLabel('Chat prompt').fill('Rewrite it.');
    await window.getByRole('button', { name: 'Send' }).click();
    await window.evaluate(async () => {
      const { editors, models, getCommitController } = window.__noirDraftTest;
      editors.STORY.replace(models.STORY.text.length, models.STORY.text.length, 'Author continuation.\n');
      await getCommitController().explicitSave('Author continued.');
    });
    await expect(window.getByLabel('Chat history')).toContainText('alternative branch for STORY');
    const state = await window.evaluate(() => {
      const history = window.__noirDraftTest.getHistory();
      return {
        current: history.currentRevision,
        text: window.__noirDraftTest.models.STORY.text,
        agentChildren: [...history.revisions.values()].filter((revision) => revision.origin === 'agent').map((revision) => ({ id: revision.id, parent: revision.parents[0] })),
      };
    });
    expect(state.current).toBe(2);
    expect(state.text).toContain('Author continuation.');
    expect(state.agentChildren).toEqual([{ id: 3, parent: 1 }]);
  } finally {
    await server.close();
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
