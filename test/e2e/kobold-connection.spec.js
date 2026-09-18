import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startFakeKoboldServer } from '../support/fake-kobold-server.js';

test('the AI sidebar detects a disconnected server cleanly, then connects to the fake KoboldCpp server', async () => {
  // Isolate machine-global preferences so the initial "disconnected" check
  // below is deterministic even when a real KoboldCpp server happens to be
  // running on the application's normal default URL, as it may be on a
  // developer machine.
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
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.getKoboldClient !== undefined));

    // The isolated preferences point at an unreachable port, so the editor
    // must show a clean disconnected state rather than hanging or throwing.
    const status = window.getByLabel('AI connection status');
    await expect(status).toContainText('Disconnected');

    const server = await startFakeKoboldServer({ model: 'gemma-fake', contextLength: 8192 });
    try {
      await window.getByLabel('More actions').click();
      await window.getByRole('button', { name: 'AI connection…' }).click();
      await window.getByLabel('KoboldCpp server URL').fill(server.url);
      await window.getByRole('button', { name: 'Connect' }).click();

      await expect(status).toContainText('Connected: gemma-fake');
      await expect(status).toContainText('8192');

      const contextLength = await window.evaluate(() => window.__noirDraftTest.getKoboldContextLength());
      expect(contextLength).toBe(8192);
    } finally {
      await server.close();
    }
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
