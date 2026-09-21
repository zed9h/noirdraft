import { composeContext } from './context.js';
import { KoboldError } from './kobold.js';
import { commitRevision, reconstructRevision } from '../history/graph.js';
import { createUnifiedDiff } from '../history/diff.js';
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

export const RETRACT_CHANGE_TOOL = {
  type: 'function',
  function: {
    name: 'retract_change',
    description: 'Retracts one proposal created earlier in this turn when its candidate context is not acceptable.',
    parameters: {
      type: 'object',
      properties: {
        revision_id: { type: 'integer', description: 'The id of a revision created earlier in this same turn.' },
      },
      required: ['revision_id'], additionalProperties: false,
    },
  },
};

export const SET_CHANGES_GOAL_TOOL = {
  type: 'function',
  function: {
    name: 'set_changes_goal',
    description: 'Commits to the number of accepted sibling revisions to make and the review strategy before submitting any change.',
    parameters: {
      type: 'object',
      properties: {
        accepted_changes: { type: 'integer', minimum: 1, description: 'Exact number of accepted revisions intended for this turn.' },
        strategy: { type: 'string', description: 'Brief private plan for how the proposals will differ and what the final review must check.' },
      },
      required: ['accepted_changes', 'strategy'], additionalProperties: false,
    },
  },
};

