import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentError, requestRewrite } from '../../src/renderer/ai/agent.js';
import { childrenOf, createHistory } from '../../src/renderer/history/graph.js';
import { KoboldClient } from '../../src/renderer/ai/kobold.js';
import { startFakeKoboldServer } from '../support/fake-kobold-server.js';

const AGENT_PROTOCOL = 'Reply with only the replacement prose.';

test('a successful proposal is materialized as an agent-origin sibling without changing the checked-out revision', async () => {
  const story = '# Chapter\n\nThe room was cold.\n\nShe sat down.\n';
  const history = await createHistory(story, { checkpointInterval: 1000 });
  const server = await startFakeKoboldServer({ tokens: ['The ', 'room ', 'was ', 'freezing.'] });
  try {
    const client = new KoboldClient(server.url);
    const from = story.indexOf('The room was cold.');
    const to = from + 'The room was cold.'.length;
    const streamed = [];
    const result = await requestRewrite({
      client,
      history,
      baseRevisionId: 0,
      range: [from, to],
      request: 'Make it colder.',
      agentProtocol: AGENT_PROTOCOL,
      onToken: (text) => streamed.push(text),
    });

    assert.equal(result.generated, 'The room was freezing.');
    assert.ok(streamed.length > 1);
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
      (error) => error instanceof AgentError && error.code === 'EMPTY_RESPONSE',
    );
    assert.equal(history.revisions.size, 1);
  } finally {
    await server.close();
  }
});

test('cancelling generation preserves the raw partial text on the error and creates no revision', async () => {
  const story = '# Chapter\n\nText.\n';
  const history = await createHistory(story, { checkpointInterval: 1000 });
  const server = await startFakeKoboldServer({ tokens: ['a', 'b', 'c', 'd', 'e'], tokenDelayMs: 15 });
  try {
    const controller = new AbortController();
    let sawTokens = 0;
    await assert.rejects(
      requestRewrite({
        client: new KoboldClient(server.url),
        history,
        baseRevisionId: 0,
        range: [0, story.length],
        request: 'Rewrite.',
        agentProtocol: AGENT_PROTOCOL,
        signal: controller.signal,
        onToken: (text) => {
          sawTokens = text.length;
          if (text.length >= 2) controller.abort();
        },
      }),
      (error) => error instanceof AgentError && error.code === 'ABORTED' && error.rawText.length > 0,
    );
    assert.ok(sawTokens >= 2);
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
