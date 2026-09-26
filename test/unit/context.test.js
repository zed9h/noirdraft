import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allocateContextBudget, composeContext, ContextBudgetError, sliceContextRows } from '../../src/renderer/ai/context.js';

const storyText = '# Chapter\n\nMaria walked in. The room was cold.\n\nShe sat down slowly.\n';
const metadataText = '# Characters\n\n## Maria\n\nA cautious investigator.\n';

test('composeContext resolves pins and lays out clearly delimited, ordered sections', () => {
  const result = composeContext({
    storyText,
    metadataText,
    pins: ['METADATA/Characters/Maria'],
    before: 'Maria walked in.',
    target: 'The room was cold.',
    after: 'She sat down slowly.',
    request: 'Make the room colder.',
    agentProtocol: 'Reply with only the replacement prose.',
  });
  assert.deepEqual(result.unresolvedPins, []);
  assert.deepEqual(result.components.map((component) => component.label), [
    'AGENT PROTOCOL',
    'REFERENCE METADATA/Characters/Maria',
    'CONTEXT BEFORE CURSOR',
    'CURSOR',
    'CONTEXT AFTER CURSOR',
    'REQUEST',
  ]);
  assert.ok(result.staticPrompt.startsWith('<noirdraft_static>'));
  assert.ok(result.staticPrompt.includes('<instructions><![CDATA[Reply with only the replacement prose.]]></instructions>'));
  assert.ok(result.staticPrompt.includes('<reference label="REFERENCE METADATA/Characters/Maria"><![CDATA[## Maria'));
  assert.ok(result.prompt.includes('A cautious investigator.'));
  assert.match(result.turnPrompt, /<noirdraft_turn>[\s\S]*<before><!\[CDATA\[Maria walked in\.\]\]><\/before>/);
  assert.match(result.turnPrompt, /<selection><!\[CDATA\[The room was cold\.\]\]><\/selection>/);
  assert.match(result.turnPrompt, /<request><!\[CDATA\[Make the room colder\.\]\]><\/request>/);
});

test('composeContext reports an unresolved pin explicitly instead of silently dropping it', () => {
  const result = composeContext({
    storyText,
    metadataText,
    pins: ['METADATA/Characters/Elias'],
    target: 'The room was cold.',
    request: 'Rewrite.',
  });
  assert.equal(result.unresolvedPins.length, 1);
  assert.equal(result.unresolvedPins[0].path, 'METADATA/Characters/Elias');
  assert.equal(result.unresolvedPins[0].status, 'unresolved');
  assert.ok(!result.components.some((component) => component.label.includes('Elias')));
});

test('composeContext includes only explicitly supplied chat history', () => {
  const result = composeContext({ storyText, target: 'The room was cold.', request: 'Rewrite.' });
  assert.ok(!result.prompt.includes('CHAT'));
  assert.equal(result.components.filter((component) => component.label.startsWith('REFERENCE')).length, 0);

  const withReference = composeContext({
    storyText,
    target: 'The room was cold.',
    request: 'Rewrite.',
    references: [{ id: 'passage:3', label: 'STORY/Chapter/Earlier scene', text: 'It had rained all week.' }],
  });
  assert.ok(withReference.staticPrompt.includes('<reference label="REFERENCE STORY/Chapter/Earlier scene"><![CDATA[It had rained all week.]]></reference>'));

  const withChat = composeContext({ storyText, request: 'Continue.', chatHistory: [{ request: 'Hello.', reply: 'Hi there.' }] });
  assert.match(withChat.turnPrompt, /<noirdraft_chat_history>[\s\S]*<request><!\[CDATA\[Hello\.\]\]><\/request>[\s\S]*<reply><!\[CDATA\[Hi there\.\]\]><\/reply>/);
});

test('composeContext omits empty optional sections rather than emitting blank labels', () => {
  const result = composeContext({ storyText, target: 'The room was cold.', request: '' });
  assert.deepEqual(result.components.map((component) => component.id), ['cursor']);
});

test('composeContext uses a bounded XML document context packet', () => {
  const result = composeContext({ storyText, request: 'Test the chat.' });
  assert.match(result.turnPrompt, /<cursor><!\[CDATA\[\]\]><\/cursor>/);
  assert.match(result.turnPrompt, /<request><!\[CDATA\[Test the chat\.\]\]><\/request>/);
});

test('sliceContextRows keeps a configurable number of rows around a selection', () => {
  const result = sliceContextRows('one\ntwo\nthree\nfour\nfive', 8, 13, 2);
  assert.deepEqual(result, { before: 'two\n', target: 'three', after: '\nfour' });
});

test('allocateContextBudget sums deterministic token counts and reports fit against the reserved budget', async () => {
  const components = [
    { id: 'a', label: 'A', text: 'one two three' },
    { id: 'b', label: 'B', text: 'four five' },
  ];
  const countTokens = (text) => text.split(/\s+/).filter(Boolean).length;
  const result = await allocateContextBudget(components, { contextLength: 10, reservedGeneration: 2, countTokens });
  assert.deepEqual(result.usage, [{ id: 'a', label: 'A', tokens: 3 }, { id: 'b', label: 'B', tokens: 2 }]);
  assert.equal(result.total, 5);
  assert.equal(result.available, 8);
  assert.equal(result.fits, true);
  assert.equal(result.overBy, 0);
});

test('allocateContextBudget reports exactly how far a packet exceeds its budget', async () => {
  const components = [{ id: 'a', label: 'A', text: 'x'.repeat(20) }];
  const result = await allocateContextBudget(components, {
    contextLength: 10,
    reservedGeneration: 4,
    countTokens: (text) => text.length,
  });
  assert.equal(result.fits, false);
  assert.equal(result.available, 6);
  assert.equal(result.total, 20);
  assert.equal(result.overBy, 14);
});

test('allocateContextBudget refuses to guess without a reported context length', async () => {
  await assert.rejects(
    allocateContextBudget([], { contextLength: undefined, countTokens: () => 0 }),
    (error) => error instanceof ContextBudgetError && error.code === 'MISSING_CONTEXT_LENGTH',
  );
});

test('allocateContextBudget works with an async countTokens (e.g. the real server)', async () => {
  const countTokens = async (text) => text.length;
  const result = await allocateContextBudget([{ id: 'a', label: 'A', text: 'abcd' }], {
    contextLength: 100,
    reservedGeneration: 0,
    countTokens,
  });
  assert.equal(result.total, 4);
});

test('a retry adds a note asking for something different and novel, and a normal turn does not', () => {
  const base = { storyText: 'Story.', request: 'Again.', agentProtocol: 'Protocol.' };
  assert.doesNotMatch(composeContext(base).turnPrompt, /<retry>/);
  const retried = composeContext({ ...base, retry: true }).turnPrompt;
  assert.match(retried, /<retry>/);
  assert.match(retried, /different and novel/);
});
