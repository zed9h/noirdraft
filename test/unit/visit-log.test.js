import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVisitLog, jumpVisitLog, recordVisit, stepVisitLog } from '../../src/renderer/history/visit-log.js';

test('createVisitLog seeds a single entry or starts empty', () => {
  assert.deepEqual(createVisitLog(), { entries: [], cursor: -1 });
  assert.deepEqual(createVisitLog(3), { entries: [3], cursor: 0 });
});

test('recordVisit appends in order and skips a duplicate of the immediately preceding entry', () => {
  let log = createVisitLog(0);
  log = recordVisit(log, 1);
  log = recordVisit(log, 2);
  assert.deepEqual(log.entries, [0, 1, 2]);
  log = recordVisit(log, 2); // repeat of the last entry — no new entry
  assert.deepEqual(log.entries, [0, 1, 2]);
  log = recordVisit(log, 0); // re-visiting an older entry appends fresh, doesn't dedupe globally
  assert.deepEqual(log.entries, [0, 1, 2, 0]);
  assert.equal(log.cursor, 3);
});

test('stepVisitLog moves the cursor one at a time and clamps at both ends', () => {
  let log = createVisitLog(0);
  log = recordVisit(log, 1);
  log = recordVisit(log, 2);
  const back = stepVisitLog(log, -1);
  assert.equal(back.id, 1);
  const backAgain = stepVisitLog(back.log, -1);
  assert.equal(backAgain.id, 0);
  const pastStart = stepVisitLog(backAgain.log, -1);
  assert.equal(pastStart.id, null);
  assert.equal(pastStart.log, backAgain.log);
  const forward = stepVisitLog(backAgain.log, 1);
  assert.equal(forward.id, 1);
});

test('jumpVisitLog jumps to the first or last entry, and is a no-op on an empty log', () => {
  let log = createVisitLog(0);
  log = recordVisit(log, 1);
  log = recordVisit(log, 2);
  assert.equal(jumpVisitLog(log, 'first').id, 0);
  assert.equal(jumpVisitLog(log, 'last').id, 2);
  const empty = createVisitLog();
  assert.equal(jumpVisitLog(empty, 'first').id, null);
});
