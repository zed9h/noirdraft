import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INLINE_WORD_LIMIT, classifyPlacement, renderInline } from '../../src/renderer/ai/placement.js';

const doc = 'First paragraph here.\n\nSecond paragraph, longer.\nWith two lines.\n\n\nThird.';
const at = (needle) => doc.indexOf(needle);

test('a selection inside a paragraph uses the inline flow', () => {
  assert.equal(classifyPlacement(doc, at('paragraph here'), at('paragraph here') + 9), 'inline');
  assert.equal(classifyPlacement(doc, at('First'), at('First') + 5), 'inline');
});

const longDoc = `${'Word '.repeat(INLINE_WORD_LIMIT).trim()}.\n\n${'Other '.repeat(INLINE_WORD_LIMIT).trim()}.\n\nEnd.`;

test('a selection that covers whole long paragraphs is a block edit', () => {
  assert.equal(classifyPlacement(longDoc, 0, longDoc.indexOf('\n\nOther')), 'block');
  assert.equal(classifyPlacement(longDoc, longDoc.indexOf('Other'), longDoc.indexOf('\n\nEnd')), 'block');
  assert.equal(classifyPlacement(longDoc, 0, longDoc.indexOf('End')), 'block');
});

test('whole paragraphs shorter than the word limit use the inline flow', () => {
  assert.equal(classifyPlacement(doc, 0, at('\n\nSecond')), 'inline');
  assert.equal(classifyPlacement(doc, at('Second'), at('\n\n\nThird')), 'inline');
});

test('a selection that starts or ends mid-paragraph uses the inline flow even across paragraphs', () => {
  assert.equal(classifyPlacement(doc, at('paragraph here'), at('Second') + 3), 'inline');
});

test('a cursor on a non-empty line is short, even at its start or end; only a blank line is block', () => {
  assert.equal(classifyPlacement(doc, at('paragraph here'), at('paragraph here')), 'inline');
  assert.equal(classifyPlacement(doc, 0, 0), 'inline');
  assert.equal(classifyPlacement(doc, at('here.') + 5, at('here.') + 5), 'inline');
  assert.equal(classifyPlacement(doc, at('With'), at('With')), 'inline');
  assert.equal(classifyPlacement(doc, at('\n\nSecond') + 1, at('\n\nSecond') + 1), 'block');
  assert.equal(classifyPlacement(doc, doc.length, doc.length), 'inline');
  assert.equal(classifyPlacement('', 0, 0), 'block');
  assert.equal(classifyPlacement('Line one.\n', 10, 10), 'block');
});

test('renderInline brackets the text and elides long context', () => {
  assert.equal(renderInline({ before: 'She said, ', text: 'nothing', after: ' at all.' }), 'She said, ⟦nothing⟧ at all.');
  const long = renderInline({ before: 'a'.repeat(300), text: 'X', after: 'b'.repeat(300), width: 10 });
  assert.equal(long, `…${'a'.repeat(10)}⟦X⟧${'b'.repeat(10)}…`);
});
