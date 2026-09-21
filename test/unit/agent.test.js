import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestRewrite } from '../../src/renderer/ai/agent.js';
import { createHistory, reconstructRevision } from '../../src/renderer/history/graph.js';

const protocol = 'Use NoirDraft native tools.';
const call = (name, args, id) => ({ id: `call_${id}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const response = (calls, raw = 'response') => ({ message: { role: 'assistant', content: null, tool_calls: calls }, raw });

test('chat remains a compact draft-and-approval flow', async () => {
  const history = await createHistory('Original.');
  let count = 0;
  const client = { async chatCompletion() {
    count += 1;
    return count === 1 ? response([call('draft_chat', { message: 'Hello.' }, 'draft')], 'draft') : response([call('approve_chat', {}, 'approve')], 'approve');
  } };
  const result = await requestRewrite({ client, history, baseRevisionId: 0, range: [0, 0], request: 'hi', agentProtocol: protocol });
  assert.equal(result.chat, 'Hello.');
  assert.match(result.rawResponse, /NOIRDRAFT CHAT REVIEW/);
});

test('a proposal batch produces its review before review_changes consumes it', async () => {
  const history = await createHistory('Original.');
  let count = 0;
  let displayedReview = '';
  const client = { async chatCompletion({ messages }) {
    count += 1;
    if (count === 1) return response([
      call('begin_changes', { objective: 'Offer two distinct rewrites.', alternative_count: 2 }, 'begin'),
      call('propose_changes', { proposals: [{ text: 'First.' }, { text: 'Second.' }] }, 'propose'),
    ], 'batch');
    if (count === 2) {
      displayedReview = messages.at(-1).content;
      return response([call('review_changes', { reviews: [
        { revision_id: 1, comment: 'Natural and grammatical.', verdict: 'approve' },
        { revision_id: 2, comment: 'Natural and distinct.', verdict: 'approve' },
      ] }, 'review')], 'review');
    }
    if (count === 3) return response([call('finish_changes', {}, 'finish')], 'finish');
    if (count === 4) return response([call('draft_chat', { message: 'Two revisions are ready.' }, 'conclusion')], 'conclusion');
    return response([call('approve_chat', {}, 'approve')], 'approve');
  } };
  const result = await requestRewrite({ client, history, baseRevisionId: 0, range: [0, 'Original.'.length], request: 'Offer two rewrites.', agentProtocol: protocol });
  assert.match(displayedReview, /NOIRDRAFT CHANGE REVIEW/);
  assert.match(displayedReview, /REVISION #1/);
  assert.match(displayedReview, /REVISION #2/);
  assert.equal(await reconstructRevision(history, 1), 'First.');
  assert.match(result.chat, /#1/);
  assert.match(result.chat, /#2/);
});

test('review_changes records a pending intent and removes retracted revisions', async () => {
  const history = await createHistory('Original.');
  let count = 0;
  let progress = '';
  const client = { async chatCompletion({ messages }) {
    count += 1;
    if (count === 1) return response([call('begin_changes', { objective: 'Offer two rewrites.', alternative_count: 2 }, 'begin'), call('propose_changes', { proposals: [{ text: 'Wrong.' }, { text: 'Right.' }] }, 'propose')]);
    if (count === 2) return response([call('review_changes', { reviews: [
      { revision_id: 1, comment: 'Weak.', verdict: 'retract' },
      { revision_id: 2, comment: 'Sound.', verdict: 'approve' },
    ], pending_intent: 'Provide one more rewrite that is distinct from revision #2.' }, 'review')]);
    if (count === 3) {
      progress = messages.at(-1).content;
      return response([call('propose_changes', { proposals: [{ text: 'Another.' }] }, 'second')]);
    }
    if (count === 4) return response([call('review_changes', { reviews: [{ revision_id: 3, comment: 'Sound and distinct.', verdict: 'approve' }] }, 'last-review')]);
    if (count === 5) return response([call('finish_changes', {}, 'finish')]);
    if (count === 6) return response([call('draft_chat', { message: 'Done.' }, 'chat')]);
    return response([call('approve_chat', {}, 'approve')]);
  } };
  const result = await requestRewrite({ client, history, baseRevisionId: 0, range: [0, 'Original.'.length], request: 'Offer two rewrites.', agentProtocol: protocol });
  assert.equal(history.revisions.has(1), false);
  assert.match(progress, /Pending: Provide one more rewrite/);
  assert.doesNotMatch(result.chat, /#1/);
  assert.match(result.chat, /#2/);
  assert.match(result.chat, /#3/);
});

test('finish_changes asks the agent to select the best alternatives when a batch exceeds its objective', async () => {
  const history = await createHistory('Original.');
  let count = 0;
  let selection = '';
  const client = { async chatCompletion({ messages }) {
    count += 1;
    if (count === 1) return response([call('begin_changes', { objective: 'Offer two rewrites.', alternative_count: 2 }, 'begin'), call('propose_changes', { proposals: [{ text: 'First.' }, { text: 'Second.' }, { text: 'Third.' }] }, 'propose')]);
    if (count === 2) return response([call('review_changes', { reviews: [
      { revision_id: 1, comment: 'Strong.', verdict: 'approve' },
      { revision_id: 2, comment: 'Strong.', verdict: 'approve' },
      { revision_id: 3, comment: 'Strong.', verdict: 'approve' },
    ] }, 'review')]);
    if (count === 3) return response([call('finish_changes', {}, 'select')]);
    if (count === 4) {
      selection = messages.at(-1).content;
      return response([call('finish_changes', { keep_revision_ids: [1, 3] }, 'finish')]);
    }
    if (count === 5) return response([call('draft_chat', { message: 'Done.' }, 'chat')]);
    return response([call('approve_chat', {}, 'approve')]);
  } };
  const result = await requestRewrite({ client, history, baseRevisionId: 0, range: [0, 'Original.'.length], request: 'Offer two rewrites.', agentProtocol: protocol });
  assert.match(selection, /NOIRDRAFT FINAL SELECTION/);
  assert.equal(history.revisions.has(2), false);
  assert.match(result.chat, /#1/);
  assert.match(result.chat, /#3/);
  assert.doesNotMatch(result.chat, /#2/);
});
