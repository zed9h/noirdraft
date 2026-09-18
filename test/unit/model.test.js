import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StoryModel } from '../../src/renderer/editor/model.js';

test('replace is the single text mutation and uses UTF-16 offsets', () => {
  const model = new StoryModel('A😀B', 1, 3);
  const changes = [];
  model.subscribe((snapshot, change) => changes.push({ snapshot, change }));

  const change = model.replace(1, 3, 'é');

  assert.equal(model.text, 'AéB');
  assert.deepEqual([model.selectionStart, model.selectionEnd], [2, 2]);
  assert.equal(change.removed, '😀');
  assert.equal(change.inserted, 'é');
  assert.equal(changes.length, 1);
});

test('replace clamps ranges and selection to canonical text', () => {
  const model = new StoryModel('abc');
  model.replace(-10, 20, 'x', { selectionStart: 99, selectionEnd: 100 });
  assert.deepEqual(model.snapshot(), { text: 'x', selectionStart: 1, selectionEnd: 1 });
});

test('selection is ordered, bounded, and does not mutate text', () => {
  const model = new StoryModel('abcd');
  assert.equal(model.setSelection(1, 3), true);
  assert.deepEqual(model.snapshot(), { text: 'abcd', selectionStart: 1, selectionEnd: 3 });
  assert.equal(model.setSelection(1, 3), false);
  model.setSelection(8, 9);
  assert.deepEqual(model.snapshot(), { text: 'abcd', selectionStart: 4, selectionEnd: 4 });
});

test('random replacement sequences preserve text and selection invariants', () => {
  let seed = 0x5eed1234;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  const fragments = ['', 'x', '\n', '**', '😀', 'é', '# Heading\n'];
  const model = new StoryModel('seed');
  let expected = 'seed';

  for (let index = 0; index < 2_000; index += 1) {
    const first = Math.floor(random() * (expected.length + 1));
    const second = Math.floor(random() * (expected.length + 1));
    const from = Math.min(first, second);
    const to = Math.max(first, second);
    const inserted = fragments[Math.floor(random() * fragments.length)];
    expected = expected.slice(0, from) + inserted + expected.slice(to);
    model.replace(from, to, inserted);
    assert.equal(model.text, expected);
    assert.ok(model.selectionStart >= 0 && model.selectionStart <= model.text.length);
    assert.ok(model.selectionEnd >= model.selectionStart && model.selectionEnd <= model.text.length);
  }
});
