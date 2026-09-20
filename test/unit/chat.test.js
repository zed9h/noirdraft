import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendChatMessage, appendChatTurn, appendConversation, findChatTurnRanges, parseChatTurns } from '../../src/renderer/project/chat.js';
import { extractHeadings } from '../../src/renderer/project/headings.js';
import { parseProjectDocument } from '../../src/renderer/project/parse.js';
import { projectRoot } from '../../src/renderer/project/projection.js';
import { serializeProjectDocument } from '../../src/renderer/project/serialize.js';

test('default chat convention remains readable ordinary Markdown', () => {
  let chat = appendConversation('', '2026-09-18 — Chapter 3 / Maria');
  chat = appendChatMessage(chat, 'User', 'This reaction explains too much.');
  chat = appendChatMessage(chat, 'Agent', 'The second sentence states the emotion explicitly.');
  assert.equal(chat, [
    '# 2026-09-18 — Chapter 3 / Maria\n',
    '\n## User\n\nThis reaction explains too much.\n',
    '\n## Agent\n\nThe second sentence states the emotion explicitly.\n',
  ].join(''));
  assert.deepEqual(extractHeadings(chat, 'CHAT').map(({ path }) => path), [
    'CHAT/2026-09-18 — Chapter 3 / Maria',
    'CHAT/2026-09-18 — Chapter 3 / Maria/User',
    'CHAT/2026-09-18 — Chapter 3 / Maria/Agent',
  ]);
});

test('CHAT projection serializes under its root and round-trips CRLF', () => {
  const project = parseProjectDocument('# STORY\r\n\r\nText.\r\n');
  let chat = appendConversation('', 'General');
  chat = appendChatMessage(chat, 'User', 'Question?').replaceAll('\n', '\r\n');
  const stored = serializeProjectDocument(project, { CHAT: chat });
  const reparsed = parseProjectDocument(stored);
  assert.equal(projectRoot(reparsed, 'CHAT').text, chat);
});

test('chat helper rejects unclear participant labels', () => {
  assert.throws(() => appendChatMessage('', 'System', 'hidden'), /Unsupported chat participant/);
});

test('KoboldCpp INPUT/OUTPUT turns remain readable and preserve CRLF', () => {
  let chat = appendChatTurn('', 'Where is Maria?', 'At the window.').replaceAll('\n', '\r\n');
  chat = appendChatTurn(chat, 'What does she see?', 'Only rain.');
  assert.deepEqual(parseChatTurns(chat), [
    { input: 'Where is Maria?', output: 'At the window.' },
    { input: 'What does she see?', output: 'Only rain.' },
  ]);
  assert.match(chat, /\{\{\[INPUT\]\}\}\r\nWhere is Maria\?\r\n\{\{\[OUTPUT\]\}\}/);
});

test('chat turn ranges isolate only complete compact turns for confirmed deletion', () => {
  const chat = 'Unrelated note.\n\n{{[INPUT]}}\nFirst\n{{[OUTPUT]}}\nOne\n\n{{[INPUT]}}\nSecond\n{{[OUTPUT]}}\nTwo\n';
  const [first, second] = findChatTurnRanges(chat);
  assert.equal(chat.slice(first.from, first.to), '{{[INPUT]}}\nFirst\n{{[OUTPUT]}}\nOne\n');
  assert.equal(chat.slice(second.from, second.to), '{{[INPUT]}}\nSecond\n{{[OUTPUT]}}\nTwo\n');
});
