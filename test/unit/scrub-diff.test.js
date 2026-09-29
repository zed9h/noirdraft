import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scrubDocumentDiff } from '../../src/renderer/history/scrub-diff.js';

test('scrubDocumentDiff returns a single equal token for identical text', () => {
  const ops = scrubDocumentDiff('same text', 'same text');
  assert.deepEqual(ops, [{ type: 'equal', text: 'same text' }]);
});

test('scrubDocumentDiff returns nothing for two empty documents', () => {
  assert.deepEqual(scrubDocumentDiff('', ''), []);
});

test('scrubDocumentDiff keeps the shared prefix and suffix verbatim, diffing only the changed middle', () => {
  const ops = scrubDocumentDiff('The cat sat on the mat.', 'The cat lay on the mat.');
  assert.equal(ops[0].type, 'equal');
  assert.ok(ops[0].text.startsWith('The cat'));
  assert.ok(ops.some((op) => op.type === 'delete' && op.text.includes('sat')));
  assert.ok(ops.some((op) => op.type === 'insert' && op.text.includes('lay')));
  assert.equal(ops.at(-1).type, 'equal');
  assert.ok(ops.at(-1).text.endsWith('the mat.'));
});

test('scrubDocumentDiff reports a pure insertion as one insert token after the shared prefix', () => {
  const ops = scrubDocumentDiff('Hello world', 'Hello brave new world');
  assert.equal(ops[0].type, 'equal');
  const inserted = ops.find((op) => op.type === 'insert');
  assert.ok(inserted);
  assert.ok(inserted.text.includes('brave new'));
});

test('scrubDocumentDiff reports a pure deletion as one delete token', () => {
  const ops = scrubDocumentDiff('Hello brave new world', 'Hello world');
  const deleted = ops.find((op) => op.type === 'delete');
  assert.ok(deleted);
  assert.ok(deleted.text.includes('brave new'));
});
