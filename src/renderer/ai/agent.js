import { composeContext } from './context.js';
import { KoboldError } from './kobold.js';
import { commitRevision, reconstructRevision } from '../history/graph.js';
import { hashStory } from '../history/hash.js';

export class AgentError extends Error {
  constructor(message, { code, cause, rawText } = {}) {
    super(message, { cause });
    this.name = 'AgentError';
    this.code = code;
    this.rawText = rawText;
  }
}

export const SUBMIT_CHANGE_TOOL = {
  type: 'function',
  function: {
    name: 'submit_change',
    description: 'Creates one revision at the marked selection or cursor.',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['replace', 'insert'], description: 'replace only for <selection>; insert only for <cursor/>.' },
        text: { type: 'string', description: 'For replace: complete new selection. For insert: only new characters at cursor, never surrounding context.' },
      },
      required: ['operation', 'text'], additionalProperties: false,
    },
  },
};

const MIN_TOOL_RESPONSE_TOKENS = 1024;

function assertCompleteToolResponse({ message, finishReason, raw }) {
  if (finishReason === 'length') {
    throw new AgentError('KoboldCpp stopped before completing the tool response. Increase the output limit and retry.', {
      code: 'TRUNCATED_TOOL_RESPONSE', rawText: raw,
    });
  }
  const content = String(message?.content ?? '').trim();
  if (!message?.tool_calls?.length && (/^[\[{]/.test(content) && /"(?:tool_calls|function|submit_change|text)"/.test(content))) {
    throw new AgentError('KoboldCpp returned an unparsed tool call instead of a completed response. Retry the turn.', {
      code: 'UNPARSED_TOOL_CALL', rawText: raw,
    });
  }
}

function retainTerminalLineBreak(replacement, target) {
  const terminalBreak = String(target).match(/(?:\r\n|\n)+$/)?.[0];
  if (!terminalBreak || /(?:\r\n|\n)$/.test(replacement)) return replacement;
  return `${replacement}${terminalBreak}`;
}

/**
 * Streams a bounded rewrite of `range` in an exact root revision. This never
 * mutates the checked-out root: on success the result is materialized as an
 * agent-origin sibling revision from the exact base
 * (`setCurrent: false`), so multiple proposals from one base survive as
 * preserved branches even when none of them is ever checked out. On failure,
 * the raw generated text is preserved on the thrown AgentError and no
 * revision is created at all.
 */
export async function requestRewrite({
  client,
  history,
  baseRevisionId,
  range,
  root = 'STORY',
  contextStoryText,
  request,
  metadataText = '',
  pins = [],
  references = [],
  chatTurns = [],
  promptOverride = null,
  agentProtocol,
  generationOptions = {},
  onToken,
  signal,
}) {
  const baseText = await reconstructRevision(history, baseRevisionId);
  const [from, to] = range;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to > baseText.length) {
    throw new AgentError('The selected range is invalid for its base revision.', { code: 'INVALID_RANGE' });
  }
  const target = baseText.slice(from, to);
  const composed = composeContext({
    storyText: contextStoryText ?? (root === 'STORY' ? baseText : ''),
    metadataText,
    pins,
    references,
    before: baseText.slice(0, from),
    target,
    after: baseText.slice(to),
    request,
    agentProtocol,
  });
  const prompt = promptOverride ?? [
    composed.staticPrompt,
    ...chatTurns.flatMap((turn) => ['{{[INPUT]}}', turn.input, '{{[OUTPUT]}}', turn.output]),
    '{{[INPUT]}}', composed.turnPrompt, '{{[OUTPUT]}}',
  ].join('\n');

  let generated = '';
  let nativeCalls = null;
  let nativeMessage = null;
  let nativeFinishReason = null;
  let rawResponse = null;
  try {
    const native = await client.chatCompletion({
      messages: [{ role: 'user', content: prompt }], tools: [SUBMIT_CHANGE_TOOL], toolChoice: 'auto', maxTokens: Math.max(MIN_TOOL_RESPONSE_TOKENS, generationOptions.max_length ?? 0), signal,
      });
      const { message } = native;
      generated = message.content ?? '';
      nativeCalls = message.tool_calls;
      nativeMessage = message;
      nativeFinishReason = native.finishReason;
      rawResponse = native.raw;
  } catch (cause) {
    if (cause?.name === 'AbortError') {
      throw new AgentError('Generation was cancelled.', { code: 'ABORTED', cause, rawText: generated });
    }
    throw new AgentError('KoboldCpp generation failed.', {
      code: cause instanceof KoboldError ? cause.code : 'GENERATE_FAILED',
      cause,
      rawText: cause?.rawText ?? generated,
    });
  }
  assertCompleteToolResponse({ message: nativeMessage, finishReason: nativeFinishReason, raw: rawResponse });

  const revisions = [];
  const replacements = [];
  const chatParts = [];
  const transcript = [{ role: 'user', content: prompt }];
  let calls = nativeCalls;
  let message = nativeMessage;
  const addChat = (content) => {
    const text = String(content ?? '').trim();
    if (text) chatParts.push(text);
  };
  const materialize = async (batch) => {
    const results = [];
    for (const call of batch.filter((item) => item?.function?.name === 'submit_change')) {
      let change;
      try { change = JSON.parse(call.function.arguments); } catch { change = null; }
      const operation = change?.operation;
      const replacement = change?.text;
      const expectedOperation = target.length ? 'replace' : 'insert';
      if (operation !== expectedOperation || typeof replacement !== 'string' || !replacement.trim()) {
        results.push({ call, revision: null, status: 'ignored' });
        continue;
      }
      const completeReplacement = operation === 'replace' ? retainTerminalLineBreak(replacement, target) : replacement;
      const proposedText = `${baseText.slice(0, from)}${completeReplacement}${baseText.slice(to)}`;
      replacements.push(completeReplacement);
      const revision = await commitRevision(history, baseText, proposedText, { origin: 'agent', parentId: baseRevisionId, setCurrent: false, note: null });
      revisions.push(revision);
      const candidateContext = proposedText.slice(Math.max(0, from - 400), Math.min(proposedText.length, from + completeReplacement.length + 400));
      results.push({ call, revision, status: 'created', candidateContext });
    }
    return results;
  };
  // Each assistant message precedes its citations, matching the model's
  // native message/tool-call order in persisted CHAT.
  for (let round = 0; round < 12; round += 1) {
    addChat(message?.content);
    if (!calls?.length) break;
    const results = await materialize(calls);
    const citations = results
      .filter(({ revision }) => revision)
      .map(({ revision }) => `[#${revision.id}](noirdraft://version/${root}/${revision.id})`);
    if (citations.length) chatParts.push(citations.join(' '));
    transcript.push(message, ...results.map(({ call, revision, status, reason, candidateContext }) => ({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ revision_id: revision?.id ?? null, status, reason, candidate_context: candidateContext }) })));
    try {
      const next = await client.chatCompletion({ messages: transcript, tools: [SUBMIT_CHANGE_TOOL], toolChoice: 'auto', maxTokens: Math.max(MIN_TOOL_RESPONSE_TOKENS, generationOptions.max_length ?? 0), signal });
      rawResponse = [rawResponse, next.raw].filter(Boolean).join('\n');
      assertCompleteToolResponse({ message: next.message, finishReason: next.finishReason, raw: rawResponse });
      message = next.message;
      calls = message.tool_calls;
    } catch (cause) {
      if (cause instanceof AgentError) throw cause;
      throw new AgentError('KoboldCpp could not continue the tool-call response.', { code: cause?.code ?? 'GENERATE_FAILED', cause, rawText: rawResponse ?? cause?.rawText });
    }
  }
  const chat = chatParts.join(' ');
  if (revisions.length === 0 && chat === '') throw new AgentError('KoboldCpp returned neither a change nor a chat reply.', { code: 'EMPTY_RESPONSE', rawText: rawResponse });
  return {
    revision: revisions[0] ?? null,
    revisions,
    generated: replacements[0],
    chat,
    changes: replacements,
    rawResponse: rawResponse ?? generated,
    prompt,
    unresolvedPins: composed.unresolvedPins,
    anchor: { root, baseRevisionId, range: [from, to], targetHash: await hashStory(target), before: baseText.slice(Math.max(0, from - 400), from), after: baseText.slice(to, to + 400) },
  };
}
