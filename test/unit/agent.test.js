import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestRewrite } from '../../src/renderer/ai/agent.js';
import { createHistory, reconstructRevision } from '../../src/renderer/history/graph.js';

const protocol = 'Use NoirDraft native tools.';
const call = (name, args, id) => ({ id: `call_${id}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const response = (calls, raw = 'response') => ({ message: { role: 'assistant', content: null, tool_calls: calls }, raw });
const review = (revision_id, comment, verdict = 'approve') => ({ revision_id, copyedit: { sentence_integrity: verdict === 'approve', mechanics: verdict === 'approve', clarity: verdict === 'approve', style: verdict === 'approve' }, comment, verdict });

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
    if (count === 1) return response([call('propose_changes', { intent: 'Offer two distinct rewrites.', alternative_count: 2, proposals: [{ text: 'First.' }, { text: 'Second.' }] }, 'propose')], 'batch');
    if (count === 2) {
      displayedReview = messages.at(-1).content;
      return response([call('review_changes', { set_overview: 'Both alternatives are distinct, grammatical rewrites.', reviews: [
        review(1, 'Natural and grammatical.'),
        review(2, 'Natural and distinct.'),
      ] }, 'review')], 'review');
    }
    if (count === 3) return response([call('finish_changes', {}, 'finish')], 'finish');
    if (count === 4) return response([call('draft_chat', { message: 'Two revisions are ready.' }, 'conclusion')], 'conclusion');
    return response([call('approve_chat', {}, 'approve')], 'approve');
  } };
  const result = await requestRewrite({ client, history, baseRevisionId: 0, range: [0, 'Original.'.length], request: 'Offer two rewrites.', agentProtocol: protocol });
  assert.match(displayedReview, /NOIRDRAFT CHANGE REVIEW/);
  assert.doesNotMatch(displayedReview, /This batch:/);
  assert.doesNotMatch(displayedReview, /Approved so far:/);
  assert.match(displayedReview, /----- ORIGINAL TEXT -----/);
  assert.match(displayedReview, /-Original\./);
  assert.doesNotMatch(displayedReview, /END ORIGINAL TEXT/);
  assert.match(displayedReview, /REVISION #1/);
  assert.match(displayedReview, /REVISION #2/);
  assert.equal(await reconstructRevision(history, 1), 'First.');
  assert.match(result.chat, /#1/);
  assert.match(result.chat, /#2/);
});

test('review_changes removes retracted revisions before the next proposal batch', async () => {
  const history = await createHistory('Original.');
  let count = 0;
  let progress = '';
  const client = { async chatCompletion({ messages }) {
    count += 1;
    if (count === 1) return response([call('propose_changes', { intent: 'Offer two rewrites.', alternative_count: 2, proposals: [{ text: 'Wrong.' }, { text: 'Right.' }] }, 'propose')]);
    if (count === 2) return response([call('review_changes', { set_overview: 'The first rewrite is weak; the second is sound.', reviews: [
      review(1, 'Weak.', 'retract'),
      review(2, 'Sound.'),
    ] }, 'review')]);
    if (count === 3) {
      progress = messages.at(-1).content;
      return response([call('propose_changes', { intent: 'Provide one more rewrite.', alternative_count: 1, proposals: [{ text: 'Another.' }] }, 'second')]);
    }
    if (count === 4) return response([call('review_changes', { set_overview: 'The new rewrite is sound and distinct.', reviews: [review(3, 'Sound and distinct.')] }, 'last-review')]);
    if (count === 5) return response([call('finish_changes', {}, 'finish')]);
    if (count === 6) return response([call('draft_chat', { message: 'Done.' }, 'chat')]);
    return response([call('approve_chat', {}, 'approve')]);
  } };
  const result = await requestRewrite({ client, history, baseRevisionId: 0, range: [0, 'Original.'.length], request: 'Offer two rewrites.', agentProtocol: protocol });
  assert.equal(history.revisions.has(1), false);
  assert.match(progress, /I recommend calling propose_changes to pursue the remaining alternatives/);
  assert.doesNotMatch(result.chat, /#1/);
  assert.match(result.chat, /#2/);
  assert.match(result.chat, /#3/);
});

test('finish_changes closes a fully reviewed set even when fewer alternatives were approved than planned', async () => {
  const history = await createHistory('Original.');
  let count = 0;
  let selection = '';
  const client = { async chatCompletion({ messages }) {
    count += 1;
    if (count === 1) return response([call('propose_changes', { intent: 'Offer three rewrites.', alternative_count: 3, proposals: [{ text: 'First.' }, { text: 'Second.' }] }, 'propose')]);
    if (count === 2) return response([call('review_changes', { set_overview: 'One candidate is strong; one is weak.', reviews: [
      review(1, 'Strong.'),
      review(2, 'Weak.', 'retract'),
    ] }, 'review')]);
    if (count === 3) return response([call('finish_changes', {}, 'finish')]);
    if (count === 4) {
      selection = messages.at(-1).content;
      return response([call('draft_chat', { message: 'Done.' }, 'chat')]);
    }
    return response([call('approve_chat', {}, 'approve')]);
  } };
  const result = await requestRewrite({ client, history, baseRevisionId: 0, range: [0, 'Original.'.length], request: 'Offer two rewrites.', agentProtocol: protocol });
  assert.match(selection, /NOIRDRAFT CHANGE SET COMPLETE/);
  assert.equal(history.revisions.has(2), false);
  assert.match(result.chat, /#1/);
  assert.doesNotMatch(result.chat, /#2/);
});
