import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commitRevision, createHistory } from '../../src/renderer/history/graph.js';
import { edgePath, layoutRevisionGraph, secondaryEdgePath } from '../../src/renderer/history/graph-layout.js';

test('layoutRevisionGraph centres parents over children and keeps secondary parents left of their child', async () => {
  const history = await createHistory('a\n', { checkpointInterval: 1000 });
  await commitRevision(history, 'a\n', 'a\nb\n', { note: 'b' });
  await commitRevision(history, 'a\nb\n', 'a\nb\nc\n', { note: 'c' });
  history.currentRevision = 1;
  await commitRevision(history, 'a\nb\n', 'a\nb\nd\n', { note: 'd', secondaryParents: [2] });
  const layout = layoutRevisionGraph(history);
  const at = (id) => layout.positions.get(id);
  assert.equal(at(0).x, 0);
  assert.ok(at(1).x > at(0).x);
  assert.ok(at(3).x > at(2).x, 'secondary parent is left of the child');
  assert.equal(at(1).y, (at(2).y + at(3).y) / 2, 'parent is centred over its two children');
  assert.deepEqual(layout.edges.filter((edge) => edge.secondary), [{ from: 2, to: 3, secondary: true }]);
});

test('edgePath is a horizontal-tangent cubic curve', () => {
  assert.equal(edgePath({ x: 0, y: 0 }, { x: 100, y: 60 }), 'M0 0C50 0 50 60 100 60');
});

test('secondaryEdgePath leaves forward at 45 degrees and reaches the receiver from behind, on the supplier side', () => {
  const parse = (path) => path.match(/-?\d+(\.\d+)?/g).map(Number);
  const down = parse(secondaryEdgePath({ x: 0, y: 0 }, { x: 96, y: 60 }));
  assert.ok(down[0] > 0 && down[1] > 0, 'starts forward and down of the supplier');
  assert.ok(down[2] > down[0] && down[3] - down[1] === down[2] - down[0], 'first control is on the 45 degree line');
  assert.ok(down[6] < 96 && down[7] < 60, 'ends behind and above the receiver');
  const up = parse(secondaryEdgePath({ x: 0, y: 60 }, { x: 96, y: 0 }));
  assert.ok(up[1] < 60, 'starts forward and up of the supplier');
  assert.ok(up[6] < 96 && up[7] > 0, 'ends behind and below the receiver');
});
