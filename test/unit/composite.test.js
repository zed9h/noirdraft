import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adoptIntoComposite } from '../../src/renderer/history/composite.js';

test('adopting a hunk replaces the range and records exact provenance', () => {
  const text = 'The room was cold. She sat down.';
  const result = adoptIntoComposite(text, [], {
    from: 0,
    to: 'The room was cold.'.length,
    replacement: 'The room felt like a tomb.',
    sourceRevisionId: 3,
    sourceRange: [0, 19],
  });
  assert.equal(result.text, 'The room felt like a tomb. She sat down.');
  assert.deepEqual(result.provenance, [
    { sourceRevisionId: 3, sourceRange: [0, 19], resultRange: [0, 'The room felt like a tomb.'.length] },
  ]);
});

test('a later adoption shifts unrelated earlier provenance by the exact length delta', () => {
  const text = 'AAAA BBBB CCCC';
  const first = adoptIntoComposite(text, [], {
    from: 5, to: 9, replacement: 'X', sourceRevisionId: 1, sourceRange: [0, 4],
  });
  assert.equal(first.text, 'AAAA X CCCC');
  assert.deepEqual(first.provenance, [{ sourceRevisionId: 1, sourceRange: [0, 4], resultRange: [5, 6] }]);

  // Editing before the first adoption's range must shift it by the delta.
  const second = adoptIntoComposite(first.text, first.provenance, {
    from: 0, to: 4, replacement: 'LONGER', sourceRevisionId: 2, sourceRange: [10, 14],
  });
  assert.equal(second.text, 'LONGER X CCCC');
  assert.deepEqual(second.provenance, [
    { sourceRevisionId: 1, sourceRange: [0, 4], resultRange: [7, 8] },
    { sourceRevisionId: 2, sourceRange: [10, 14], resultRange: [0, 6] },
  ]);
});

test('an adoption overlapping earlier provenance supersedes it rather than leaving a stale entry', () => {
  const text = 'one two three';
  const first = adoptIntoComposite(text, [], {
    from: 4, to: 7, replacement: 'TWO', sourceRevisionId: 1, sourceRange: [0, 3],
  });
  const second = adoptIntoComposite(first.text, first.provenance, {
    from: 0, to: 'one TWO'.length, replacement: 'ONE-AND-TWO', sourceRevisionId: 2, sourceRange: [0, 7],
  });
  assert.deepEqual(second.provenance, [
    { sourceRevisionId: 2, sourceRange: [0, 7], resultRange: [0, 'ONE-AND-TWO'.length] },
  ]);
});

test('provenance is unrelated to ancestry: adopting from several revisions never implies several parents', () => {
  // adoptIntoComposite never touches history/parents at all — it only ever
  // returns { text, provenance }, confirming provenance carries no ancestry.
  const result = adoptIntoComposite('abc', [], {
    from: 0, to: 1, replacement: 'X', sourceRevisionId: 42, sourceRange: [0, 1],
  });
  assert.deepEqual(Object.keys(result).sort(), ['provenance', 'text']);
});
