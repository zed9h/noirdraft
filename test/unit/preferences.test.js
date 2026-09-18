import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_PREFERENCES, readPreferences, writePreferences } from '../../src/main/preferences.js';

test('readPreferences returns defaults when no file exists yet', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'noirdraft-prefs-'));
  try {
    const preferences = await readPreferences(path.join(directory, 'preferences.json'));
    assert.deepEqual(preferences, DEFAULT_PREFERENCES);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('writePreferences persists a deep merge and readPreferences reflects it', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'noirdraft-prefs-'));
  const filePath = path.join(directory, 'preferences.json');
  try {
    await writePreferences(filePath, { koboldUrl: 'http://localhost:5555' });
    const afterFirst = await readPreferences(filePath);
    assert.equal(afterFirst.koboldUrl, 'http://localhost:5555');
    assert.equal(afterFirst.generationDefaults.max_length, DEFAULT_PREFERENCES.generationDefaults.max_length);

    await writePreferences(filePath, { generationDefaults: { temperature: 1.1 } });
    const afterSecond = await readPreferences(filePath);
    assert.equal(afterSecond.koboldUrl, 'http://localhost:5555');
    assert.equal(afterSecond.generationDefaults.temperature, 1.1);
    assert.equal(afterSecond.generationDefaults.max_length, DEFAULT_PREFERENCES.generationDefaults.max_length);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a corrupted preferences file falls back to defaults rather than throwing', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'noirdraft-prefs-'));
  const filePath = path.join(directory, 'preferences.json');
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(filePath, '{ not valid json', 'utf8');
    const preferences = await readPreferences(filePath);
    assert.deepEqual(preferences, DEFAULT_PREFERENCES);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
