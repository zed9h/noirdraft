import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyOperations, budgetFor, cycleStatus, createNotebook, isEmptyNotebook, isPlaceholder, MAX_OPERATIONS, notebookText, placeholderIds, renderView, splitParagraphs } from '../../src/renderer/ai/notebook.js';

const make = (seed = 'One.\n\nTwo.\n\nThree.') => createNotebook({ id: 1, intent: 'Test.', targetWords: 300, seed });
const ids = (notebook) => notebook.paragraphs.map(({ id }) => id);

test('paragraphs split on blank lines only and keep internal line breaks', () => {
  assert.deepEqual(splitParagraphs('A\nline.\n\n\n  \nB.\n'), ['A\nline.', 'B.']);
  assert.deepEqual(splitParagraphs(''), []);
  assert.deepEqual(splitParagraphs('a\r\n\r\nb'), ['a', 'b']);
});

test('a notebook always keeps one paragraph and counts as empty until it has text', () => {
  const blank = make('');
  assert.equal(blank.paragraphs.length, 1);
  assert.ok(isEmptyNotebook(blank));
  const filled = applyOperations(blank, [{ op: 'replace', paragraph_id: 1, text: 'Hello.' }]);
  assert.equal(notebookText(filled.notebook), 'Hello.');
  const emptied = applyOperations(filled.notebook, [{ op: 'delete', paragraph_id: filled.notebook.paragraphs[0].id }]);
  assert.equal(emptied.notebook.paragraphs.length, 1);
  assert.ok(isEmptyNotebook(emptied.notebook));
});

test('ids are monotonic and never reused, and replacements expand into many paragraphs', () => {
  const start = make();
  const step = applyOperations(start, [{ op: 'replace', paragraph_id: 2, text: 'Two-a.\n\nTwo-b.' }]);
  assert.deepEqual(ids(step.notebook), [1, 4, 5, 3]);
  const next = applyOperations(step.notebook, [{ op: 'delete', paragraph_id: 4, through_paragraph_id: 5 }, { op: 'insert_after', paragraph_id: 3, text: 'Four.' }]);
  assert.deepEqual(ids(next.notebook), [1, 3, 6]);
  assert.equal(notebookText(next.notebook), 'One.\n\nThree.\n\nFour.');
});

test('range replace and insert_before work against the ids the model saw', () => {
  const result = applyOperations(make(), [{ op: 'replace', paragraph_id: 1, through_paragraph_id: 2, text: 'Merged.' }, { op: 'insert_before', paragraph_id: 3, text: 'Bridge.' }]);
  assert.equal(notebookText(result.notebook), 'Merged.\n\nBridge.\n\nThree.');
});

test('a bad batch is rejected atomically with constructive errors', () => {
  const start = make();
  const result = applyOperations(start, [{ op: 'replace', paragraph_id: 1, text: 'Fine.' }, { op: 'delete', paragraph_id: 99 }, { op: 'insert_after', paragraph_id: 1, text: '' }]);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /paragraph 99 is not in this notebook/);
  assert.match(result.errors.join('\n'), /needs text/);
  assert.match(result.errors.join('\n'), /smaller edits/);
  assert.equal(notebookText(start), 'One.\n\nTwo.\n\nThree.');
});

test('overlapping operations and anchors on removed paragraphs are rejected', () => {
  const overlap = applyOperations(make(), [{ op: 'replace', paragraph_id: 1, through_paragraph_id: 2, text: 'X.' }, { op: 'delete', paragraph_id: 2 }]);
  assert.match(overlap.errors.join('\n'), /already changed/);
  const anchor = applyOperations(make(), [{ op: 'insert_after', paragraph_id: 2, text: 'X.' }, { op: 'delete', paragraph_id: 2 }]);
  assert.match(anchor.errors.join('\n'), /neighbouring paragraph/);
});

test('oversized batches are told to make smaller edits with placeholders', () => {
  const operations = Array.from({ length: MAX_OPERATIONS + 1 }, () => ({ op: 'delete', paragraph_id: 1 }));
  assert.match(applyOperations(make(), operations).errors[0], /placeholder/);
});

test('placeholders are whole paragraphs wrapped in brackets', () => {
  assert.ok(isPlaceholder('[Describe the rain.]'));
  assert.ok(!isPlaceholder('"[sic]," he said.'));
  const result = applyOperations(make(), [{ op: 'replace', paragraph_id: 2, text: '[Expand the confrontation.]' }]);
  assert.deepEqual(placeholderIds(result.notebook), [4]);
});

test('edits are tracked since the last view, and applying one bumps the count', () => {
  const edited = applyOperations(make(), [{ op: 'replace', paragraph_id: 2, text: 'New.' }]).notebook;
  assert.equal(edited.editsSinceView, 1);
  assert.equal(edited.needsView, true);
  const twice = applyOperations(edited, [{ op: 'replace', paragraph_id: 4, text: 'Newer.' }]).notebook;
  assert.equal(twice.editsSinceView, 2);
});

test('budget grows superlinearly and the hard ceiling is generously larger', () => {
  const small = budgetFor(100); const large = budgetFor(2000);
  assert.ok(small.hard > small.soft * 2);
  assert.ok(large.soft > small.soft * 5);
  const notebook = { ...make(), cycles: 0 };
  assert.match(cycleStatus(notebook), /^Cycle 0 of about/);
  assert.match(cycleStatus({ ...notebook, cycles: notebook.budget.soft }), /past the soft target/);
  assert.match(cycleStatus({ ...notebook, cycles: notebook.budget.hard }), /hard limit .* reached/);
});

test('the draft view shows intents, read-only context, ids, and checks', () => {
  const first = applyOperations(make(), [{ op: 'replace', paragraph_id: 3, text: '[Write the ending.]' }]).notebook;
  const other = { ...createNotebook({ id: 2, intent: 'A bleaker take.', targetWords: 300, seed: '' }) };
  const form = renderView({ grandIntent: 'Three takes on the scene.', notebooks: [first, other], activeId: 1, before: 'Before text.', after: 'After text.', guidance: 'Manager: keep going.\n\nNext: view Draft 1.' });
  assert.match(form, /Overall intent: Three takes/);
  assert.match(form, /Draft 1 of 2 — Test\./);
  assert.match(form, /read-only/);
  assert.match(form, /\[¶4\] \(placeholder\)/);
  assert.doesNotMatch(form, /A bleaker take/);
  assert.match(form, /Placeholders still to write: ¶4/);
  assert.match(form, /Next: view Draft 1\./);
});

test('length nagging is firm when far under target', () => {
  const notebook = createNotebook({ id: 1, intent: 'x', targetWords: 400, seed: 'Only a few words here.' });
  assert.match(renderView({ grandIntent: 'g', notebooks: [notebook], activeId: 1 }), /Well under target: the author wants substantially more/);
  const mid = createNotebook({ id: 1, intent: 'x', targetWords: 30, seed: 'One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty.' });
  assert.match(renderView({ grandIntent: 'g', notebooks: [mid], activeId: 1 }), /Still short of the target: keep writing until it reaches about 30 words/);
});
