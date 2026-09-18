import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wordDiff } from '../../src/renderer/history/word-diff.js';

function reassemble(ops, side) {
  return ops.filter((op) => op.type === 'equal' || op.type === side).map((op) => op.text).join('');
}

test('wordDiff reconstructs both sides exactly from its ops', () => {
  const before = 'Maria walked in slowly, hesitant.';
  const after = 'Maria walked in.';
  const ops = wordDiff(before, after);
  assert.equal(reassemble(ops, 'delete'), before);
  assert.equal(reassemble(ops, 'insert'), after);
});

test('wordDiff highlights only the changed word, keeping surrounding context equal', () => {
  const ops = wordDiff('The rain had stopped.', 'The rain had continued.');
  const changed = ops.filter((op) => op.type !== 'equal');
  assert.equal(changed.length, 2);
  assert.equal(changed[0].type, 'delete');
  assert.equal(changed[0].text, 'stopped.');
  assert.equal(changed[1].type, 'insert');
  assert.equal(changed[1].text, 'continued.');
  assert.ok(ops.some((op) => op.type === 'equal' && op.text.includes('rain')));
});

test('wordDiff returns a single equal run for identical text', () => {
  const ops = wordDiff('No change here.', 'No change here.');
  assert.deepEqual(ops, [{ type: 'equal', text: 'No change here.' }]);
});

test('wordDiff handles empty inputs', () => {
  assert.deepEqual(wordDiff('', ''), []);
  assert.deepEqual(wordDiff('', 'new text'), [{ type: 'insert', text: 'new text' }]);
  assert.deepEqual(wordDiff('old text', ''), [{ type: 'delete', text: 'old text' }]);
});
