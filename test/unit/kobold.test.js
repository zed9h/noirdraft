import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KoboldClient, KoboldError } from '../../src/renderer/ai/kobold.js';
import { startFakeKoboldServer } from '../support/fake-kobold-server.js';

test('checkAvailability reports a clean disconnected state when nothing is listening', async () => {
  const client = new KoboldClient('http://127.0.0.1:1');
  const result = await client.checkAvailability();
  assert.deepEqual(result, { available: false });
});

test('checkAvailability, context length, and token count succeed against the fake server', async () => {
  const server = await startFakeKoboldServer({ model: 'gemma-test', contextLength: 8192 });
  try {
    const client = new KoboldClient(server.url);
    assert.deepEqual(await client.checkAvailability(), { available: true, model: 'gemma-test' });
    assert.equal(await client.fetchContextLength(), 8192);
    assert.equal(await client.countTokens('four little words'), 3);
  } finally {
    await server.close();
  }
});

test('ordinary chat completions keep the literal JSON response alongside plain assistant content', async () => {
  const server = await startFakeKoboldServer({ tokens: ['A concise reply.'] });
  try {
    const result = await new KoboldClient(server.url).chatCompletion({ messages: [{ role: 'user', content: 'Hello.' }] });
    assert.equal(result.message.content, 'A concise reply.');
    assert.equal(JSON.parse(result.raw).choices[0].message.content, 'A concise reply.');
  } finally {
    await server.close();
  }
});

test('a rejected chat completion retains its literal error body for session inspection', async () => {
  const client = new KoboldClient('http://fake.invalid', { fetch: async () => new Response('{"error":"context exhausted"}', { status: 400 }) });
  await assert.rejects(
    client.chatCompletion({ messages: [{ role: 'user', content: 'Hello.' }] }),
    (error) => error instanceof KoboldError && error.code === 'CHAT_COMPLETION_FAILED' && error.rawText === '{"error":"context exhausted"}',
  );
});

test('generateStream yields exactly the fake server tokens in order', async () => {
  const server = await startFakeKoboldServer({ tokens: ['One', ' ', 'Two', ' ', 'Three'], tokenDelayMs: 1 });
  try {
    const client = new KoboldClient(server.url);
    const received = [];
    for await (const token of client.generateStream({ prompt: 'go' })) received.push(token);
    assert.deepEqual(received, ['One', ' ', 'Two', ' ', 'Three']);
  } finally {
    await server.close();
  }
});

test('generateStream can be cancelled via AbortSignal without throwing an unhandled error', async () => {
  const server = await startFakeKoboldServer({ tokens: ['a', 'b', 'c', 'd', 'e'], tokenDelayMs: 10 });
  try {
    const client = new KoboldClient(server.url);
    const controller = new AbortController();
    const received = [];
    const iterate = async () => {
      for await (const token of client.generateStream({ prompt: 'go' }, { signal: controller.signal })) {
        received.push(token);
        if (received.length === 2) controller.abort();
      }
    };
    await assert.rejects(iterate(), (error) => error.name === 'AbortError' || error instanceof DOMException);
    assert.ok(received.length >= 2);
    assert.ok(received.length < 5);
  } finally {
    await server.close();
  }
});

test('malformed SSE records are skipped without breaking the surrounding stream', async () => {
  const server = await startFakeKoboldServer({ tokens: ['first', 'skipped', 'third'], malformedStream: true, tokenDelayMs: 1 });
  try {
    const client = new KoboldClient(server.url);
    const received = [];
    for await (const token of client.generateStream({ prompt: 'go' })) received.push(token);
    assert.deepEqual(received, ['first', 'third']);
  } finally {
    await server.close();
  }
});

test('a malformed JSON response is contained as a typed KoboldError', async () => {
  const server = await startFakeKoboldServer({ malformedJSON: true });
  try {
    const client = new KoboldClient(server.url);
    await assert.rejects(
      client.fetchContextLength(),
      (error) => error instanceof KoboldError && error.code === 'MALFORMED_RESPONSE',
    );
    await assert.rejects(
      client.countTokens('hello'),
      (error) => error instanceof KoboldError && error.code === 'MALFORMED_RESPONSE',
    );
  } finally {
    await server.close();
  }
});

test('an unavailable server surfaces a typed KoboldError for context length and tokens', async () => {
  const client = new KoboldClient('http://127.0.0.1:1');
  await assert.rejects(client.fetchContextLength(), (error) => error instanceof KoboldError && error.code === 'UNAVAILABLE');
  await assert.rejects(client.countTokens('hi'), (error) => error instanceof KoboldError && error.code === 'UNAVAILABLE');
});

test('abort notifies the server so a genkey stops producing further tokens', async () => {
  const server = await startFakeKoboldServer({ tokens: ['a', 'b', 'c', 'd', 'e'], tokenDelayMs: 5 });
  try {
    const client = new KoboldClient(server.url);
    const received = [];
    const genkey = 'test-genkey';
    const streaming = (async () => {
      for await (const token of client.generateStream({ prompt: 'go', genkey })) {
        received.push(token);
        if (received.length === 1) await client.abort(genkey);
      }
    })();
    await streaming;
    assert.ok(received.length < 5);
  } finally {
    await server.close();
  }
});
