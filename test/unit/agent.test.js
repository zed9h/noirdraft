import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentError, requestRewrite } from '../../src/renderer/ai/agent.js';
import { childrenOf, commitRevision, createHistory, reconstructRevision } from '../../src/renderer/history/graph.js';
import { KoboldClient } from '../../src/renderer/ai/kobold.js';
import { startFakeKoboldServer } from '../support/fake-kobold-server.js';

const AGENT_PROTOCOL = 'Reply with only the replacement prose.';
const finish = (comment, raw = comment) => ({ message: { role: 'assistant', content: null, tool_calls: [{ id: 'finish', type: 'function', function: { name: 'finish_turn', arguments: JSON.stringify({ outcome: 'complete', comment }) } }] }, raw });
const review = (raw = 'review') => ({ message: { role: 'assistant', content: null, tool_calls: [{ id: 'review', type: 'function', function: { name: 'review_changes', arguments: '{}' } }] }, raw });
const goal = (acceptedChanges, strategy = 'Provide distinct alternatives.') => ({ message: { role: 'assistant', content: null, tool_calls: [{ id: 'goal', type: 'function', function: { name: 'set_changes_goal', arguments: JSON.stringify({ accepted_changes: acceptedChanges, strategy }) } }] }, raw: 'goal' });

test('a successful proposal is materialized as an agent-origin sibling without changing the checked-out revision', async () => {
  const story = '# Chapter\n\nThe room was cold.\n\nShe sat down.\n';
  const history = await createHistory(story, { checkpointInterval: 1000 });
  const server = await startFakeKoboldServer({ tokens: ['The ', 'room ', 'was ', 'freezing.'] });
  try {
    const client = new KoboldClient(server.url);
    const from = story.indexOf('The room was cold.');
    const to = from + 'The room was cold.'.length;
    const result = await requestRewrite({
      client,
      history,
      baseRevisionId: 0,
      range: [from, to],
      request: 'Make it colder.',
      agentProtocol: AGENT_PROTOCOL,
    });

    assert.equal(result.generated, 'The room was freezing.');
    assert.equal(history.currentRevision, 0, 'checked-out STORY must stay unchanged until explicitly chosen');
    assert.equal(result.revision.origin, 'agent');
    assert.equal(result.revision.parents[0], 0);

    const siblings = childrenOf(history, 0);
    assert.equal(siblings.length, 1);
    assert.equal(siblings[0].id, result.revision.id);
  } finally {
    await server.close();
  }
});

test('a rewrite never collapses a following blank line when the model omits the target terminal newline', async () => {
  const story = 'Original sentence.\n\nFollowing paragraph.\n';
  const history = await createHistory(story, { checkpointInterval: 1000 });
  const server = await startFakeKoboldServer({ tokens: ['Replacement sentence.'] });
  try {
    const result = await requestRewrite({
      client: new KoboldClient(server.url), history, baseRevisionId: 0,
      range: [0, 'Original sentence.\n'.length], request: 'Rewrite it.', agentProtocol: AGENT_PROTOCOL,
    });
    assert.equal(await reconstructRevision(history, result.revision.id), 'Replacement sentence.\n\nFollowing paragraph.\n');
  } finally {
    await server.close();
  }
});

test('an insert operation adds only its text at a zero-width cursor', async () => {
  const story = 'The rain stopped.';
  const history = await createHistory(story, { checkpointInterval: 1000 });
  let callCount = 0;
  const client = {
    async chatCompletion() {
      callCount += 1;
      if (callCount === 1) return goal(1);
      if (callCount === 2) return { message: { role: 'assistant', content: null, tool_calls: [{ id: 'insert', type: 'function', function: { name: 'submit_change', arguments: '{"operation":"insert","text":"briefly "}' } }] }, raw: 'insert' };
      if (callCount === 3) return review();
      return finish('Inserted a small qualifier.', 'chat');
    },
  };
  const cursor = story.indexOf('stopped');
  const result = await requestRewrite({ client, history, baseRevisionId: 0, range: [cursor, cursor], request: 'Expand the phrase.', agentProtocol: AGENT_PROTOCOL });
  assert.equal(await reconstructRevision(history, result.revision.id), 'The rain briefly stopped.');
  assert.equal(result.chat, '[#1](noirdraft://version/STORY/1) Inserted a small qualifier.');
  assert.match(result.rawResponse, /^goal\n\n\[noirdraft tool result: goal\]/);
  assert.match(result.rawResponse, /"status":"accepted","revision_id":1/);
  assert.match(result.rawResponse, /review\n\n\[noirdraft tool result: review\]/);
  assert.match(result.rawResponse, /chat\n\n\[noirdraft tool result: finish\]/);
  assert.match(result.rawResponse, /"turn_summary":\{"accepted_changes":1,"invalid_calls":0,"retracted_changes":0\}/);
});

