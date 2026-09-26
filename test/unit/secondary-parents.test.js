import assert from 'node:assert/strict';
import { test } from 'node:test';
import { childrenOf, commitRevision, createHistory, linkedChildrenOf, reconstructRevision } from '../../src/renderer/history/graph.js';
import { parseHistory, serializeHistory } from '../../src/renderer/history/serialize.js';
import { addPendingCopy, resolvePendingCopies } from '../../src/renderer/history/secondary-parents.js';
import { insertedPassages } from '../../src/renderer/history/word-diff.js';

test('a pasted copy links its source; deleted or unrelated copies do not', () => {
  const copies = [
    { sourceRevisionId: 3, text: 'The rain kept falling on the harbor all night.' },
    { sourceRevisionId: 5, text: 'A scratch idea that was deleted again.' },
  ];
  const base = 'Opening line.\n';
  const result = 'Opening line.\nThe rain kept falling on the harbor all night.\n';
  const { used, remaining } = resolvePendingCopies(copies, base, result);
  assert.deepEqual(used, [3]);
  assert.deepEqual(remaining.map(({ sourceRevisionId }) => sourceRevisionId), [5]);
});

test('a lightly edited paste still counts, and text already in the base does not', () => {
  const copies = [{ sourceRevisionId: 2, text: 'She walked slowly down the long corridor toward him.' }];
  assert.deepEqual(resolvePendingCopies(copies, 'x\n', 'x\nShe walked quickly down the long corridor toward him.\n').used, [2]);
  const already = 'She walked slowly down the long corridor toward him.\n';
  assert.deepEqual(resolvePendingCopies(copies, already, `${already}More.\n`).used, []);
});

test('pending copies ignore blank text and stay bounded', () => {
  assert.deepEqual(addPendingCopy([], { sourceRevisionId: 1, text: '  \n' }), []);
  let copies = [];
  for (let id = 0; id < 30; id += 1) copies = addPendingCopy(copies, { sourceRevisionId: id, text: `word${id}` });
  assert.equal(copies.length, 20);
  assert.equal(copies.at(-1).sourceRevisionId, 29);
});

test('insertedPassages returns only what was added', () => {
  assert.deepEqual(insertedPassages('One.\nTwo.\n', 'One.\nTwo.\nThree.\n'), ['Three.']);
  assert.deepEqual(insertedPassages('One two three.\n', 'One two four five three.\n'), ['four five']);
  assert.deepEqual(insertedPassages('One.\nTwo.\n', 'One.\n'), []);
  assert.deepEqual(insertedPassages('', 'All new.\n'), ['All new.']);
});

test('secondary parents are recorded, serialized, and never alter ancestry or reconstruction', async () => {
  const history = await createHistory('a\n', { checkpointInterval: 1000 });
  const one = await commitRevision(history, 'a\n', 'a\nb\n');
  history.currentRevision = 0;
  const two = await commitRevision(history, 'a\n', 'a\nc\nb\n', { secondaryParents: [1, 1, 0, 99] });
  assert.deepEqual(two.parents, [0, 1]);
  assert.deepEqual(childrenOf(history, 1), []);
  assert.deepEqual(linkedChildrenOf(history, 1).map(({ id }) => id), [2]);
  assert.equal(await reconstructRevision(history, two.id), 'a\nc\nb\n');
  const parsed = await parseHistory(serializeHistory(history));
  assert.deepEqual(parsed.revisions.get(2).parents, [0, 1]);
  assert.equal(await reconstructRevision(parsed, 2), 'a\nc\nb\n');
  assert.equal(one.id, 1);
});
