import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyUnifiedDiff, createUnifiedDiff, PatchError } from '../../src/renderer/history/diff.js';
import {
  childrenOf,
  commitRevision,
  createHistory,
  HistoryError,
  recordExternalEdit,
  reconstructRevision,
  verifyCurrentStory,
} from '../../src/renderer/history/graph.js';
import { hashStory } from '../../src/renderer/history/hash.js';
import { parseHistories, parseHistory, serializeHistories, serializeHistory } from '../../src/renderer/history/serialize.js';

test('SHA-256 hashes canonical UTF-8 visible-root contents deterministically', async () => {
  assert.equal(await hashStory('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(await hashStory('\n line\r\n'), await hashStory('line'));
});

for (const [name, before, after] of [
  ['replacement', 'one\ntwo\nthree\n', 'one\nchanged\nthree\n'],
  ['insertion into empty', '', 'first\nsecond'],
  ['deletion to empty', 'first\nsecond', ''],
  ['CRLF source', 'one\r\ntwo\r\n', 'one\r\nchanged\r\n'],
  ['no trailing newline', 'one\ntwo', 'one\nlast'],
  ['Unicode', 'Maria 😀\n', 'María 🚪\n'],
]) {
  test(`strict unified diff round-trips ${name}`, () => {
    const patch = createUnifiedDiff(before, after);
    assert.equal(applyUnifiedDiff(before, patch), after);
  });
}

test('strict patch application refuses an unexpected base', () => {
  const patch = createUnifiedDiff('one\ntwo\n', 'one\nchanged\n');
  assert.throws(
    () => applyUnifiedDiff('one\nother\n', patch),
    (error) => error instanceof PatchError && error.code === 'BASE_MISMATCH',
  );
});

test('random diff/apply sequences reconstruct exact UTF-16 source', () => {
  let seed = 0xdecafbad;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  const pieces = ['word', 'line\n', 'crlf\r\n', '😀', '', '# heading\n'];
  for (let sample = 0; sample < 1_000; sample += 1) {
    const before = Array.from({ length: Math.floor(random() * 20) }, () => pieces[Math.floor(random() * pieces.length)]).join('');
    const after = Array.from({ length: Math.floor(random() * 20) }, () => pieces[Math.floor(random() * pieces.length)]).join('');
    assert.equal(applyUnifiedDiff(before, createUnifiedDiff(before, after)), after);
  }
});

test('history commits reconstruct, checkpoint, and preserve branches', async () => {
  const history = await createHistory('# One\n', {
    timestamp: '2026-09-18T10:00:00.000Z',
    checkpointInterval: 3,
  });
  await commitRevision(history, '# One\n', '# One\nText.\n', {
    timestamp: '2026-09-18T10:01:00.000Z', origin: 'user',
  });
  await commitRevision(history, '# One\nText.\n', '# One\nText changed.\n', {
    timestamp: '2026-09-18T10:02:00.000Z', origin: 'agent',
  });
  assert.equal(await reconstructRevision(history, 2), '# One\nText changed.');

  history.currentRevision = 1;
  await commitRevision(history, '# One\nText.\n', '# One\nAlternative.\n', {
    timestamp: '2026-09-18T10:03:00.000Z', origin: 'user',
  });
  assert.equal(history.revisions.get(3).payloadType, 'checkpoint');
  assert.deepEqual(childrenOf(history, 1).map(({ id }) => id), [2, 3]);
  assert.equal(await reconstructRevision(history, 2), '# One\nText changed.');
  assert.equal(await reconstructRevision(history, 3), '# One\nAlternative.');
});

test('history serialization round-trips exact checkpoints, patches, notes, and current node', async () => {
  const initial = '# Chapter\n```\nembedded fence\n```';
  const history = await createHistory(initial, {
    timestamp: '2026-09-18T10:00:00.000Z', checkpointInterval: 50,
  });
  await commitRevision(history, initial, `${initial}\nNew ending.`, {
    timestamp: '2026-09-18T10:01:00.000Z', note: 'Added the ending.',
  });
  const serialized = serializeHistory(history);
  const parsed = parseHistory(serialized);
  assert.equal(parsed.currentRevision, 1);
  assert.equal(parsed.checkpointInterval, 50);
  assert.equal(parsed.revisions.get(0).payload, initial);
  assert.equal(parsed.revisions.get(1).note, 'Added the ending.');
  assert.equal(await reconstructRevision(parsed, 1), `${initial}\nNew ending.`);
  assert.equal(serializeHistory(parsed), serialized);
});

test('root-scoped VERSIONS graphs use canonical Setext groups and round-trip independently', async () => {
  const story = await createHistory('Story base\n');
  const metadata = await createHistory('# Characters\n');
  await commitRevision(story, 'Story base\n', 'Story changed\n');
  await commitRevision(metadata, '# Characters\n', '# Characters\n\nMaria\n');
  const source = serializeHistories({ STORY: story, METADATA: metadata });
  assert.match(source, /^STORY:REV\n---------$/m);
  assert.match(source, /^METADATA:REV\n------------$/m);
  assert.match(source, /^## Revision 0$/m);
  const parsed = parseHistories(source);
  assert.equal(parsed.legacy, false);
  assert.equal(await reconstructRevision(parsed.STORY, 1), 'Story changed');
  assert.equal(await reconstructRevision(parsed.METADATA, 1), '# Characters\n\nMaria');
  assert.throws(() => parseHistories(serializeHistory(story)));
});

test('reconstruction detects corrupted patches and result hashes', async () => {
  const history = await createHistory('base\n');
  await commitRevision(history, 'base\n', 'result\n');
  history.revisions.get(1).payload = history.revisions.get(1).payload.replace('-base', '-wrong');
  await assert.rejects(
    reconstructRevision(history, 1),
    (error) => error instanceof HistoryError && error.code === 'PATCH_FAILED',
  );

  const other = await createHistory('base\n');
  other.revisions.get(0).resultHash = '0'.repeat(64);
  await assert.rejects(
    reconstructRevision(other, 0),
    (error) => error instanceof HistoryError && error.code === 'RESULT_HASH_MISMATCH',
  );
});

test('current STORY verification distinguishes legitimate external edits', async () => {
  const history = await createHistory('# Story\nOriginal.\n');
  assert.equal((await verifyCurrentStory(history, '# Story\nOriginal.\n')).matches, true);
  const mismatch = await verifyCurrentStory(history, '# Story\nEdited outside.\n');
  assert.equal(mismatch.matches, false);
  assert.equal(mismatch.recordedStory, '# Story\nOriginal.');
  assert.equal(mismatch.externalStory, '# Story\nEdited outside.');

  const revision = await recordExternalEdit(history, mismatch.externalStory, {
    timestamp: '2026-09-18T11:00:00.000Z',
  });
  assert.equal(revision.origin, 'recovery');
  assert.equal(await reconstructRevision(history, revision.id), mismatch.externalStory);
  assert.equal((await verifyCurrentStory(history, mismatch.externalStory)).matches, true);
});

test('metadata-root recovery uses the same strict graph contract', async () => {
  const history = await createHistory('# Characters\n\nMaria.\n');
  const external = '# Characters\n\nMaria, an archivist.\n';
  const mismatch = await verifyCurrentStory(history, external);
  assert.equal(mismatch.matches, false);
  const revision = await recordExternalEdit(history, external);
  assert.equal(revision.origin, 'recovery');
  assert.equal(await reconstructRevision(history, history.currentRevision), external.trim());
});

test('parser rejects duplicate IDs and missing parents', async () => {
  const history = await createHistory('text');
  const serialized = serializeHistory(history);
  const duplicate = `${serialized}\n${serialized.slice(serialized.indexOf('# Revision 0'))}`;
  assert.throws(() => parseHistory(duplicate), (error) => error.code === 'DUPLICATE_REVISION');

  const missingParent = serialized.replace('Parents: none', 'Parents: 99');
  assert.throws(() => parseHistory(missingParent), (error) => error.code === 'MISSING_PARENT');
});

test('commit refuses a base that differs from the recorded parent', async () => {
  const history = await createHistory('recorded');
  await assert.rejects(
    commitRevision(history, 'different', 'result'),
    (error) => error.code === 'COMMIT_BASE_MISMATCH',
  );
});

test('reconstruction rejects revision cycles', async () => {
  const history = await createHistory('zero');
  await commitRevision(history, 'zero', 'one');
  history.revisions.get(0).parents = [1];
  history.revisions.get(0).baseHash = history.revisions.get(1).resultHash;
  await assert.rejects(
    reconstructRevision(history, 1),
    (error) => error.code === 'REVISION_CYCLE',
  );
});
