import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHistory, commitRevision } from '../../src/renderer/history/graph.js';
import { serializeHistories } from '../../src/renderer/history/serialize.js';

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

// Regression: opening a document used to leave the Versions panel — and the
// pinned/focused/inspected revision-id state behind it — showing whatever
// history was attached before (e.g. the startup sample), because
// loadDocument attached the new STORY/METADATA histories without ever
// re-rendering the panel or clearing stale revision-id state. Since every
// freshly attached history restarts its revision ids at 0, a stale id can
// coincidentally resolve against the new history and point at the wrong
// revision instead of just failing loudly.
test('opening a document refreshes the Versions panel and clears stale revision-id state', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'noirdraft-e2e-open-versions-'));
  const filePath = path.join(directory, 'story.md');

  const storyText0 = '# Chapter One\n\nOnce upon a time.\n';
  const storyText = '# Chapter One\n\nOnce upon a time, revised.\n';
  const metadataText0 = '# Style\n\nNoir tone.\n';
  const metadataText1 = '# Style\n\nNoir tone, revised.\n';
  const storyHistory = await createHistory(storyText0);
  await commitRevision(storyHistory, storyText0, storyText, { origin: 'user' });
  const metadataHistory = await createHistory(metadataText0);
  await commitRevision(metadataHistory, metadataText0, metadataText1, { origin: 'user' });
  const versions = serializeHistories({ STORY: storyHistory, METADATA: metadataHistory });
  await writeFile(filePath, [
    'STORY\n=====\n\n', storyText, '\n',
    'METADATA\n========\n\n', metadataText1, '\n',
    'VERSIONS\n========\n\n', versions,
  ].join(''), 'utf8');

  const application = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  });
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.getMetadataCommitController()));

    // Pin and focus a revision in the sample's (single-node) graph before
    // opening the real document, so stale ids have something to leak.
    await window.getByRole('button', { name: 'Versions', exact: true }).click();
    const graph = window.locator('[data-version-graph]');
    await expect(graph.locator('.graph-node')).toHaveCount(1);
    await graph.getByRole('button', { name: /^Revision 0\b/ }).click();
    await window.locator('[data-version-detail]').getByRole('button', { name: 'Pin revision' }).click();
    await expect(window.locator('[data-pinned-panel] .pinned-card')).toHaveCount(1);

    await application.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    }, filePath);
    await window.getByLabel('Open…').click();
    await window.waitForFunction(() => document.querySelector('[data-document-status]')?.textContent === 'Opened');

    // The graph reflects the opened file's real STORY history — two
    // revisions, still on the STORY tab, no further edit or panel toggle —
    // instead of the single-node sample graph shown a moment ago.
    await expect(graph.locator('.graph-node')).toHaveCount(2);
    await expect(graph.locator('.graph-node.current')).toContainText('1');

    // No revision pinned from the sample document survives into the newly
    // opened one.
    await expect(window.locator('[data-pinned-panel] .pinned-card')).toHaveCount(0);

    const metadataText = await window.evaluate(() => window.__noirDraftTest.models.METADATA.text);
    expect(metadataText).toContain('revised');
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// Regression: loadDocument used to mutate the live editors/models (making
// the newly opened text visible and editable) *before* finishing its async
// work (hashing, and — on a VERSIONS/text mismatch — recording a recovery
// revision and persisting it) that leads up to attachHistory/
// attachMetadataHistory. A keystroke landing in that gap committed against
// the outgoing document's history/controller, either silently vanishing or
// throwing "Commit base does not equal its parent STORY state." on the next
// commit. This fixture forces that async gap open (a METADATA text that
// mismatches its recorded VERSIONS triggers the recovery + persist path) and
// races an edit against the in-flight open.
test('a race between opening a document and editing does not corrupt or mismatch its history', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'noirdraft-e2e-race-'));
  const filePath = path.join(directory, 'novel.md');

  const storyText = '# Chapter One\n\nOnce upon a time.\n';
  const recordedMetadata = '# Style\n\nNoir tone.\n';
  const actualMetadata = '# Style\n\nSomething the recorded history never saw.\n';
  const storyHistory = await createHistory(storyText);
  const metadataHistory = await createHistory(recordedMetadata);
  const versions = serializeHistories({ STORY: storyHistory, METADATA: metadataHistory });
  await writeFile(filePath, [
    'STORY\n=====\n\n', storyText, '\n',
    'METADATA\n========\n\n', actualMetadata, '\n',
    'VERSIONS\n========\n\n', versions,
  ].join(''), 'utf8');

  const application = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  });
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.getCommitController()));
    const document = await window.evaluate(async (target) => window.noirDraft.documents.openPath(target), filePath);
    expect(document.canceled).toBeFalsy();

    // loadDocument runs synchronously up to its first await; calling it
    // without awaiting, then immediately (same tick, same evaluate call)
    // performing the edit deterministically lands the edit before any of
    // loadDocument's own awaits have had a chance to resolve — this is the
    // exact gap the fix closes.
    await window.evaluate((doc) => {
      const loadPromise = window.__noirDraftTest.loadDocument(doc.document, { statusLabel: 'Opened' });
      const { editors, models } = window.__noirDraftTest;
      editors.METADATA.replace(models.METADATA.text.length, models.METADATA.text.length, '\nRaced edit.\n');
      window.__raceLoad = loadPromise;
    }, document);
    await window.evaluate(() => window.__raceLoad);

    // Whatever happened to the raced keystroke, the document must now be
    // internally consistent: a further ordinary edit must commit cleanly
    // with no COMMIT_BASE_MISMATCH ("Commit base does not equal its parent
    // STORY state.") surfaced through the status line.
    await window.evaluate(() => window.__noirDraftTest.getMetadataCommitController().commitPending({ origin: 'user' }));
    const statusAfterRace = await window.evaluate(() => document.querySelector('[data-document-status]')?.textContent);
    expect(statusAfterRace ?? '').not.toContain('Commit base');

    await window.evaluate(() => {
      const { editors, models } = window.__noirDraftTest;
      editors.METADATA.replace(models.METADATA.text.length, models.METADATA.text.length, '\nFollow-up edit.\n');
    });
    await window.evaluate(() => window.__noirDraftTest.getMetadataCommitController().commitPending({ origin: 'user' }));
    const status = await window.evaluate(() => document.querySelector('[data-document-status]')?.textContent);
    expect(status).not.toContain('Commit base');
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// Regression: a corrupted or unreadable VERSIONS section (a bad hash, a
// missing revision, anything reconstructRevision can throw on) used to
// abort the whole open with a HistoryError, leaving the document
// completely unopened even though its STORY/METADATA text is perfectly
// readable, authoritative Markdown right there in the same file. Opening
// must fall back to a fresh single-revision history in that case, not
// refuse to open the document at all.
test('a corrupted VERSIONS section does not block opening the STORY/METADATA text', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'noirdraft-e2e-corrupt-versions-'));
  const filePath = path.join(directory, 'novel.md');

  const storyText = '# Chapter One\n\nOnce upon a time.\n';
  const metadataText = '# Style\n\nNoir tone.\n';
  const storyHistory = await createHistory(storyText);
  const metadataHistory = await createHistory(metadataText);
  let versions = serializeHistories({ STORY: storyHistory, METADATA: metadataHistory });
  // Corrupt STORY revision 0's Result-Hash so reconstructRevision throws
  // "Result hash mismatch for revision 0." exactly as reported.
  versions = versions.replace(
    /(STORY:REV[\s\S]*?Result-Hash: )[a-f0-9]{64}/,
    '$1' + '0'.repeat(64),
  );
  await writeFile(filePath, [
    'STORY\n=====\n\n', storyText, '\n',
    'METADATA\n========\n\n', metadataText, '\n',
    'VERSIONS\n========\n\n', versions,
  ].join(''), 'utf8');

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
    await window.waitForFunction(
      () => document.querySelector('[data-document-status]')?.textContent?.includes('could not be read'),
      { timeout: 5000 },
    );

    const state = await window.evaluate(() => ({
      storyText: window.__noirDraftTest.models.STORY.text,
      metadataText: window.__noirDraftTest.models.METADATA.text,
      storyRevs: window.__noirDraftTest.getHistory().revisions.size,
      metaRevs: window.__noirDraftTest.getMetadataHistory().revisions.size,
    }));
    expect(state.storyText).toContain('Once upon a time.');
    expect(state.metadataText).toContain('Noir tone.');
    expect(state.storyRevs).toBe(1);
    expect(state.metaRevs).toBe(1);

    // The document is fully usable afterward: an ordinary edit commits
    // cleanly against the fresh history.
    await window.evaluate(() => {
      const { editors, models } = window.__noirDraftTest;
      editors.STORY.replace(models.STORY.text.length, models.STORY.text.length, '\nMore.\n');
    });
    await window.evaluate(() => window.__noirDraftTest.getCommitController().commitPending({ origin: 'user' }));
    const status = await window.evaluate(() => document.querySelector('[data-document-status]')?.textContent);
    expect(status).not.toContain('Commit base');
    expect(status).not.toContain('hash mismatch');
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