test('finish_turn is rejected until review_changes follows the last change call', async () => {
  const story = 'Original.';
  const history = await createHistory(story, { checkpointInterval: 1000 });
  let callCount = 0;
  const client = {
    async chatCompletion() {
      callCount += 1;
      if (callCount === 1) return goal(1);
      if (callCount === 2) return { message: { role: 'assistant', content: null, tool_calls: [{ id: 'change', type: 'function', function: { name: 'submit_change', arguments: '{"operation":"replace","text":"Revision."}' } }] }, raw: 'change' };
      if (callCount === 3) return finish('Premature.', 'premature');
      if (callCount === 4) return review();
      return finish('Reviewed.', 'finish');
    },
  };
  const result = await requestRewrite({ client, history, baseRevisionId: 0, range: [0, story.length], request: 'Rewrite.', agentProtocol: AGENT_PROTOCOL });
  assert.equal(result.chat, '[#1](noirdraft://version/STORY/1) Reviewed.');
  assert.match(result.rawResponse, /"reason":"Call review_changes after the last proposal change, then finish in a later response\."/);
  assert.match(result.rawResponse, /"status":"ready","goal":\{[^}]+\},"accepted_changes":1/);
});

test('a committed changes goal rejects complete until its reviewed count is met', async () => {
  const story = 'Original.';
  const history = await createHistory(story, { checkpointInterval: 1000 });
  let callCount = 0;
  const client = {
    async chatCompletion() {
      callCount += 1;
      if (callCount === 1) return goal(2, 'Make two distinct alternatives.');
      if (callCount === 2) return { message: { role: 'assistant', content: null, tool_calls: [{ id: 'change', type: 'function', function: { name: 'submit_change', arguments: '{"operation":"replace","text":"Only one."}' } }] }, raw: 'change' };
      if (callCount === 3) return review();
      if (callCount === 4) return finish('Pretends this is enough.', 'premature');
      return {
        message: { role: 'assistant', content: null, tool_calls: [{ id: 'finish', type: 'function', function: { name: 'finish_turn', arguments: JSON.stringify({ outcome: 'unable', comment: 'I could produce only one distinct option.', failure_reason: 'No second distinct option was available.' }) } }] },
        raw: 'unable',
      };
    },
  };
  const result = await requestRewrite({ client, history, baseRevisionId: 0, range: [0, story.length], request: 'Give two versions.', agentProtocol: AGENT_PROTOCOL });
  assert.equal(result.chat, '[#1](noirdraft://version/STORY/1) I could produce only one distinct option.');
  assert.match(result.rawResponse, /"goal_status":"incomplete"/);
  assert.match(result.rawResponse, /"next_action":\{"action":"continue","remaining_changes":1/);
  assert.match(result.rawResponse, /"reason":"The goal requires 2 accepted changes; review found 1\."/);
});

test('a cursor proposal returns its edited context so the model can submit a corrected sibling', async () => {
  const story = 'left right';
  const history = await createHistory(story, { checkpointInterval: 1000 });
  const requests = [];
  const client = {
    async chatCompletion(options) {
      // requestRewrite deliberately continues to append to its transcript.
      // Snapshot the tool result as it was sent rather than retaining that
      // mutable message array.
      requests.push(structuredClone(options));
      if (requests.length === 1) return goal(2);
      if (requests.length === 2) return { message: { role: 'assistant', content: null, tool_calls: [{ id: 'bad', type: 'function', function: { name: 'submit_change', arguments: '{"operation":"insert","text":"right"}' } }] }, raw: 'bad' };
      if (requests.length === 3) return { message: { role: 'assistant', content: null, tool_calls: [{ id: 'good', type: 'function', function: { name: 'submit_change', arguments: '{"operation":"insert","text":"new "}' } }] }, raw: 'good' };
      if (requests.length === 4) return review();
      return finish('Corrected.', 'done');
    },
  };
  const result = await requestRewrite({ client, history, baseRevisionId: 0, range: [5, 5], request: 'Insert text.', agentProtocol: AGENT_PROTOCOL });
  const receipt = JSON.parse(requests[2].messages.at(-1).content);
  assert.equal(receipt.status, 'accepted');
  assert.equal(receipt.revision_id, 1);
  assert.equal(receipt.candidate_context, undefined);
  const changeReview = JSON.parse(requests[4].messages.at(-1).content);
  assert.equal(changeReview.status, 'ready');
  assert.equal(changeReview.accepted_changes, 2);
  assert.match(changeReview.proposals[1].diff, /\+left new right/);
  assert.equal(result.revisions.length, 2);
  assert.equal(await reconstructRevision(history, result.revisions[1].id), 'left new right');
});

test('an identical sibling proposal is transient, including when the sibling was manual', async () => {
  const story = 'Original.';
  const history = await createHistory(story, { checkpointInterval: 1000 });
  const manual = await commitRevision(history, story, 'Manual.', { origin: 'user', parentId: 0, setCurrent: false });
  const requests = [];
  const client = {
    async chatCompletion(options) {
      requests.push(structuredClone(options));
      if (requests.length === 1) return goal(1);
      if (requests.length === 2) return { message: { role: 'assistant', content: null, tool_calls: [{ id: 'same', type: 'function', function: { name: 'submit_change', arguments: '{"operation":"replace","text":"Manual."}' } }] }, raw: 'same' };
      if (requests.length === 3) return { message: { role: 'assistant', content: null, tool_calls: [{ id: 'different', type: 'function', function: { name: 'submit_change', arguments: '{"operation":"replace","text":"Agent."}' } }] }, raw: 'different' };
      if (requests.length === 4) return review();
      return finish('A distinct version is ready.', 'done');
    },
  };

  const result = await requestRewrite({ client, history, baseRevisionId: 0, range: [0, story.length], request: 'Give alternatives.', agentProtocol: AGENT_PROTOCOL });
  const invalidReceipt = JSON.parse(requests[2].messages.at(-1).content);
  assert.equal(invalidReceipt.status, 'rejected');
  assert.equal(invalidReceipt.reason, `The proposed result is identical to revision #${manual.id}.`);
  assert.equal(invalidReceipt.turn_summary, undefined);
  assert.equal(result.revisions.length, 1);
  assert.equal(await reconstructRevision(history, result.revision.id), 'Agent.');
  assert.equal(childrenOf(history, 0).length, 2);
  assert.equal(result.chat, `[#${result.revision.id}](noirdraft://version/STORY/${result.revision.id}) A distinct version is ready.`);
  assert.doesNotMatch(result.chat, new RegExp(`\\[#${manual.id}\\]`));
});

test('a retracted current-turn proposal is removed from history and CHAT citations', async () => {
  const story = 'Original.';
  const history = await createHistory(story, { checkpointInterval: 1000 });
  const requests = [];
  const client = {
    async chatCompletion(options) {
      requests.push(structuredClone(options));
      if (requests.length === 1) return goal(1);
      if (requests.length === 2) return { message: { role: 'assistant', content: null, tool_calls: [{ id: 'wrong', type: 'function', function: { name: 'submit_change', arguments: '{"operation":"replace","text":"Wrong."}' } }] }, raw: 'wrong' };
      if (requests.length === 3) return { message: { role: 'assistant', content: null, tool_calls: [{ id: 'retract', type: 'function', function: { name: 'retract_change', arguments: '{"revision_id":1}' } }, { id: 'right', type: 'function', function: { name: 'submit_change', arguments: '{"operation":"replace","text":"Right."}' } }] }, raw: 'correction' };
      if (requests.length === 4) return review();
      return finish('Corrected version ready.', 'done');
    },
  };

  const result = await requestRewrite({ client, history, baseRevisionId: 0, range: [0, story.length], request: 'Rewrite.', agentProtocol: AGENT_PROTOCOL });
  const receipt = JSON.parse(requests[3].messages.filter(({ role }) => role === 'tool').at(-2).content);
  assert.equal(receipt.status, 'accepted');
  assert.equal(receipt.revision_id, 1);
  assert.equal(receipt.reason, 'proposal retracted');
  assert.equal(receipt.turn_summary, undefined);
  assert.equal(history.revisions.has(1), false);
  assert.equal(result.revisions.length, 1);
  assert.equal(await reconstructRevision(history, result.revision.id), 'Right.');
  assert.equal(result.chat, `[#${result.revision.id}](noirdraft://version/STORY/${result.revision.id}) Corrected version ready.`);
});

test('multiple proposals from the same base survive as separate preserved sibling branches', async () => {
  const story = '# Chapter\n\nThe room was cold.\n';
  const history = await createHistory(story, { checkpointInterval: 1000 });
  const from = story.indexOf('The room was cold.');
  const to = from + 'The room was cold.'.length;
  const serverA = await startFakeKoboldServer({ tokens: ['Freezing.'] });
  const serverB = await startFakeKoboldServer({ tokens: ['Bitterly ', 'cold.'] });
  try {
    const proposalA = await requestRewrite({
      client: new KoboldClient(serverA.url),
      history,
      baseRevisionId: 0,
      range: [from, to],
      request: 'Variant A',
      agentProtocol: AGENT_PROTOCOL,
    });
    const proposalB = await requestRewrite({
      client: new KoboldClient(serverB.url),
      history,
      baseRevisionId: 0,
      range: [from, to],
      request: 'Variant B',
      agentProtocol: AGENT_PROTOCOL,
    });

    assert.notEqual(proposalA.revision.id, proposalB.revision.id);
    assert.equal(history.currentRevision, 0);
    const siblings = childrenOf(history, 0).map(({ id }) => id).sort();
    assert.deepEqual(siblings, [proposalA.revision.id, proposalB.revision.id].sort());
  } finally {
    await serverA.close();
    await serverB.close();
  }
});

test('one structured response can create many sibling revisions and still chat with the author', async () => {
  const story = 'Original.';
  const history = await createHistory(story, { checkpointInterval: 1000 });
  const server = await startFakeKoboldServer({ toolCalls: ['First.', 'Second.'] });
  try {
    const result = await requestRewrite({
      client: new KoboldClient(server.url), history, baseRevisionId: 0, range: [0, story.length],
      request: 'Give me two versions.', agentProtocol: AGENT_PROTOCOL,
    });
    assert.equal(result.chat, '[#1](noirdraft://version/STORY/1) [#2](noirdraft://version/STORY/2) Done.');
    assert.equal(result.revisions.length, 2);
    assert.equal(history.currentRevision, 0);
    assert.equal(childrenOf(history, 0).length, 2);
  } finally {
    await server.close();
  }
});

test('a follow-up tool batch becomes more sibling revisions before the final chat reply', async () => {
  const story = 'Original.';
  const history = await createHistory(story, { checkpointInterval: 1000 });
  const requests = [];
  const reply = (message, raw) => ({ message, raw: JSON.stringify({ message }) });
  const client = {
    async chatCompletion(options) {
      requests.push(structuredClone(options));
      if (requests.length === 1) return goal(2);
      if (requests.length === 2) return reply({ role: 'assistant', content: 'First option:', tool_calls: [{ id: 'first', type: 'function', function: { name: 'submit_change', arguments: '{"operation":"replace","text":"First."}' } }] }, 'first');
      if (requests.length === 3) return reply({ role: 'assistant', content: 'Second option:', tool_calls: [{ id: 'second', type: 'function', function: { name: 'submit_change', arguments: '{"operation":"replace","text":"Second."}' } }] }, 'second');
      if (requests.length === 4) return reply({ role: 'assistant', content: null, tool_calls: [{ id: 'review', type: 'function', function: { name: 'review_changes', arguments: '{}' } }] }, 'review');
      return reply({ role: 'assistant', content: null, tool_calls: [{ id: 'finish', type: 'function', function: { name: 'finish_turn', arguments: JSON.stringify({ outcome: 'complete', comment: 'Two distinct options, with different pacing.' }) } }] }, 'final');
    },
  };

  const result = await requestRewrite({
    client, history, baseRevisionId: 0, range: [0, story.length],
    request: 'Give me 2 versions.', agentProtocol: AGENT_PROTOCOL,
  });

  assert.equal(result.revisions.length, 2);
  assert.equal(result.chat, '[#1](noirdraft://version/STORY/1) [#2](noirdraft://version/STORY/2) Two distinct options, with different pacing.');
  assert.equal(requests.length, 5);
  assert.equal(requests[1].toolChoice, 'required');
  assert.equal(requests[1].messages.at(-1).role, 'tool');
  assert.equal(requests[3].messages.filter((message) => message.role === 'tool').length, 3);
  assert.equal(requests[4].messages.filter((message) => message.role === 'tool').length, 4);
  assert.equal(childrenOf(history, 0).length, 2);
});

test('a truncated unparsed tool transcript fails instead of appearing as agent chat', async () => {
  const story = 'Original.';
  const history = await createHistory(story, { checkpointInterval: 1000 });
  const raw = JSON.stringify({ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '[{"function":{"name":"submit_change"', tool_calls: [] } }] });
  const client = {
    async chatCompletion() {
      return { message: { role: 'assistant', content: '[{"function":{"name":"submit_change"', tool_calls: [] }, finishReason: 'length', raw };
    },
  };

  await assert.rejects(
    requestRewrite({ client, history, baseRevisionId: 0, range: [0, story.length], request: 'Give me versions.', agentProtocol: AGENT_PROTOCOL }),
    (error) => error instanceof AgentError && error.code === 'TRUNCATED_TOOL_RESPONSE' && error.rawText === raw,
  );
  assert.equal(history.revisions.size, 1);
});

