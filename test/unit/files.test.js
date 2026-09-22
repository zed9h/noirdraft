import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { backupPathFor } from '../../src/main/backups.js';
import { writeBackup } from '../../src/main/backups.js';
import {
  FilePersistenceError,
  hasExternalChange,
  readDocument,
  safeSaveDocument,
  validateProjectSource,
} from '../../src/main/files.js';

const temporaryDirectories = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'noirdraft-files-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test('safe save backs up, flushes, replaces, and verifies an existing document', async () => {
  const directory = await temporaryDirectory();
  const filePath = path.join(directory, 'novel.md');
  const oldSource = 'STORY\n=====\n\n# Old\n';
  const newSource = 'STORY\n=====\n\n# New\nText.\n';
  await writeFile(filePath, oldSource, 'utf8');
  const opened = await readDocument(filePath);

  const saved = await safeSaveDocument({
    filePath,
    contents: newSource,
    expectedFingerprint: opened.fingerprint,
    now: new Date('2026-09-18T06:07:08.009Z'),
  });

  assert.equal(await readFile(filePath, 'utf8'), newSource);
  assert.equal(await readFile(saved.backupPath, 'utf8'), oldSource);
  assert.equal(saved.backupPath, path.join(directory, 'backup', 'novel.2026-09-18T06-07-08-009Z.md'));
  assert.equal(saved.fingerprint.hash, (await readDocument(filePath)).fingerprint.hash);
});

test('new documents save without creating a meaningless backup', async () => {
  const directory = await temporaryDirectory();
  const filePath = path.join(directory, 'new.md');
  const source = 'STORY\r\n=====\r\n\r\n# Chapter\r\n';
  const saved = await safeSaveDocument({ filePath, contents: source });
  assert.equal(saved.backupPath, null);
  assert.equal(await readFile(filePath, 'utf8'), source.replaceAll('\r\n', '\n'));
});

test('external changes are detected and never overwritten', async () => {
  const directory = await temporaryDirectory();
  const filePath = path.join(directory, 'novel.md');
  await writeFile(filePath, 'STORY\n=====\n\nOriginal.\n', 'utf8');
  const opened = await readDocument(filePath);
  await writeFile(filePath, 'STORY\n=====\n\nChanged outside.\n', 'utf8');
  assert.equal(await hasExternalChange(filePath, opened.fingerprint), true);

  await assert.rejects(
    safeSaveDocument({
      filePath,
      contents: 'STORY\n=====\n\nApp change.\n',
      expectedFingerprint: opened.fingerprint,
    }),
    (error) => error instanceof FilePersistenceError && error.code === 'EXTERNAL_CHANGE',
  );
  assert.equal(await readFile(filePath, 'utf8'), 'STORY\n=====\n\nChanged outside.\n');
  assert.deepEqual(await readdir(directory), ['novel.md']);
});

test('replacement failure preserves the original and its backup', async () => {
  const directory = await temporaryDirectory();
  const filePath = path.join(directory, 'novel.md');
  const original = 'STORY\n=====\n\nOriginal.\n';
  await writeFile(filePath, original, 'utf8');
  const opened = await readDocument(filePath);

  await assert.rejects(
    safeSaveDocument({
      filePath,
      contents: 'STORY\n=====\n\nReplacement.\n',
      expectedFingerprint: opened.fingerprint,
      now: new Date('2026-09-18T00:00:00Z'),
      operations: { replace: async () => { throw new Error('injected replacement failure'); } },
    }),
    (error) => error instanceof FilePersistenceError && error.code === 'SAVE_FAILED',
  );
  assert.equal(await readFile(filePath, 'utf8'), original);
  assert.equal(
    await readFile(backupPathFor(filePath, new Date('2026-09-18T00:00:00Z')), 'utf8'),
    original,
  );
  assert.equal((await readdir(directory)).some((name) => name.endsWith('.tmp')), false);
});

test('invalid project structure fails before touching disk', async () => {
  const directory = await temporaryDirectory();
  const filePath = path.join(directory, 'novel.md');
  const original = 'STORY\n=====\n\nOriginal.\n';
  await writeFile(filePath, original, 'utf8');
  await assert.rejects(
    safeSaveDocument({ filePath, contents: 'STORY\n=====\nOne\nSTORY\n=====\nTwo\n' }),
    (error) => error instanceof FilePersistenceError && error.code === 'INVALID_PROJECT_STRUCTURE',
  );
  assert.equal(await readFile(filePath, 'utf8'), original);
  assert.deepEqual(await readdir(directory), ['novel.md']);
  assert.throws(
    () => validateProjectSource('METADATA\n========\nOnly.\n'),
    (error) => error.code === 'MISSING_STORY_ROOT',
  );
});

test('backup creation never overwrites a same-timestamp backup', async () => {
  const directory = await temporaryDirectory();
  const filePath = path.join(directory, 'novel.md');
  const now = new Date('2026-09-18T12:00:00Z');
  const first = await writeBackup(filePath, 'first', { now });
  const second = await writeBackup(filePath, 'second', { now });
  assert.notEqual(first, second);
  assert.equal(await readFile(first, 'utf8'), 'first');
  assert.equal(await readFile(second, 'utf8'), 'second');
});
