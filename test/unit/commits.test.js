import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StoryModel } from '../../src/renderer/editor/model.js';
import { CommitController } from '../../src/renderer/history/commits.js';
import { childrenOf, createHistory, reconstructRevision } from '../../src/renderer/history/graph.js';

function fakeTimers() {
  let callback = null;
  return {
    setTimeout(next) { callback = next; return 1; },
    clearTimeout() { callback = null; },
    async fire() {
      const next = callback;
      callback = null;
      await next?.();
    },
    hasTimer() { return callback !== null; },
  };
}

async function setup(story = 'base') {
  const history = await createHistory(story, { timestamp: '2026-09-18T00:00:00.000Z' });
  const model = new StoryModel(story);
  const timers = fakeTimers();
  const controller = new CommitController({ history, model, timers, idleDelay: 45_000 });
  return { history, model, timers, controller };
}

test('user edits stay transient until explicit save commits one authorship interval', async () => {
  const { history, model, controller, timers } = await setup();
  model.replace(4, 4, ' one');
  model.replace(8, 8, ' two');
  assert.equal(history.revisions.size, 1);
  assert.equal(timers.hasTimer(), true);
  const revision = await controller.explicitSave('Drafted two words.');
  assert.equal(revision.id, 1);
  assert.equal(revision.note, 'Drafted two words.');
  assert.equal(await reconstructRevision(history, 1), 'base one two\n');
});

test('idle, close, and structural boundaries commit pending work', async () => {
  const idle = await setup();
  idle.model.replace(4, 4, ' idle');
  await idle.timers.fire();
  assert.equal(idle.history.revisions.size, 2);

  const closing = await setup();
  closing.model.replace(4, 4, ' close');
  await closing.controller.closeOrSwitch();
  assert.equal(closing.history.revisions.size, 2);

  const structural = await setup();
  structural.controller.structuralThreshold = 5;
  structural.model.replace(4, 4, ' large paste');
  await structural.controller.commitInFlight;
  assert.equal(structural.history.revisions.size, 2);
});

test('commitPending waits for an already in-flight commit instead of returning past it', async () => {
  const { history, model, controller } = await setup();
  controller.structuralThreshold = 5;
  // Triggers #modelChanged's fire-and-forget structural commit: `pending`
  // flips false synchronously, but commitRevision itself is still queued on
  // commitInFlight when control returns here.
  model.replace(4, 4, ' large paste');
  assert.equal(controller.pending, false);
  assert.equal(history.revisions.size, 1); // not landed yet

  // A caller relying on "nothing pending" (e.g. beforeAgentRequest, right
  // before reading history.currentRevision) must still observe the settled
  // state, not race past the queued commit.
  await controller.commitPending();
  assert.equal(history.revisions.size, 2);
  assert.equal(await reconstructRevision(history, history.currentRevision), model.text);
});

test('undo and redo walk the durable graph and commit pending edits first', async () => {
  const { history, model, controller } = await setup();
  model.replace(4, 4, ' one');
  model.replace(8, 8, ' two');
  const result = await controller.undo();
  assert.deepEqual(result, { type: 'history', revisionId: 0 });
  assert.equal(model.text, 'base\n');
  assert.equal(history.currentRevision, 0);
  assert.deepEqual(await controller.redo(), { type: 'history', revisionId: 1 });
  assert.equal(model.text, 'base one two\n');
});

test('edits made through a local undo are still committed', async () => {
  const { history, model, controller } = await setup();
  model.replace(4, 4, ' one');
  await controller.explicitSave();
  model.replace(8, 8, ' two', { origin: 'edit-context' });
  await controller.explicitSave();
  model.replace(8, 12, '', { origin: 'local-undo' });
  await controller.explicitSave();
  assert.equal(await reconstructRevision(history, history.currentRevision), 'base one\n');
});

test('user→agent and agent→user transitions create distinct ordered revisions', async () => {
  const { history, model, controller } = await setup();
  model.replace(4, 4, ' user');
  const agent = await controller.applyAgentStory('agent result', {
    timestamp: '2026-09-18T00:02:00.000Z',
  });
  assert.equal(agent.origin, 'agent');
  assert.deepEqual([...history.revisions.values()].map(({ origin }) => origin), ['import', 'user', 'agent']);
  assert.equal(await reconstructRevision(history, 1), 'base user\n');
  assert.equal(await reconstructRevision(history, 2), 'agent result\n');
  assert.equal(model.text, 'agent result\n');
});

test('editing after undo preserves the abandoned branch and requires Redo choice', async () => {
  const { history, model, controller } = await setup();
  model.replace(4, 4, ' first');
  await controller.explicitSave();
  await controller.undo();
  model.replace(4, 4, ' alternative');
  await controller.explicitSave();
  await controller.undo();

  const children = childrenOf(history, 0);
  assert.deepEqual(children.map(({ id }) => id), [1, 2]);
  const redo = await controller.redo();
  assert.equal(redo.type, 'choose');
  assert.deepEqual(redo.choices.map(({ id }) => id), [1, 2]);
  assert.equal(history.currentRevision, 0);
  assert.equal(model.text, 'base\n');

  assert.deepEqual(await controller.redo(2), { type: 'history', revisionId: 2 });
  assert.equal(model.text, 'base alternative\n');
  assert.equal(await reconstructRevision(history, 1), 'base first\n');
});

test('no-op edits do not create durable revisions', async () => {
  const { history, model, controller } = await setup();
  model.replace(0, 4, 'base');
  assert.equal(await controller.explicitSave(), null);
  assert.equal(history.revisions.size, 1);
});

test('normalizing the model on commit keeps the selection and adds the empty last row after the caret', async () => {
  const { model, controller } = await setup('The window broke.');
  model.replace(0, 0, '');
  model.replace(17, 17, ' Loudly.', { selectionStart: 4, selectionEnd: 10 });
  assert.equal(model.text, 'The window broke. Loudly.');
  await controller.explicitSave();
  assert.equal(model.text, 'The window broke. Loudly.\n');
  assert.deepEqual([model.selectionStart, model.selectionEnd], [4, 10]);
  model.replace(model.text.length, model.text.length, '', { selectionStart: 25, selectionEnd: 25 });
  model.replace(25, 25, '\n\n\n');
  await controller.explicitSave();
  assert.equal(model.text, 'The window broke. Loudly.\n');
  // The caret was inside the collapsed trailing rows, so it lands on the one remaining empty row.
  assert.deepEqual([model.selectionStart, model.selectionEnd], [26, 26]);
});