export const REVIEW_CHANGES_TOOL = {
  type: 'function',
  function: {
    name: 'review_changes',
    description: 'Prepares one complete review of all surviving proposals from this turn before it can be finished.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
};

export const FINISH_TURN_TOOL = {
  type: 'function',
  function: {
    name: 'finish_turn',
    description: 'Completes the turn with concise author-facing commentary after any changes are submitted.',
    parameters: {
      type: 'object',
      properties: {
        outcome: { type: 'string', enum: ['complete', 'unable'], description: 'After reviewing the author request and the proposals made this turn, complete when fulfilled and unable when it cannot be fulfilled.' },
        comment: { type: 'string', description: 'Concise commentary for the author; never repeat changed text.' },
        failure_reason: { type: 'string', description: 'Required when outcome is unable: explain why the committed goal could not be fulfilled.' },
      },
      required: ['outcome', 'comment'], additionalProperties: false,
    },
  },
};

const AGENT_TOOLS = [SET_CHANGES_GOAL_TOOL, SUBMIT_CHANGE_TOOL, RETRACT_CHANGE_TOOL, REVIEW_CHANGES_TOOL, FINISH_TURN_TOOL];

const MIN_TOOL_RESPONSE_TOKENS = 1024;

function assertCompleteToolResponse({ message, finishReason, raw, required = false }) {
  if (finishReason === 'length') {
    throw new AgentError('KoboldCpp stopped before completing the tool response. Increase the output limit and retry.', {
      code: 'TRUNCATED_TOOL_RESPONSE', rawText: raw,
    });
  }
  const content = String(message?.content ?? '').trim();
  const unparsedToolTranscript = /^[\[{]/.test(content) && /"(?:tool_calls|function|set_changes_goal|submit_change|review_changes|finish_turn|text)"/.test(content)
    || /<\|tool_call(?:\|>|>)|call:(?:set_changes_goal|submit_change|retract_change|review_changes|finish_turn)\{/.test(content)
    || /\b(?:set_changes_goal|submit_change|retract_change|review_changes|finish_turn)\s*\(/.test(content);
  if (!message?.tool_calls?.length && unparsedToolTranscript) {
    throw new AgentError('KoboldCpp returned an unparsed tool call instead of a completed response. Retry the turn.', {
      code: 'UNPARSED_TOOL_CALL', rawText: raw,
    });
  }
  if (required && !message?.tool_calls?.length) {
    throw new AgentError('KoboldCpp did not return the required native tool call. Retry the turn.', {
      code: 'MISSING_REQUIRED_TOOL_CALL', rawText: raw,
    });
  }
}

function retainTerminalLineBreak(replacement, target) {
  const terminalBreak = String(target).match(/(?:\r\n|\n)+$/)?.[0];
  if (!terminalBreak || /(?:\r\n|\n)$/.test(replacement)) return replacement;
  return `${replacement}${terminalBreak}`;
}

function changeResultJSON({ status, revision, reason, summary, goal }) {
  const result = { status };
  if (revision) result.revision_id = revision.id;
  if (reason) result.reason = reason;
  if (summary) result.turn_summary = summary;
  if (goal) result.goal = goal;
  return JSON.stringify(result);
}

function reviewResultJSON(revisions, baseText, { from, to }, resultTexts, goal, invalidCalls) {
  const remaining = goal.accepted_changes - revisions.length;
  const nextAction = remaining === 0
    ? { action: 'finish_or_correct', instruction: 'The committed count is met. Check the proposals, then finish or correct them and review again.' }
    : remaining > 0
      ? { action: 'continue', remaining_changes: remaining, instruction: `Do not call finish_turn yet. Submit ${remaining} new, distinct candidate${remaining === 1 ? '' : 's'}, then call review_changes again. Rejected duplicates are recoverable and are not a reason to give up.` }
      : { action: 'correct', excess_changes: -remaining, instruction: `Retract ${-remaining} proposal${remaining === -1 ? '' : 's'}, then call review_changes again.` };
  return JSON.stringify({
    status: 'ready',
    goal,
    accepted_changes: revisions.length,
    goal_status: remaining === 0 ? 'met' : remaining > 0 ? 'incomplete' : 'exceeded',
    invalid_calls: invalidCalls,
    next_action: nextAction,
    proposals: revisions.map((revision) => {
      const resultText = resultTexts.get(revision.id);
      const replacement = resultText.slice(from, resultText.length - (baseText.length - to));
      return {
        revision_id: revision.id,
        diff: createUnifiedDiff(baseText, resultText),
        candidate_context: resultText.slice(Math.max(0, from - 400), Math.min(resultText.length, from + replacement.length + 400)),
      };
    }),
  });
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
  const prompt = `${composed.staticPrompt}\n\n${composed.turnPrompt}`;
  const initialMessages = [
    { role: 'system', content: composed.staticPrompt },
    { role: 'user', content: composed.turnPrompt },
  ];

  let generated = '';
  let nativeCalls = null;
  let nativeMessage = null;
  let nativeFinishReason = null;
  let rawResponse = null;
  const rawTrace = [];
  try {
    const native = await client.chatCompletion({
      messages: initialMessages, tools: AGENT_TOOLS, toolChoice: 'required', maxTokens: Math.max(MIN_TOOL_RESPONSE_TOKENS, generationOptions.max_length ?? 0), temperature: generationOptions.temperature ?? 0, signal,
      });
      const { message } = native;
      generated = message.content ?? '';
      nativeCalls = message.tool_calls;
      nativeMessage = message;
      nativeFinishReason = native.finishReason;
      rawResponse = native.raw;
      if (native.raw) rawTrace.push(native.raw);
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
  assertCompleteToolResponse({ message: nativeMessage, finishReason: nativeFinishReason, raw: rawResponse, required: true });

  const revisions = [];
  const replacements = [];
  const chatParts = [];
  let invalidCalls = 0;
  let retractedChanges = 0;
  let finished = false;
  let changeCallVersion = 0;
  let reviewedChangeCallVersion = -1;
  let lastReviewRound = -1;
  let changesGoal = null;
  const transcript = [...initialMessages];
  const reconstructed = new Map([[baseRevisionId, baseText]]);
  const resultTexts = new Map();
  const findIdenticalSibling = async (text) => {
    const resultHash = await hashStory(text);
    for (const revision of history.revisions.values()) {
      if (!revision.parents.includes(baseRevisionId)) continue;
      if (revision.resultHash !== resultHash) continue;
      const existing = reconstructed.get(revision.id) ?? await reconstructRevision(history, revision.id);
      reconstructed.set(revision.id, existing);
      if (existing === text) return revision;
    }
    return null;
  };
  let calls = nativeCalls;
  let message = nativeMessage;
  const addChat = (content) => {
    const text = String(content ?? '').trim();
    if (text) chatParts.push({ type: 'chat', text });
  };
  const materialize = async (batch, round) => {
    const results = [];
    for (const call of batch.filter((item) => ['set_changes_goal', 'submit_change', 'retract_change', 'review_changes', 'finish_turn'].includes(item?.function?.name))) {
      let change;
      try { change = JSON.parse(call.function.arguments); } catch { change = null; }
      if (call.function.name === 'finish_turn') {
        if (typeof change?.comment !== 'string' || !['complete', 'unable'].includes(change?.outcome)) {
          invalidCalls += 1;
          results.push({ call, status: 'rejected', reason: 'finish_turn requires a valid outcome and comment.' });
          continue;
        }
        if (changeCallVersion > 0 && (reviewedChangeCallVersion !== changeCallVersion || lastReviewRound >= round)) {
          invalidCalls += 1;
          results.push({ call, status: 'rejected', reason: 'Call review_changes after the last proposal change, then finish in a later response.' });
          continue;
        }
        if (changesGoal && change.outcome === 'complete' && revisions.length !== changesGoal.accepted_changes) {
          invalidCalls += 1;
          results.push({ call, status: 'rejected', reason: `The goal requires ${changesGoal.accepted_changes} accepted changes; review found ${revisions.length}.` });
          continue;
        }
        if (change.outcome === 'unable' && (typeof change.failure_reason !== 'string' || !change.failure_reason.trim())) {
          invalidCalls += 1;
          results.push({ call, status: 'rejected', reason: 'finish_turn with outcome "unable" requires failure_reason.' });
          continue;
        }
        finished = true;
        results.push({ call, status: 'finished', comment: change.comment });
        continue;
      }
      if (call.function.name === 'set_changes_goal') {
        const acceptedChanges = change?.accepted_changes;
        const strategy = change?.strategy;
        if (!Number.isSafeInteger(acceptedChanges) || acceptedChanges < 1 || typeof strategy !== 'string' || !strategy.trim()) {
          invalidCalls += 1;
          results.push({ call, status: 'rejected', reason: 'set_changes_goal requires a positive integer accepted_changes and a nonempty strategy.' });
          continue;
        }
        if (changeCallVersion > 0) {
          invalidCalls += 1;
          results.push({ call, status: 'rejected', reason: 'set_changes_goal must be called before the first change call.' });
          continue;
        }
        changesGoal = { accepted_changes: acceptedChanges, strategy };
        results.push({ call, status: 'accepted', goal: changesGoal });
        continue;
      }
      if (call.function.name === 'review_changes') {
        if (!change || Object.keys(change).length !== 0) {
          invalidCalls += 1;
          results.push({ call, status: 'rejected', reason: 'review_changes takes no arguments.' });
          continue;
        }
        if (!changesGoal && changeCallVersion > 0) {
          invalidCalls += 1;
          results.push({ call, status: 'rejected', reason: 'Set a changes goal before reviewing a change turn.' });
          continue;
        }
        reviewedChangeCallVersion = changeCallVersion;
        lastReviewRound = round;
        results.push({ call, status: 'review_ready' });
        continue;
      }
      if (call.function.name === 'retract_change') {
        changeCallVersion += 1;
        const revisionId = change?.revision_id;
        const index = revisions.findIndex(({ id }) => id === revisionId);
        if (!Number.isSafeInteger(revisionId) || index === -1) {
          invalidCalls += 1;
          results.push({ call, status: 'rejected', reason: 'revision_id must identify a proposal created earlier in this turn.' });
          continue;
        }
        const [retractedRevision] = revisions.splice(index, 1);
        replacements.splice(index, 1);
        history.revisions.delete(retractedRevision.id);
        history.retiredRevisionIdFloor = Math.max(history.retiredRevisionIdFloor ?? -1, retractedRevision.id);
        retractedChanges += 1;
        results.push({ call, revision: retractedRevision, status: 'accepted', reason: 'proposal retracted' });
        continue;
      }
      const operation = change?.operation;
      const replacement = change?.text;
      changeCallVersion += 1;
      if (!changesGoal) {
        invalidCalls += 1;
        results.push({ call, status: 'rejected', reason: 'Call set_changes_goal before submit_change.' });
        continue;
      }
      const expectedOperation = target.length ? 'replace' : 'insert';
      if (operation !== expectedOperation || typeof replacement !== 'string' || !replacement.trim()) {
        invalidCalls += 1;
        results.push({ call, status: 'rejected', reason: `Expected operation "${expectedOperation}" with nonempty text.` });
        continue;
      }
      const completeReplacement = operation === 'replace' ? retainTerminalLineBreak(replacement, target) : replacement;
      const proposedText = `${baseText.slice(0, from)}${completeReplacement}${baseText.slice(to)}`;
      if (proposedText === baseText) {
        invalidCalls += 1;
        results.push({ call, status: 'rejected', reason: 'The proposed result is unchanged.' });
        continue;
      }
      const identicalRevision = await findIdenticalSibling(proposedText);
      if (identicalRevision) {
        invalidCalls += 1;
        results.push({ call, status: 'rejected', reason: `The proposed result is identical to revision #${identicalRevision.id}.` });
        continue;
      }
      replacements.push(completeReplacement);
      const revision = await commitRevision(history, baseText, proposedText, { origin: 'agent', parentId: baseRevisionId, setCurrent: false, note: null });
      resultTexts.set(revision.id, proposedText);
      revisions.push(revision);
      results.push({ call, revision, status: 'accepted' });
    }
    return results;
  };
  // Each assistant message precedes its citations, matching the model's
  // native message/tool-call order in persisted CHAT.
  for (let round = 0; round < 12; round += 1) {
    if (!calls?.length) break;
    const results = await materialize(calls, round);
    const citations = results
      .filter(({ revision }) => revision)
      .map(({ revision }) => `[#${revision.id}](noirdraft://version/${root}/${revision.id})`);
    if (citations.length) chatParts.push({ type: 'citations', revisions: results.filter(({ revision }) => revision).map(({ revision }) => revision) });
    for (const { comment } of results) addChat(comment);
    const turnSummary = { accepted_changes: revisions.length, invalid_calls: invalidCalls, retracted_changes: retractedChanges };
    const toolResults = results.map(({ call, revision, status, reason, goal }) => ({
      role: 'tool', tool_call_id: call.id,
      content: status === 'review_ready'
        ? reviewResultJSON(revisions, baseText, { from, to }, resultTexts, changesGoal, invalidCalls)
        : changeResultJSON({ status, revision, reason, goal, summary: status === 'finished' ? turnSummary : null }),
    }));
    transcript.push(message, ...toolResults);
    rawTrace.push(...toolResults.map(({ tool_call_id: callId, content }) => `[noirdraft tool result: ${callId}]\n${content}`));
    rawResponse = rawTrace.join('\n\n');
    if (finished) break;
    try {
      const next = await client.chatCompletion({ messages: transcript, tools: AGENT_TOOLS, toolChoice: 'required', maxTokens: Math.max(MIN_TOOL_RESPONSE_TOKENS, generationOptions.max_length ?? 0), temperature: generationOptions.temperature ?? 0, signal });
      if (next.raw) rawTrace.push(next.raw);
      rawResponse = rawTrace.join('\n\n');
      assertCompleteToolResponse({ message: next.message, finishReason: next.finishReason, raw: rawResponse, required: true });
      message = next.message;
      calls = message.tool_calls;
    } catch (cause) {
      if (cause instanceof AgentError) throw cause;
      throw new AgentError('KoboldCpp could not continue the tool-call response.', { code: cause?.code ?? 'GENERATE_FAILED', cause, rawText: rawResponse ?? cause?.rawText });
    }
  }
  if (!finished) {
    throw new AgentError('KoboldCpp did not finish the turn with a native finish_turn call. Retry the turn.', {
      code: 'UNFINISHED_TURN', rawText: rawResponse,
    });
  }
  const chat = chatParts.flatMap((part) => part.type === 'chat'
    ? [part.text]
    : part.revisions.filter((revision) => history.revisions.get(revision.id) === revision).map((revision) => `[#${revision.id}](noirdraft://version/${root}/${revision.id})`)).join(' ');
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
