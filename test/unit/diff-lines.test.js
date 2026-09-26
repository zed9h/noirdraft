import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createUnifiedDiff } from '../../src/renderer/history/diff.js';
import { classifyPatch } from '../../src/renderer/history/diff-lines.js';

test('classifyPatch marks only the changed words of a rewritten row and whole rows that were only added', () => {
  const patch = createUnifiedDiff('# T\n\nMaria walked in.\n\nEnd.\n', '# T\n\nMaria strode in.\n\nNew line.\n\nEnd.\n', 1);
  const rows = classifyPatch(patch);
  assert.equal(rows[0].kind, 'hunk');
  const removed = rows.find((row) => row.kind === 'del');
  const added = rows.filter((row) => row.kind === 'add');
  assert.deepEqual(removed.segments.filter((s) => s.changed).map((s) => s.text), ['walked']);
  assert.deepEqual(added[0].segments.filter((s) => s.changed).map((s) => s.text), ['strode']);
  const fresh = added.find((row) => row.segments.map((s) => s.text).join('') === 'New line.');
  assert.ok(fresh.segments.every((s) => s.changed));
  assert.ok(rows.some((row) => row.kind === 'context'));
  // Prefixes are kept so the rows still read as the stored patch.
  assert.equal(rows.map((row) => row.prefix + row.segments.map((s) => s.text).join('')).join('\n') + '\n', patch);
});
