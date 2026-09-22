import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('restricted IPC saves, backs up, and rejects an external overwrite', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'noirdraft-e2e-save-'));
  const filePath = path.join(directory, 'story.md');
  // Same-path save/backup/conflict behavior is this test's concern; timestamped
  // saves (its own feature, covered separately) would redirect every save to a
  // new file and defeat it, so it is disabled here in an isolated preferences file.
  const preferencesPath = path.join(directory, 'preferences.json');
  await writeFile(preferencesPath, JSON.stringify({ saveTimestampedCopies: false }), 'utf8');
  const application = await electron.launch({
    args: [path.resolve('.')],
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      NOIRDRAFT_E2E_ALLOWED_PATH: filePath,
      NOIRDRAFT_E2E_PREFERENCES_PATH: preferencesPath,
    },
  });

  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.noirDraft?.documents));
    const firstSource = 'STORY\n=====\n\n# First\n';
    const secondSource = 'STORY\n=====\n\n# Second\n';
    const first = await window.evaluate(
      ({ target, contents }) => window.noirDraft.documents.save({ filePath: target, contents }),
      { target: filePath, contents: firstSource },
    );
    expect(first.error).toBeUndefined();
    expect(await readFile(filePath, 'utf8')).toBe(firstSource);

    const second = await window.evaluate(
      ({ target, contents, fingerprint }) => window.noirDraft.documents.save({
        filePath: target,
        contents,
        expectedFingerprint: fingerprint,
      }),
      { target: filePath, contents: secondSource, fingerprint: first.document.fingerprint },
    );
    expect(second.error).toBeUndefined();
    expect(await readFile(filePath, 'utf8')).toBe(secondSource);
    const backups = await readdir(path.join(directory, 'backup'));
    expect(backups).toHaveLength(1);
    expect(await readFile(path.join(directory, 'backup', backups[0]), 'utf8')).toBe(firstSource);

    const externalSource = 'STORY\n=====\n\nExternally edited.\n';
    await writeFile(filePath, externalSource, 'utf8');
    const conflict = await window.evaluate(
      ({ target, contents, fingerprint }) => window.noirDraft.documents.save({
        filePath: target,
        contents,
        expectedFingerprint: fingerprint,
      }),
      { target: filePath, contents: firstSource, fingerprint: second.document.fingerprint },
    );
    expect(conflict.error.code).toBe('EXTERNAL_CHANGE');
    expect(await readFile(filePath, 'utf8')).toBe(externalSource);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('timestamped saves (on by default) write each save to a fresh base_yyyymmdd_HHMMSS file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'noirdraft-e2e-timestamped-save-'));
  const filePath = path.join(directory, 'story.md');
  const preferencesPath = path.join(directory, 'preferences.json');
  const application = await electron.launch({
    args: [path.resolve('.')],
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      NOIRDRAFT_E2E_ALLOWED_PATH: filePath,
      NOIRDRAFT_E2E_PREFERENCES_PATH: preferencesPath,
    },
  });

  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.noirDraft?.documents));
    const firstSource = 'STORY\n=====\n\n# First\n';
    const secondSource = 'STORY\n=====\n\n# Second\n';

    const first = await window.evaluate(
      ({ target, contents }) => window.noirDraft.documents.save({ filePath: target, contents }),
      { target: filePath, contents: firstSource },
    );
    expect(first.error).toBeUndefined();
    expect(first.document.filePath).toMatch(/story_\d{8}_\d{6}\.md$/);
    expect(first.document.filePath).not.toBe(filePath);
    expect(await readFile(first.document.filePath, 'utf8')).toBe(firstSource);

    // A later save, starting from the previous save's already-timestamped
    // path, re-derives "story" as the base rather than stacking suffixes.
    // (If both saves land within the same wall-clock second, the base is
    // still "story", disambiguated with a numeric suffix.)
    const second = await window.evaluate(
      ({ target, contents }) => window.noirDraft.documents.save({ filePath: target, contents }),
      { target: first.document.filePath, contents: secondSource },
    );
    expect(second.error).toBeUndefined();
    expect(second.document.filePath).toMatch(/story_\d{8}_\d{6}(_\d+)?\.md$/);
    expect(second.document.filePath).not.toBe(first.document.filePath);
    expect(second.document.filePath).not.toMatch(/story_\d{8}_\d{6}_\d{8}_\d{6}/);
    expect(await readFile(second.document.filePath, 'utf8')).toBe(secondSource);
    expect(await readFile(first.document.filePath, 'utf8')).toBe(firstSource);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('STORY:REV and METADATA:REV persist and reload as independent current graphs', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'noirdraft-e2e-root-history-'));
  const filePath = path.join(directory, 'roots.md');
  const preferencesPath = path.join(directory, 'preferences.json');
  await writeFile(preferencesPath, JSON.stringify({ saveTimestampedCopies: false }), 'utf8');
  const application = await electron.launch({
    args: [path.resolve('.')],
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      NOIRDRAFT_E2E_ALLOWED_PATH: filePath,
      NOIRDRAFT_E2E_PREFERENCES_PATH: preferencesPath,
    },
  });
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.getMetadataCommitController()));
    const saved = await window.evaluate(async (target) => {
      const app = window.__noirDraftTest;
      app.editors.STORY.replace(0, app.models.STORY.text.length, 'Story revision.\n');
      app.editors.METADATA.replace(0, app.models.METADATA.text.length, '# Notes\n\nMetadata revision.\n');
      await app.getCommitController().explicitSave('Story checkpoint');
      await app.getMetadataCommitController().explicitSave('Metadata checkpoint');
      const contents = app.buildProjectContents();
      const result = await window.noirDraft.documents.save({ filePath: target, contents });
      await app.loadDocument(result.document);
      return {
        contents,
        story: { current: app.getHistory().currentRevision, text: app.models.STORY.text },
        metadata: { current: app.getMetadataHistory().currentRevision, text: app.models.METADATA.text },
      };
    }, filePath);
    expect(saved.contents).toContain('STORY:REV\n---------');
    expect(saved.contents).toContain('METADATA:REV\n------------');
    expect(saved.story).toEqual({ current: 1, text: 'Story revision.' });
    expect(saved.metadata).toEqual({ current: 1, text: '# Notes\n\nMetadata revision.' });
    expect(await readFile(filePath, 'utf8')).toBe(saved.contents);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
