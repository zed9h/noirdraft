import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commitRevision, createHistory } from '../../src/renderer/history/graph.js';
import { buildLocalGraph, searchRevisions } from '../../src/renderer/history/local-graph.js';

async function buildLinearHistory(length) {
  const history = await createHistory('v0\n', { checkpointInterval: 1000 });
  let text = 'v0\n';
  for (let index = 1; index < length; index += 1) {
    const next = `v${index}\n`;
    await commitRevision(history, text, next, { note: `note ${index}` });
    text = next;
  }
  return history;
}

test('buildLocalGraph includes only nodes within radius and reports the current node', async () => {
  const history = await buildLinearHistory(9); // revisions 0..8, current = 8
  const graph = buildLocalGraph(history, 5, { radius: 2 });
  assert.deepEqual(graph.nodes.map((node) => node.id).sort((a, b) => a - b), [3, 4, 5, 6, 7]);
  const center = graph.nodes.find((node) => node.id === 5);
  assert.equal(center.distance, 0);
  assert.equal(graph.nodes.find((node) => node.id === 5).isCurrent, false);

  const currentGraph = buildLocalGraph(history, history.currentRevision, { radius: 2 });
  assert.equal(currentGraph.nodes.find((node) => node.id === history.currentRevision).isCurrent, true);
});

test('buildLocalGraph reports jump edges with an exact hidden-node count in each direction', async () => {
  const history = await buildLinearHistory(9); // 0..8 linear
  const graph = buildLocalGraph(history, 5, { radius: 2 });
  const ancestorJump = graph.jumps.find((jump) => jump.direction === 'ancestor');
  const descendantJump = graph.jumps.find((jump) => jump.direction === 'descendant');
  assert.equal(ancestorJump.towardId, 2);
  assert.equal(ancestorJump.hiddenCount, 3); // revisions 0, 1, 2
  assert.equal(descendantJump.towardId, 8);
  assert.equal(descendantJump.hiddenCount, 1); // revision 8
});

test('buildLocalGraph exposes branch siblings and their own jump edges', async () => {
  const history = await createHistory('base\n', { checkpointInterval: 1000 });
  await commitRevision(history, 'base\n', 'a\n', { note: 'branch A' }); // 1
  history.currentRevision = 0;
  await commitRevision(history, 'base\n', 'b\n', { note: 'branch B' }); // 2
  const graph = buildLocalGraph(history, 0, { radius: 2 });
  assert.deepEqual(graph.nodes.map((node) => node.id).sort((a, b) => a - b), [0, 1, 2]);
  assert.equal(graph.jumps.length, 0);
});

test('buildLocalGraph never duplicates a node reachable through two paths', async () => {
  const history = await buildLinearHistory(3); // 0,1,2 — radius large enough to see all from center 1
  const graph = buildLocalGraph(history, 1, { radius: 5 });
  const ids = graph.nodes.map((node) => node.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids.sort((a, b) => a - b), [0, 1, 2]);
});

test('searchRevisions matches by id, origin, note, and timestamp, and is empty for a blank query', async () => {
  const history = await createHistory('base\n', { checkpointInterval: 1000, timestamp: '2026-09-18T10:00:00.000Z' });
  await commitRevision(history, 'base\n', 'a\n', {
    origin: 'agent', note: 'Shortened the confrontation.', timestamp: '2026-09-18T11:00:00.000Z',
  });
  assert.deepEqual(searchRevisions(history, '').map((r) => r.id), []);
  assert.deepEqual(searchRevisions(history, 'confrontation').map((r) => r.id), [1]);
  assert.deepEqual(searchRevisions(history, 'agent').map((r) => r.id), [1]);
  assert.deepEqual(searchRevisions(history, '11:00').map((r) => r.id), [1]);
});
