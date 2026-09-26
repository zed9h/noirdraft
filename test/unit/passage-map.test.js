import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapSelectionToRevision } from '../../src/renderer/history/passage-map.js';

const passage = (current, historical, needle) => {
  const from = current.indexOf(needle);
  const range = mapSelectionToRevision(current, historical, [from, from + needle.length]);
  return historical.slice(...range);
};

test('mapSelectionToRevision maps a selected phrase to exactly its historical counterpart', () => {
  const current = 'Maria walked in slowly.\n\nElias watched intently.\n';
  const historical = 'Maria strode in.\n\nElias watched.\n';
  assert.equal(passage(current, historical, 'walked'), 'strode');
  assert.equal(passage(current, historical, 'Maria walked in slowly.'), 'Maria strode in.');
  assert.equal(passage(current, historical, 'intently'), '');
});

test('mapSelectionToRevision leaves text merely added after the selection out, and keeps what the selection covered', () => {
  assert.equal(passage('He ran home.\n', 'He ran home, tired.\n', 'He ran home'), 'He ran home');
  assert.equal(passage('He ran home.\n', 'He ran very fast home.\n', 'ran'), 'ran');
  assert.equal(passage('He ran home.\n', 'He ran very fast home.\n', 'ran home'), 'ran very fast home');
});

test('mapSelectionToRevision is exact when nothing differs around the selection', () => {
  const text = 'One.\n\nTwo.\n\nThree.\n';
  assert.equal(passage(text, text, 'Two.'), 'Two.');
});

test('mapSelectionToRevision handles a selection that stops before punctuation', () => {
  assert.equal(passage('Maria walked in slowly.\n', 'Maria walked in.\n', 'Maria walked in slowly'), 'Maria walked in');
});