test('a Gemma control-token tool transcript fails instead of appearing as agent chat', async () => {
  const story = 'Original.';
  const history = await createHistory(story, { checkpointInterval: 1000 });
  const raw = '{"choices":[{"message":{"content":"<|tool_call>call:submit_change{operation:<|\\\"|>insert}"}}]}';
  const client = {
    async chatCompletion() {
      return { message: { role: 'assistant', content: '<|tool_call>call:submit_change{operation:<|"|>insert}', tool_calls: [] }, raw };
    },
  };
  await assert.rejects(
    requestRewrite({ client, history, baseRevisionId: 0, range: [0, story.length], request: 'Rewrite.', agentProtocol: AGENT_PROTOCOL }),
    (error) => error instanceof AgentError && error.code === 'UNPARSED_TOOL_CALL' && error.rawText === raw,
  );
  assert.equal(history.revisions.size, 1);
});

test('a plain-text function transcript fails instead of appearing as agent chat', async () => {
  const story = 'Original.';
  const history = await createHistory(story, { checkpointInterval: 1000 });
  const raw = '{"choices":[{"message":{"content":"submit_change(operation=\\\"replace\\\", text=\\\"Rewrite.\\\")"}}]}';
  const client = {
    async chatCompletion() {
      return { message: { role: 'assistant', content: 'submit_change(operation="replace", text="Rewrite.")', tool_calls: [] }, raw };
    },
  };
  await assert.rejects(
    requestRewrite({ client, history, baseRevisionId: 0, range: [0, story.length], request: 'Rewrite.', agentProtocol: AGENT_PROTOCOL }),
    (error) => error instanceof AgentError && error.code === 'UNPARSED_TOOL_CALL' && error.rawText === raw,
  );
  assert.equal(history.revisions.size, 1);
});

