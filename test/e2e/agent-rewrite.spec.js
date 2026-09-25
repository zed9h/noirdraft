import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startFakeKoboldServer } from '../support/fake-kobold-server.js';

test('generating a stable rewrite records a STORY proposal that applies only on checkout', async () => {
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
    // The chat reply cites the proposal revision, then the agent's own message.
    await expect(window.getByLabel('Chat history')).toContainText('#2 Done.', { timeout: 5000 });

    // The setup edit above is revision 1. The agent's rewrite is revision 2,
    // a child of 1, but stays a proposal: the editor still shows revision 1.
    const graph = await window.evaluate(() => {
      const history = window.__noirDraftTest.getHistory();
      return { currentRevision: history.currentRevision, proposal: history.revisions.get(2), text: window.__noirDraftTest.model.text };
    });
    expect(graph.currentRevision).toBe(1);
    expect(graph.text).not.toContain('freezing');
    expect(graph.proposal.origin).toBe('agent');
    expect(graph.proposal.parents).toEqual([1]);

    // Explicit application is a checkout of the proposal revision.
    await window.evaluate(() => window.__noirDraftTest.getCommitController().checkout(2));
    await expect.poll(() => window.evaluate(() => window.__noirDraftTest.model.text)).toContain('freezing');
  } finally {
    await server.close();
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('an empty chat rewrite shows a failed turn with a retry and never applies text', async () => {
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
    // The failed card explains the failure in its status text and offers a
    // retry on the same card (the call row itself is icon-only).
    await expect(window.locator('.chat-message-error')).toContainText('Retry the turn', { timeout: 5000 });
    await expect(window.locator('.chat-call-failed').getByRole('button', { name: 'Retry call' })).toBeVisible();
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
    await expect(window.getByLabel('Chat history')).toContainText('#2 Done.', { timeout: 5000 });
    // The proposal is revision 2 in the METADATA graph; METADATA still shows revision 1.
    const proposed = await window.evaluate(() => {
      const history = window.__noirDraftTest.getMetadataHistory();
      return { current: history.currentRevision, origin: history.revisions.get(2).origin, text: window.__noirDraftTest.models.METADATA.text };
    });
    expect(proposed.current).toBe(1);
    expect(proposed.origin).toBe('agent');
    expect(proposed.text).not.toContain('retired detective');
    await window.evaluate(() => window.__noirDraftTest.getMetadataCommitController().checkout(2));
    await expect.poll(() => window.evaluate(() => window.__noirDraftTest.models.METADATA.text)).toContain('retired detective');
  } finally {
    await server.close();
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('an advanced root leaves its completed rewrite as an unapplied alternative', async () => {
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
    await expect(window.getByLabel('Chat history')).toContainText('#3 Done.');
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
