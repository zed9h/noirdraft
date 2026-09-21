import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentError, requestRewrite } from '../../src/renderer/ai/agent.js';
import { createHistory, reconstructRevision } from '../../src/renderer/history/graph.js';

const protocol = 'Use only turn_iterate.';
const iterate = (payload, raw = 'iterate') => ({ message: { role: 'assistant', content: null, tool_calls: [{ id: `call_${raw}`, type: 'function', function: { name: 'turn_iterate', arguments: JSON.stringify(payload) } }] }, raw });

test('a reviewed chat draft is approved implicitly without a separate send call', async () => {
  const history = await createHistory('Original.');
  let calls = 0;
  const client = { async chatCompletion() {
    calls += 1;
    return calls === 1
      ? iterate({ chat: { intent: 'Greet the author.', message: 'Hello.' } }, 'draft')
      : iterate({ chat: { editorial_comment: 'A complete greeting.', verdict: 'approve' } }, 'approve');
  } };
  const result = await requestRewrite({ client, history, baseRevisionId: 0, range: [0, 0], request: 'hi', agentProtocol: protocol });
  assert.equal(result.chat, 'Hello.');
  assert.equal(result.revisions.length, 0);
  assert.match(result.rawResponse, /NOIRDRAFT CHAT REVIEW/);
  assert.match(result.rawResponse, /"status":"approved"/);
});

test('one iteration may switch from chat to changes, then from changes to conclusion chat', async () => {
  const story = 'Original.';
  const history = await createHistory(story);
  let calls = 0;
  const client = { async chatCompletion() {
    calls += 1;
    if (calls === 1) return iterate({ chat: { intent: 'Consider the request.', message: 'I will revise it.' } }, 'chat');
    if (calls === 2) return iterate({
      chat: { editorial_comment: 'This promises an edit, so it must become a revision.', verdict: 'switch_to_changes' },
      changes: { change_alternatives_count: 1, intent: 'Write one grammatical revision.', operation: 'replace', proposals: [{ text: 'Rewritten.' }] },
    }, 'switch');
    if (calls === 3) return iterate({
      changes: { intent: 'Approve the grammatical candidate.', operation: 'replace', reviews: [{ revision_id: 1, editorial_comment: 'Grammatical and natural in the complete sentence.', verdict: 'approve' }] },
      chat: { intent: 'Conclude the completed revision.', message: 'I prepared a revision.' },
    }, 'conclusion');
    return iterate({ chat: { editorial_comment: 'This is an accurate concise conclusion.', verdict: 'approve' } }, 'approve');
  } };
  const result = await requestRewrite({ client, history, baseRevisionId: 0, range: [0, story.length], request: 'Rewrite it.', agentProtocol: protocol });
  assert.equal(await reconstructRevision(history, 1), 'Rewritten.');
  assert.equal(result.chat, '[#1](noirdraft://version/STORY/1) I prepared a revision.');
  assert.match(result.rawResponse, /NOIRDRAFT CHANGE REVIEW/);
  assert.match(result.rawResponse, /This is the final conclusion/);
});

test('a retracted pending proposal is removed before the final citation is made', async () => {
  const history = await createHistory('Original.');
  let calls = 0;
  const client = { async chatCompletion() {
    calls += 1;
    if (calls === 1) return iterate({ chat: { intent: 'Assess editing need.', message: 'I will revise it.' } }, 'chat');
    if (calls === 2) return iterate({ chat: { editorial_comment: 'This requires changes.', verdict: 'switch_to_changes' }, changes: { change_alternatives_count: 1, intent: 'Find one sound rewrite.', operation: 'replace', proposals: [{ text: 'Wrong.' }] } }, 'propose');
    if (calls === 3) return iterate({ changes: { intent: 'Replace the weak candidate with a sound rewrite.', operation: 'replace', reviews: [{ revision_id: 1, editorial_comment: 'Weak and unsuitable.', verdict: 'retract' }], proposals: [{ text: 'Right.' }] } }, 'retract');
    if (calls === 4) return iterate({ changes: { intent: 'Keep the sound rewrite.', operation: 'replace', reviews: [{ revision_id: 2, editorial_comment: 'Grammatical and strong.', verdict: 'approve' }] }, chat: { intent: 'Conclude.', message: 'One revision is ready.' } }, 'review');
    return iterate({ chat: { editorial_comment: 'Complete.', verdict: 'approve' } }, 'approve');
  } };
  const result = await requestRewrite({ client, history, baseRevisionId: 0, range: [0, 'Original.'.length], request: 'Rewrite.', agentProtocol: protocol });
  assert.equal(history.revisions.has(1), false);
  assert.equal(result.chat, '[#2](noirdraft://version/STORY/2) One revision is ready.');
  assert.doesNotMatch(result.chat, /#1/);
});

test('a change review shows only revisions that still need an editorial verdict', async () => {
  const history = await createHistory('Original.');
  let calls = 0;
  let secondReview = '';
  const client = { async chatCompletion({ messages }) {
    calls += 1;
    if (calls === 1) return iterate({ chat: { intent: 'Assess editing need.', message: 'I will revise it.' } }, 'chat');
    if (calls === 2) return iterate({ chat: { editorial_comment: 'This requires changes.', verdict: 'switch_to_changes' }, changes: { change_alternatives_count: 2, intent: 'Offer two distinct rewrites.', operation: 'replace', proposals: [{ text: 'First.' }] } }, 'first');
    if (calls === 3) return iterate({ changes: { intent: 'Add the second rewrite.', operation: 'replace', reviews: [{ revision_id: 1, editorial_comment: 'Strong and grammatical.', verdict: 'approve' }], proposals: [{ text: 'Second.' }] } }, 'approve-first');
    if (calls === 4) {
      secondReview = messages.at(-1).content;
      return iterate({ changes: { intent: 'Approve the second rewrite.', operation: 'replace', reviews: [{ revision_id: 2, editorial_comment: 'Also strong and grammatical.', verdict: 'approve' }] }, chat: { intent: 'Conclude.', message: 'Two revisions are ready.' } }, 'approve-second');
    }
    return iterate({ chat: { editorial_comment: 'Complete.', verdict: 'approve' } }, 'finish');
  } };
  const result = await requestRewrite({ client, history, baseRevisionId: 0, range: [0, 'Original.'.length], request: 'Offer two rewrites.', agentProtocol: protocol });
  assert.match(secondReview, /REVISION #2/);
  assert.doesNotMatch(secondReview, /REVISION #1/);
  assert.match(result.chat, /#1/);
  assert.match(result.chat, /#2/);
});

test('a stale base remains refused before the first iteration', async () => {
  const history = await createHistory('Original.');
  await assert.rejects(
    requestRewrite({ client: { async chatCompletion() { throw new Error('must not call'); } }, history, baseRevisionId: 8, range: [0, 0], request: 'hi', agentProtocol: protocol }),
    (error) => error.code === 'MISSING_REVISION',
  );
});
