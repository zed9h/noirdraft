import assert from 'node:assert/strict';
import { test } from 'node:test';
import { endScrub, startScrub, stepScrub } from '../../src/renderer/history/scrub-session.js';

// A provider that treats ids as integers and steps by +/-1, with 'left'
// disabled below 0 (simulating a boundary a real provider would hit).
const fakeProvider = {
  step: (providerState, currentId, key) => {
    if (key === 'left') return currentId > 0 ? { id: currentId - 1, providerState } : null;
    if (key === 'right') return { id: currentId + 1, providerState };
    return null;
  },
};

test('startScrub captures the origin and starts the cursor there', () => {
  const session = startScrub({ originId: 5, providerState: null });
  assert.equal(session.originId, 5);
  assert.equal(session.currentId, 5);
});

test('stepScrub advances currentId via the provider without touching originId', () => {
  let session = startScrub({ originId: 5, providerState: null });
  session = stepScrub(session, fakeProvider, 'right');
  assert.equal(session.currentId, 6);
  assert.equal(session.originId, 5);
  session = stepScrub(session, fakeProvider, 'right');
  assert.equal(session.currentId, 7);
});

test('stepScrub is a no-op (returns the same session) when the provider reports no candidate', () => {
  let session = startScrub({ originId: 0, providerState: null });
  const stepped = stepScrub(session, fakeProvider, 'left');
  assert.equal(stepped, session);
});

test('endScrub reports the origin and wherever the session landed', () => {
  let session = startScrub({ originId: 5, providerState: null });
  session = stepScrub(session, fakeProvider, 'right');
  session = stepScrub(session, fakeProvider, 'right');
  assert.deepEqual(endScrub(session), { originId: 5, finalId: 7 });
});
