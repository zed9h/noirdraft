import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commitRevision, createHistory } from '../../src/renderer/history/graph.js';
import { mapRange, passageHistory } from '../../src/renderer/history/lineage.js';

test('mapRange keeps an unchanged prefix range at identical offsets', () => {
  const before = '# Chapter\n\nAlpha.\n\nBeta.\n';
  const after = '# Chapter\n\nAlpha.\n\nBeta changed.\n';
  const range = [0, before.indexOf('Alpha.') + 'Alpha.'.length];
  const mapped = mapRange(before, after, range);
  assert.deepEqual(mapped, { status: 'unchanged', range });
});

test('mapRange shifts an unchanged suffix range by the exact length delta', () => {
  const before = 'Intro.\n\nMiddle.\n\nTail unchanged.\n';
  const after = 'Intro.\n\nMiddle rewritten completely.\n\nTail unchanged.\n';
  const tailStart = before.indexOf('Tail unchanged.');
  const range = [tailStart, before.length];
  const mapped = mapRange(before, after, range);
  const delta = after.length - before.length;
  assert.deepEqual(mapped, { status: 'shifted', range: [tailStart + delta, before.length + delta] });
  assert.equal(after.slice(...mapped.range), before.slice(...range));
});

test('mapRange reports uncertain with the whole changed block when the range overlaps it', () => {
  const before = 'One.\n\nTwo.\n\nThree.\n';
  const after = 'One.\n\nTwo REWRITTEN.\n\nThree.\n';
  const range = [before.indexOf('Two.'), before.indexOf('Two.') + 'Two.'.length];
  const mapped = mapRange(before, after, range);
  assert.equal(mapped.status, 'uncertain');
  assert.equal(after.slice(...mapped.range), 'Two REWRITTEN.\n');
});

test('mapRange treats identical texts as unchanged regardless of range', () => {
  const text = 'Same throughout.\n';
  assert.deepEqual(mapRange(text, text, [3, 7]), { status: 'unchanged', range: [3, 7] });
});

test('passageHistory reports only revisions whose patch overlaps the tracked passage', async () => {
  const v0 = '# Chapter\n\nMaria walked in.\n\nElias watched.\n';
  let history = await createHistory(v0, { checkpointInterval: 1000 });
  const mariaFrom = v0.indexOf('Maria walked in.');
  const mariaTo = mariaFrom + 'Maria walked in.'.length;

  const v1 = v0.replace('Elias watched.', 'Elias watched silently.');
  await commitRevision(history, v0, v1, { origin: 'user', note: 'Expanded Elias.' });

  const v2 = v1.replace('Maria walked in.', 'Maria walked in slowly.');
  await commitRevision(history, v1, v2, { origin: 'agent', note: 'Slowed Maria entrance.' });

  const result = await passageHistory(history, history.currentRevision, [mariaFrom, mariaTo]);
  assert.equal(result.stoppedReason, 'root');
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].note, 'Slowed Maria entrance.');
  assert.equal(result.entries[0].approximate, true);
});

test('passageHistory returns no entries when the passage was never touched', async () => {
  const v0 = 'Untouched passage.\n\nOther paragraph.\n';
  const history = await createHistory(v0, { checkpointInterval: 1000 });
  const range = [0, 'Untouched passage.'.length];
  const v1 = v0.replace('Other paragraph.', 'Other paragraph changed.');
  await commitRevision(history, v0, v1, { origin: 'user' });

  const result = await passageHistory(history, history.currentRevision, range);
  assert.equal(result.entries.length, 0);
  assert.equal(result.approximate, false);
  assert.deepEqual(result.roots.map((root) => root.revisionId), [0]);
  assert.deepEqual(result.roots[0].rangeInResult, range);
  assert.equal(result.stoppedReason, 'root');
});

test('passageHistory follows the passage across sibling branches and later revisions, not just ancestors', async () => {
  const v0 = '# Chapter\n\nMaria walked in.\n\nElias watched.\n';
  const history = await createHistory(v0, { checkpointInterval: 1000 });
  const from = v0.indexOf('Maria walked in.');
  const range = [from, from + 'Maria walked in.'.length];

  const branchA = v0.replace('Maria walked in.', 'Maria strode in.');
  await commitRevision(history, v0, branchA, { origin: 'agent', note: 'Alt A' });
  history.currentRevision = 0;
  const branchB = v0.replace('Maria walked in.', 'Maria crept in.');
  await commitRevision(history, v0, branchB, { origin: 'agent', note: 'Alt B' });
  const later = branchB.replace('Elias watched.', 'Elias watched, unmoved.');
  await commitRevision(history, branchB, later, { origin: 'user', note: 'Elsewhere' });
  const finalText = later.replace('crept', 'crept quietly');
  await commitRevision(history, later, finalText, { origin: 'user', note: 'Refined' });

  const result = await passageHistory(history, history.currentRevision, range);
  assert.deepEqual(result.entries.map((entry) => entry.revisionId).sort((a, b) => a - b), [1, 2, 4]);
});
