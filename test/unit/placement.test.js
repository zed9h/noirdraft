import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyPlacement, renderInline } from '../../src/renderer/ai/placement.js';

const doc = 'First paragraph here.\n\nSecond paragraph, longer.\nWith two lines.\n\n\nThird.';
const at = (needle) => doc.indexOf(needle);

test('a selection inside a paragraph is a short edit', () => {
  assert.equal(classifyPlacement(doc, at('paragraph here'), at('paragraph here') + 9), 'short');
  assert.equal(classifyPlacement(doc, at('First'), at('First') + 5), 'short');
});

test('a selection that covers whole paragraphs is a block edit', () => {
  assert.equal(classifyPlacement(doc, 0, at('\n\nSecond')), 'block');
  assert.equal(classifyPlacement(doc, at('Second'), at('\n\n\nThird')), 'block');
  assert.equal(classifyPlacement(doc, at('Second'), at('Third') + 6), 'block');
  assert.equal(classifyPlacement(doc, 0, at('Second')), 'block');
});

test('a selection that starts or ends mid-paragraph is short even across paragraphs', () => {
  assert.equal(classifyPlacement(doc, at('paragraph here'), at('Second') + 3), 'short');
});

test('a cursor on a non-empty line is short, even at its start or end; only a blank line is block', () => {
  assert.equal(classifyPlacement(doc, at('paragraph here'), at('paragraph here')), 'short');
  assert.equal(classifyPlacement(doc, 0, 0), 'short');
  assert.equal(classifyPlacement(doc, at('here.') + 5, at('here.') + 5), 'short');
  assert.equal(classifyPlacement(doc, at('With'), at('With')), 'short');
  assert.equal(classifyPlacement(doc, at('\n\nSecond') + 1, at('\n\nSecond') + 1), 'block');
  assert.equal(classifyPlacement(doc, doc.length, doc.length), 'short');
  assert.equal(classifyPlacement('', 0, 0), 'block');
  assert.equal(classifyPlacement('Line one.\n', 10, 10), 'block');
});

test('renderInline brackets the text and elides long context', () => {
  assert.equal(renderInline({ before: 'She said, ', text: 'nothing', after: ' at all.' }), 'She said, ⟦nothing⟧ at all.');
  const long = renderInline({ before: 'a'.repeat(300), text: 'X', after: 'b'.repeat(300), width: 10 });
  assert.equal(long, `…${'a'.repeat(10)}⟦X⟧${'b'.repeat(10)}…`);
});
