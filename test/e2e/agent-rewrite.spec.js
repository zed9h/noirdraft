import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startFakeKoboldServer } from '../support/fake-kobold-server.js';

test('generating a rewrite preserves it as a proposal without touching the checked-out STORY until checkout', async () => {
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

    const agentPanel = window.locator('[data-agent-panel]');
    await expect(agentPanel).toBeHidden(); // not connected yet

    await window.evaluate((url) => window.__noirDraftTest.connectToKobold(url), server.url);
    await expect(agentPanel).toBeVisible();

    const originalStory = await window.evaluate(() => window.__noirDraftTest.model.text);

    await window.getByLabel('Instruction to the agent').fill('Make it colder.');
    await window.getByRole('button', { name: 'Generate' }).click();

    const preview = window.locator('[data-agent-preview]');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('freezing', { timeout: 5000 });

    // The proposal must be preserved even though it was never checked out.
    // (The setup edit above was itself committed as revision 1 by the
    // user->agent commit boundary, so the proposal is revision 2.)
    await expect(window.locator('.agent-proposal')).toHaveCount(1);
    const currentDuringProposal = await window.evaluate(() => window.__noirDraftTest.model.text);
    expect(currentDuringProposal).toBe(originalStory);
    const graph = await window.evaluate(() => {
      const history = window.__noirDraftTest.getHistory();
      return { currentRevision: history.currentRevision, proposal: history.revisions.get(2) };
    });
    expect(graph.currentRevision).toBe(1);
    expect(graph.proposal.origin).toBe('agent');
    expect(graph.proposal.parents).toEqual([1]);

    const proposalCard = window.locator('.agent-proposal').first();
    await proposalCard.getByRole('button', { name: 'Preview' }).click();
    await expect(proposalCard.locator('pre')).toContainText('The room was freezing.');

    // An unselected proposal can still be explicitly included as a reference
    // for another generation, per the workbench/context integration.
    await proposalCard.getByRole('button', { name: 'Include as AI reference' }).click();
    const references = await window.evaluate(() => window.__noirDraftTest.getAgentReferences());
    expect(references).toHaveLength(1);
    expect(references[0].text).toContain('The room was freezing.');
    await expect(window.locator('[data-agent-references]')).toContainText('Proposal 2');

    await proposalCard.getByRole('button', { name: 'Checkout' }).click();
    await expect.poll(() => window.evaluate(() => window.__noirDraftTest.model.text)).toContain('The room was freezing.');
    const finalCurrentRevision = await window.evaluate(() => window.__noirDraftTest.getHistory().currentRevision);
    expect(finalCurrentRevision).toBe(2);
  } finally {
    await server.close();
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a disconnected/failed generation shows a clean error and never touches STORY history', async () => {
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

    await window.getByRole('button', { name: 'Generate' }).click();

    const status = window.locator('[data-agent-status]');
    await expect(status).toContainText('empty proposal', { timeout: 5000 });
    await expect(window.locator('.agent-proposal')).toHaveCount(0);
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
