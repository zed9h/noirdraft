import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commitRevision, createHistory } from '../../src/renderer/history/graph.js';
import { excerptAround, findTextMatches, searchHistory } from '../../src/renderer/search.js';

test('findTextMatches is case-insensitive, non-overlapping, and empty for a blank query', () => {
  assert.deepEqual(findTextMatches('Rain rain RAIN', 'rain'), [
    { from: 0, to: 4 }, { from: 5, to: 9 }, { from: 10, to: 14 },
  ]);
  assert.deepEqual(findTextMatches('aaaa', 'aa'), [{ from: 0, to: 2 }, { from: 2, to: 4 }]);
  assert.deepEqual(findTextMatches('anything', ''), []);
});

test('findTextMatches reports UTF-16 offsets', () => {
  assert.deepEqual(findTextMatches('😀 gun', 'gun'), [{ from: 3, to: 6 }]);
});

test('excerptAround flattens whitespace and marks truncation', () => {
  const text = `${'x'.repeat(50)}\nneedle\n${'y'.repeat(50)}`;
  const excerpt = excerptAround(text, { from: 51, to: 57 }, 5);
  assert.equal(excerpt.hit, 'needle');
  assert.ok(excerpt.before.startsWith('…') && excerpt.after.endsWith('…'));
  assert.ok(!/\n/.test(excerpt.before + excerpt.after));
});

test('searchHistory matches notes and change sets, oldest first, and says which', async () => {
  const history = await createHistory('one\n');
  await commitRevision(history, 'one\n', 'one\ntwo lantern\n', { note: 'Added a scene' });
  await commitRevision(history, 'one\ntwo lantern\n', 'one\ntwo lantern\nthree\n', { note: 'lantern polish' });
  const results = searchHistory(history, 'LANTERN');
  assert.deepEqual(results.map(({ revision }) => revision.id), [1, 2]);
  assert.equal(results[0].where, 'change');
  assert.equal(results[1].where, 'note');
  assert.deepEqual(searchHistory(history, '  '), []);
});

test('paragraphRange spans the blank-line-delimited paragraph around an offset', async () => {
  const { paragraphRange } = await import('../../src/renderer/search.js');
  const text = 'first\n\nsecond line\nstill second\n\nthird';
  assert.deepEqual(paragraphRange(text, 10), { from: 7, to: 31 });
  assert.deepEqual(paragraphRange(text, 0), { from: 0, to: 5 });
  assert.deepEqual(paragraphRange(text, text.length), { from: 33, to: text.length });
});
