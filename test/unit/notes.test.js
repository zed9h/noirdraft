import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KoboldClient } from '../../src/renderer/ai/kobold.js';
import { generateNote, NoteError } from '../../src/renderer/ai/notes.js';
import { startFakeKoboldServer } from '../support/fake-kobold-server.js';

test('generateNote sends only origin, the relevant diff, and a neutral instruction, and returns the note', async () => {
  const server = await startFakeKoboldServer({ tokens: ['Shortened ', 'the ', 'confrontation.'] });
  try {
    const client = new KoboldClient(server.url);
    const note = await generateNote({
      client,
      origin: 'user',
      parentText: 'one\ntwo\nthree\n',
      resultText: 'one\nchanged\nthree\n',
    });
    assert.equal(note, 'Shortened the confrontation.');
  } finally {
    await server.close();
  }
});

test('generateNote refuses to describe a no-op change', async () => {
  const server = await startFakeKoboldServer({ tokens: ['irrelevant'] });
  try {
    const client = new KoboldClient(server.url);
    await assert.rejects(
      generateNote({ client, origin: 'user', parentText: 'same\n', resultText: 'same\n' }),
      (error) => error instanceof NoteError && error.code === 'NO_CHANGE',
    );
  } finally {
    await server.close();
  }
});

test('generateNote is contained as a NoteError when the server is unreachable', async () => {
  const client = new KoboldClient('http://127.0.0.1:1');
  await assert.rejects(
    generateNote({ client, origin: 'agent', parentText: 'a\n', resultText: 'b\n' }),
    (error) => error instanceof NoteError && error.code === 'UNAVAILABLE',
  );
});

test('generateNote refuses an empty model response as a typed error', async () => {
  const server = await startFakeKoboldServer({ tokens: [] });
  try {
    const client = new KoboldClient(server.url);
    await assert.rejects(
      generateNote({ client, origin: 'user', parentText: 'a\n', resultText: 'b\n' }),
      (error) => error instanceof NoteError && error.code === 'EMPTY_NOTE',
    );
  } finally {
    await server.close();
  }
});

test('generateNote takes only the first line, even if the model rambles', async () => {
  const server = await startFakeKoboldServer({ tokens: ['First line.', '\nSecond line should be dropped.'] });
  try {
    const client = new KoboldClient(server.url);
    const note = await generateNote({ client, origin: 'user', parentText: 'a\n', resultText: 'b\n' });
    assert.equal(note, 'First line.');
  } finally {
    await server.close();
  }
});
