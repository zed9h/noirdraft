import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StoryModel } from '../../src/renderer/editor/model.js';
import { UndoStack } from '../../src/renderer/editor/undo-stack.js';

test('undo and redo step back and forth through the author\'s edits', () => {
  const model = new StoryModel('base');
  const stack = new UndoStack(model);
  model.replace(4, 4, ' one', { origin: 'edit-context' });
  model.replace(8, 8, ' two', { origin: 'edit-context' });
  assert.equal(stack.undo(), true);
  assert.equal(model.text, 'base one');
  assert.equal(stack.undo(), true);
  assert.equal(model.text, 'base');
  assert.equal(stack.undo(), false);
  assert.equal(stack.redo(), true);
  assert.equal(stack.redo(), true);
  assert.equal(model.text, 'base one two');
  assert.equal(stack.redo(), false);
});

test('a new edit drops the redo branch; outside changes empty the stack', () => {
  const model = new StoryModel('base');
  const stack = new UndoStack(model);
  model.replace(4, 4, ' one', { origin: 'edit-context' });
  stack.undo();
  model.replace(4, 4, ' other', { origin: 'edit-context' });
  assert.equal(stack.redo(), false);
  model.replace(0, model.text.length, 'from history', { origin: 'checkout' });
  assert.equal(stack.undo(), false);
});
