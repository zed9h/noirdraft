import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startFakeKoboldServer } from '../support/fake-kobold-server.js';

test('selecting a STORY passage previews the exact composed model input with token usage', async () => {
  // Isolate machine-global preferences so this test's "disconnected" state is
  // deterministic even when a real KoboldCpp server happens to be running on
  // the application's normal default URL, as it may be on a developer machine.
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
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.getCommitController()));
    await expect(window.getByLabel('AI connection status')).toContainText('Disconnected');

    const preview = window.getByRole('button', { name: 'Preview context for draft message' });
    await expect(preview).toBeVisible();

    await window.evaluate(() => {
      const { editors, models } = window.__noirDraftTest;
      const story = '# Chapter\n\nMaria walked in. The room was cold.\n\nShe sat down slowly.\n';
      editors.STORY.replace(0, models.STORY.text.length, story);
      const metadata = '# Characters\n\n## Maria\n\nA cautious investigator.\n';
      editors.METADATA.replace(0, models.METADATA.text.length, metadata);
      const pinned = metadata.replace(/\n$/, '') + '\n\n# Application\n\n## Context\n\n- METADATA/Characters/Maria\n';
      editors.METADATA.replace(0, models.METADATA.text.length, pinned);
      const from = models.STORY.text.indexOf('The room was cold.');
      editors.STORY.setSelection(from, from + 'The room was cold.'.length);
    });

    await window.getByLabel('Chat prompt').fill('Make the room colder.');
    await preview.click();

    const dialog = window.locator('[data-context-dialog]');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-context-dialog-summary]')).toContainText('(estimated)');
    const promptText = await dialog.locator('.context-prompt').textContent();
    expect(promptText).toContain('<noirdraft_static>');
    expect(promptText).toContain('<reference label="REFERENCE METADATA/Characters/Maria"><![CDATA[## Maria');
    expect(promptText).toContain('A cautious investigator.');
    expect(promptText).toContain('<noirdraft_turn>');
    expect(promptText).toContain('<document_context>');
    expect(promptText).toContain('<selection><![CDATA[The room was cold.]]></selection>');
    expect(promptText).toContain('<request><![CDATA[Make the room colder.]]></request>');
    expect(promptText).toContain('<instructions><![CDATA[');

    // Now connect to a real fake server and confirm the estimate note goes away
    // and token counts come from the server's actual tokenizer.
    const server = await startFakeKoboldServer({ model: 'gemma-fake', contextLength: 4096 });
    try {
      await window.evaluate((url) => window.__noirDraftTest.connectToKobold(url), server.url);
      await dialog.getByRole('button', { name: 'Close context' }).click();
      await preview.click();
      await expect(dialog.locator('[data-context-dialog-summary]')).not.toContainText('estimated');
    } finally {
      await server.close();
    }
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
