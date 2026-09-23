import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Nothing about dialog.showOpenDialog stops a second click from spawning a
// second, independent native picker — confusing on its own, and one
// picker's answer can end up processed while another is still open and
// silently absorbing focus. The Open button disables itself for the
// duration of one open request to prevent that pile-up.

test('opening a document loads it and reports a status distinct from Save', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'noirdraft-e2e-open-'));
  const filePath = path.join(directory, 'story.md');
  await writeFile(filePath, 'STORY\n=====\n\n# A file opened from disk\n\nHello world.\n', 'utf8');
  const application = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  });
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.getCommitController()));
    await application.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, filePath);

    await window.getByLabel('Open…').click();
    await window.waitForFunction(() => document.querySelector('[data-document-status]')?.textContent === 'Opened');

    await expect(window.locator('#editor-title')).toHaveText('story');
    const storyText = await window.evaluate(() => window.__noirDraftTest.models.STORY.text);
    expect(storyText).toContain('A file opened from disk');
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('rapid re-clicking Open triggers only one native file picker', async () => {
  test.setTimeout(15000);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'noirdraft-e2e-open-guard-'));
  const filePath = path.join(directory, 'story.md');
  await writeFile(filePath, 'STORY\n=====\n\n# A file opened from disk\n\nHello world.\n', 'utf8');
  const application = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  });
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.getCommitController()));
    await application.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => {
        globalThis.__openDialogCalls = (globalThis.__openDialogCalls ?? 0) + 1;
        // A real native dialog stays open for as long as a human takes to
        // decide; simulate that latency so rapid re-clicks land while the
        // first request is still in flight.
        await new Promise((resolve) => setTimeout(resolve, 300));
        return { canceled: false, filePaths: [target] };
      };
    }, filePath);

    // Real hardware double/triple-clicking, dispatched synchronously in one
    // tick — unlike a Playwright locator.click(), a raw DOM .click() on a
    // disabled button is simply dropped rather than retried once re-enabled.
    await window.evaluate(() => {
      const button = document.querySelector('[data-open]');
      button.click();
      button.click();
      button.click();
    });
    await window.waitForFunction(() => document.querySelector('[data-document-status]')?.textContent === 'Opened');

    const callCount = await application.evaluate(() => globalThis.__openDialogCalls ?? 0);
    expect(callCount).toBe(1);
    const storyText = await window.evaluate(() => window.__noirDraftTest.models.STORY.text);
    expect(storyText).toContain('A file opened from disk');
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