test('a selected passage may be discussed without submitting a change', async () => {
  const story = 'Original.';
  const history = await createHistory(story, { checkpointInterval: 1000 });
  const client = { async chatCompletion() { return finish('Here is an idea.', '{"message":"Here is an idea."}'); } };
  const result = await requestRewrite({ client, history, baseRevisionId: 0, range: [0, story.length], request: 'Discuss it.', agentProtocol: AGENT_PROTOCOL });
  assert.equal(result.chat, 'Here is an idea.');
  assert.equal(result.revisions.length, 0);
  assert.equal(history.revisions.size, 1);
});

test('a disconnected server is contained as an AgentError without creating any revision', async () => {
  const story = '# Chapter\n\nText.\n';
  const history = await createHistory(story, { checkpointInterval: 1000 });
  const client = new KoboldClient('http://127.0.0.1:1');
  await assert.rejects(
    requestRewrite({
      client,
      history,
      baseRevisionId: 0,
      range: [0, story.length],
      request: 'Rewrite.',
      agentProtocol: AGENT_PROTOCOL,
    }),
    (error) => error instanceof AgentError && error.code === 'UNAVAILABLE',
  );
  assert.equal(history.revisions.size, 1);
  assert.equal(history.currentRevision, 0);
});

test('an empty proposal is refused without creating a revision, and raw text is never lost on failure', async () => {
  const story = '# Chapter\n\nText.\n';
  const history = await createHistory(story, { checkpointInterval: 1000 });
  const server = await startFakeKoboldServer({ tokens: [] });
  try {
    await assert.rejects(
      requestRewrite({
        client: new KoboldClient(server.url),
        history,
        baseRevisionId: 0,
        range: [0, story.length],
        request: 'Rewrite.',
        agentProtocol: AGENT_PROTOCOL,
      }),
      (error) => error instanceof AgentError && error.code === 'MISSING_REQUIRED_TOOL_CALL',
    );
    assert.equal(history.revisions.size, 1);
  } finally {
    await server.close();
  }
});

test('a request binds to its exact base revision and refuses a stale one', async () => {
  const story = '# Chapter\n\nText.\n';
  const history = await createHistory(story, { checkpointInterval: 1000 });
  const server = await startFakeKoboldServer({ tokens: ['New text.'] });
  try {
    await assert.rejects(
      requestRewrite({
        client: new KoboldClient(server.url),
        history,
        baseRevisionId: 99,
        range: [0, story.length],
        request: 'Rewrite.',
        agentProtocol: AGENT_PROTOCOL,
      }),
    );
  } finally {
    await server.close();
  }
});
