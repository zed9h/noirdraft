import { composeContext, sliceContextRows } from './context.js';
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

export const PLAN_CHAT_TOOL = {
  type: 'function',
  function: {
    name: 'plan_chat',
    description: 'Plans a reply without creating or planning a manuscript change. Use for greetings, discussion, questions, critique, explanation, or any request that does not ask to edit.',
    parameters: {
      type: 'object',
      properties: {
        intent: { type: 'string', description: 'Brief purpose and approach for the author-facing reply.' },
        proposed_message: { type: 'string', description: 'The complete proposed reply for review before it is sent.' },
      },
      required: ['intent', 'proposed_message'], additionalProperties: false,
    },
  },
};

export const PROPOSE_CHANGE_TOOL = {
  type: 'function',
  function: {
    name: 'propose_change',
    description: 'Creates one revision for the marked selection or cursor.',
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
    description: 'Retracts one change created earlier in this turn when it is not acceptable.',
    parameters: {
      type: 'object',
      properties: {
        revision_id: { type: 'integer', description: 'The id of a revision created earlier in this same turn.' },
      },
      required: ['revision_id'], additionalProperties: false,
    },
  },
};

export const PLAN_CHANGES_TOOL = {
  type: 'function',
  function: {
    name: 'plan_changes',
    description: 'States the number and creative purpose of the changes you intend to submit next. The first call records the turn intent; later calls prepare another group. NoirDraft manages workflow state itself.',
    parameters: {
      type: 'object',
      properties: {
        change_alternatives_count: { type: 'integer', minimum: 1, description: 'How many distinct versions of this change you intend to submit. On the first call this is the total turn intent; later calls describe only the next group.' },
        intent: { type: 'string', description: 'Creative purpose of this group. Make constraints or the unresolved difficulty explicit, especially for a retry.' },
      },
      required: ['change_alternatives_count', 'intent'], additionalProperties: false,
    },
  },
};

export const REVIEW_CHANGES_TOOL = {
  type: 'function',
  function: {
    name: 'review_changes',
    description: 'Prepares one complete review of all surviving changes from this turn before it can be finished.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
};

export const FINISH_CHANGES_TOOL = {
  type: 'function',
  function: {
    name: 'finish_changes',
    description: 'Completes a change turn with concise author-facing commentary after changes are reviewed.',
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

export const SEND_CHAT_TOOL = {
  type: 'function',
  function: {
    name: 'send_chat',
    description: 'Sends the latest reviewed chat proposal unchanged only when it is a complete author-facing reply, not a promise to make a manuscript change. Takes no arguments.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
};

const AGENT_TOOLS = [PLAN_CHAT_TOOL, SEND_CHAT_TOOL, PLAN_CHANGES_TOOL, PROPOSE_CHANGE_TOOL, RETRACT_CHANGE_TOOL, REVIEW_CHANGES_TOOL, FINISH_CHANGES_TOOL];

const MIN_TOOL_RESPONSE_TOKENS = 1024;

function assertCompleteToolResponse({ message, finishReason, raw, required = false }) {
  if (finishReason === 'length') {
    throw new AgentError('KoboldCpp stopped before completing the tool response. Increase the output limit and retry.', {
      code: 'TRUNCATED_TOOL_RESPONSE', rawText: raw,
    });
  }
  const content = String(message?.content ?? '').trim();
  const unparsedToolTranscript = /^[\[{]/.test(content) && /"(?:tool_calls|function|plan_chat|send_chat|plan_changes|propose_change|review_changes|finish_changes|text)"/.test(content)
    || /<\|tool_call(?:\|>|>)|call:(?:plan_chat|send_chat|plan_changes|propose_change|retract_change|review_changes|finish_changes)\{/.test(content)
    || /\b(?:plan_chat|send_chat|plan_changes|propose_change|retract_change|review_changes|finish_changes)\s*\(/.test(content);
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

function promisesAChange(message) {
  return /\b(?:i(?:'ll| will| can)|we(?:'ll| will| can)|let me)\b[\s\S]{0,100}\b(?:add|insert|replace|write|rewrite|redo|revise|edit|expand|shorten|remove|delete|rephrase|continue|draft|compose|polish|translate|restructure|change|update)\b/i.test(String(message));
}

function changeResultJSON({ status, revision, reason, summary, allowedCalls, recommendedAction }) {
  const result = { status };
  if (revision) result.revision_id = revision.id;
  if (reason) result.reason = reason;
  if (summary) result.turn_summary = summary;
  if (allowedCalls?.length) result.allowed_calls = allowedCalls;
  if (recommendedAction) result.recommended_action = recommendedAction;
  return JSON.stringify(result);
}

function addedDiffText(before, after) {
  const added = createUnifiedDiff(before, after)
    .split(/\r?\n/)
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'));
  return added.length ? added.join('\n') : '+(no added text)';
}

function reviewResultText(revisions, baseText, { from, to }, resultTexts, goal, currentPlan, recovery, formatWarnings, invalidCalls) {
  const remaining = goal.change_alternatives_count - revisions.length;
  const nextAction = formatWarnings.length
    ? { action: 'correct_formatting', instruction: 'Retract the warned proposals and submit corrected siblings before treating the count as progress.' }
    : remaining === 0
    ? { action: 'finish_or_correct', instruction: 'The objective is met. Retract weak alternatives if needed; otherwise finish the turn.' }
    : recovery.stage === 'direct_retry'
      ? { action: 'continue', remaining_changes: Math.max(0, remaining), instruction: 'First recovery: retry directly with fresh, distinct candidates. Do not finish yet; rejected duplicates are recoverable.' }
      : recovery.stage === 'plan_retry'
        ? { action: 'plan_next_group', instruction: 'Second recovery: call plan_changes with a concrete change-alternatives count and intent, then submit that group.' }
        : recovery.stage === 'creative_retry'
          ? { action: 'continue_creatively', remaining_changes: Math.max(0, remaining), instruction: 'Final recovery: use imaginative, broad, metaphorical, or otherwise less obvious candidates that still honor the author’s intent. Then review again.' }
          : { action: 'give_up', instruction: 'The managed recovery attempts are exhausted. Explain the unresolved issue to the author with finish_changes outcome "unable" and failure_reason.' };
  const progress = remaining === 0
    ? `Turn intent met — ${revisions.length} alternatives are ready.`
    : remaining > 0
      ? `Not complete — ${revisions.length} alternatives are ready; ${remaining} still needed.`
      : `Over the turn intent — ${revisions.length} alternatives are ready; ${-remaining} should be retracted.`;
  const warnings = formatWarnings.length
    ? ` Formatting to correct: ${formatWarnings.map((warning) => `revision #${warning.revision_id} — ${warning.message}`).join('; ')}.`
    : '';
  const lines = [
    'NOIRDRAFT REVIEW',
    `Objective: submit ${goal.change_alternatives_count} alternatives for this change — ${goal.intent}`,
    `Progress: ${progress}`,
    `Pending: submit ${currentPlan.change_alternatives_count} alternatives for this change — ${currentPlan.intent}`,
    'Editorial concern: Read every proposed result as part of the full surrounding passage. Does it fulfill the author’s intent while remaining grammatical, syntactically complete, meaningful, coherent with the surrounding prose, and properly formatted? Do not accept a lazy literal substitution of the request that leaves an unnatural or nonsensical phrase. Act as a responsible writer: retract every revision that fails this in-context editorial check, then submit a corrected sibling if needed.',
    `Managerial concern: ${nextAction.instruction}${warnings}`,
  ];
  if (revisions.length === 0) {
    const attempted = invalidCalls > 0
      ? ' No valid change was created; rejected calls do not create revisions.'
      : ' No change is currently available for inspection.';
    lines.push(`No valid changes to inspect.${attempted}`);
    return lines.join('\n');
  }
  lines.push('Proposals to inspect:');
  for (const revision of revisions) {
    lines.push(`----- REVISION #${revision.id} -----`);
    lines.push(addedDiffText(baseText, resultTexts.get(revision.id)));
  }
  lines.push('----- END REVISIONS -----');
  return lines.join('\n');
}

function insertionFormatWarnings(revisions, baseText, { from, to }, resultTexts) {
  if (from !== to) return [];
  const left = baseText.at(from - 1) ?? '';
  if (!/[\p{L}\p{N}]/u.test(left)) return [];
  return revisions.flatMap((revision) => {
    const resultText = resultTexts.get(revision.id);
    const inserted = resultText.slice(from, resultText.length - (baseText.length - to));
    if (!/^[\p{L}\p{N}]/u.test(inserted)) return [];
    return [{
      revision_id: revision.id,
      message: 'The inserted text joins directly to the word on its left. If this is a separate word, retract it and resubmit with the required leading separator, such as a space.',
    }];
  });
}

function isWordCharacter(value) {
  return /[\p{L}\p{N}]/u.test(value);
}

function normalizeInsertionSpacing(text, before, after) {
  let insertion = String(text);
  if (isWordCharacter(before) && isWordCharacter(insertion[0] ?? '')) insertion = ` ${insertion}`;
  if (isWordCharacter(insertion.at(-1) ?? '') && isWordCharacter(after)) insertion = `${insertion} `;
  return insertion;
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
  chatHistory = [],
  contextRows = 12,
  agentProtocol,
  generationOptions = {},
  onToken,
  onProgress,
  signal,
}) {
  const baseText = await reconstructRevision(history, baseRevisionId);
  const [from, to] = range;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to > baseText.length) {
    throw new AgentError('The selected range is invalid for its base revision.', { code: 'INVALID_RANGE' });
  }
  const localContext = sliceContextRows(baseText, from, to, contextRows);
  const target = localContext.target;
  const composed = composeContext({
    storyText: contextStoryText ?? (root === 'STORY' ? baseText : ''),
    metadataText,
    pins,
    references,
    before: localContext.before,
    target,
    after: localContext.after,
    request,
    agentProtocol,
    chatHistory,
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
  let currentPlan = null;
  let chatPlan = null;
  let failedReviews = 0;
  let giveUpAllowed = false;
  let currentPlanAvailable = false;
  const currentChat = () => chatParts.flatMap((part) => part.type === 'chat'
    ? [part.text]
    : part.revisions.filter((revision) => history.revisions.get(revision.id) === revision).map((revision) => `[#${revision.id}](noirdraft://version/${root}/${revision.id})`)).join(' ');
  const reportProgress = () => onProgress?.({
    rawResponse: rawResponse ?? generated,
    chat: currentChat(),
    revisions: [...revisions],
    intent: currentPlan ?? chatPlan,
  });
  const allowedNextCalls = () => {
    if (chatPlan) return ['plan_chat', 'plan_changes', 'send_chat'];
    if (!changesGoal) {
      return ['plan_chat', 'plan_changes'];
    }
    const actions = ['plan_changes', 'propose_change', 'retract_change'];
    if (changeCallVersion > 0 && reviewedChangeCallVersion !== changeCallVersion) {
      actions.push('review_changes');
    }
    if (changeCallVersion > 0 && reviewedChangeCallVersion === changeCallVersion && lastReviewRound >= 0) {
      if (revisions.length === changesGoal.change_alternatives_count) {
        actions.push('finish_changes');
      } else if (giveUpAllowed) {
        actions.push('finish_changes');
      }
    }
    return actions;
  };
  const recommendedAction = () => {
    if (chatPlan) return { call: 'send_chat', attempt: 'Send the reviewed proposed reply unchanged, call plan_chat to replace it, or call plan_changes if you now judge that the author asked for an edit.' };
    if (!changesGoal) return { call: 'plan_chat or plan_changes', attempt: 'Use plan_chat when no edit was requested; otherwise state how many versions of the change you intend to submit and their creative intent.' };
    if (changeCallVersion > 0 && reviewedChangeCallVersion !== changeCallVersion) {
      return { call: 'review_changes', attempt: 'Inspect the changes or retractions made since the last review before trying to finish.' };
    }
    if (reviewedChangeCallVersion === changeCallVersion && revisions.length === changesGoal.change_alternatives_count) {
      return { call: 'finish_changes', attempt: 'Use outcome "complete" and concise commentary, unless you first retract a weak proposal.' };
    }
    if (giveUpAllowed) return { call: 'finish_changes', attempt: 'Use outcome "unable" with failure_reason explaining the unresolved issue to the author.' };
    if (currentPlanAvailable) return { call: 'propose_change', attempt: 'Apply the current plan with a fresh, distinct version of the change.' };
    if (failedReviews === 2) return { call: 'plan_changes', attempt: 'State a concrete change-alternatives count and fresh creative intent, then submit distinct changes.' };
    return { call: 'propose_change', attempt: 'Propose a fresh, distinct version of the change that moves the work toward the turn intent.' };
  };
  const chatReviewText = (chatIntent) => [
    'NOIRDRAFT CHAT REVIEW',
    `Intent: ${chatIntent.intent}`,
    'Editorial concern: Is this author-facing reply accurate, helpful, and appropriately concise? If the author would be better served by a versioned manuscript change instead, call plan_changes rather than sending chat.',
    'Managerial concern: Before send_chat, check whether this reply promises, agrees to, or clearly entails a manuscript change. If it does, do not send it and do not leave the author waiting for a second confirmation: call plan_changes now, make the change, and use finish_changes for any commentary. Only send_chat a complete conversational reply. Otherwise, call send_chat to publish this reply unchanged, or plan_chat to replace it.',
    '----- PROPOSED REPLY -----',
    chatIntent.proposed_message,
    '----- END OF REPLY -----',
  ].join('\n');
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
  reportProgress();
  const addChat = (content) => {
    const text = String(content ?? '').trim();
    if (text) chatParts.push({ type: 'chat', text });
  };
  const materialize = async (toolCalls, round) => {
    const results = [];
    for (const call of toolCalls.filter((item) => ['plan_chat', 'send_chat', 'plan_changes', 'propose_change', 'retract_change', 'review_changes', 'finish_changes'].includes(item?.function?.name))) {
      let change;
      try { change = JSON.parse(call.function.arguments); } catch { change = null; }
      if (call.function.name === 'plan_chat') {
        if (typeof change?.intent !== 'string' || !change.intent.trim() || typeof change?.proposed_message !== 'string' || !change.proposed_message.trim()) {
          invalidCalls += 1;
          results.push({ call, status: 'rejected', reason: 'plan_chat requires nonempty intent and proposed_message.' });
          continue;
        }
        if (changesGoal || changeCallVersion > 0) {
          invalidCalls += 1;
          results.push({ call, status: 'rejected', reason: 'plan_chat is only for a no-edit request before planning or proposing a change. Use finish_changes to conclude a change turn.' });
          continue;
        }
        chatPlan = { intent: change.intent.trim(), proposed_message: change.proposed_message.trim() };
        results.push({ call, status: 'chat_review', chat_intent: chatPlan });
        continue;
      }
      if (call.function.name === 'send_chat') {
        if (!change || Object.keys(change).length !== 0 || !chatPlan) {
          invalidCalls += 1;
          results.push({ call, status: 'rejected', reason: 'send_chat takes no arguments and requires a prior plan_chat proposal.' });
          continue;
        }
        if (promisesAChange(chatPlan.proposed_message)) {
          invalidCalls += 1;
          results.push({
            call,
            status: 'rejected',
            reason: 'This chat reply promises a manuscript change. Do not send it before doing the work.',
            allowedCalls: ['plan_changes', 'plan_chat'],
            recommendedAction: { call: 'plan_changes', attempt: 'Switch to the change flow now, create the required revisions, then use finish_changes for any author-facing commentary.' },
          });
          continue;
        }
        finished = true;
        results.push({ call, status: 'finished', comment: chatPlan.proposed_message });
        continue;
      }
      if (call.function.name === 'finish_changes') {
        if (typeof change?.comment !== 'string' || !['complete', 'unable'].includes(change?.outcome)) {
          invalidCalls += 1;
          results.push({ call, status: 'rejected', reason: 'finish_changes requires a valid outcome and comment.' });
          continue;
        }
        if (chatPlan) {
          invalidCalls += 1;
          results.push({ call, status: 'rejected', reason: 'This turn has a reviewed chat proposal. Use send_chat to publish it unchanged, or plan_chat to replace it.' });
          continue;
        }
        if (!changesGoal && changeCallVersion === 0) {
          invalidCalls += 1;
          results.push({ call, status: 'rejected', reason: 'Call plan_changes before finish_changes for an edit request.' });
          continue;
        }
        if (changeCallVersion > 0 && (reviewedChangeCallVersion !== changeCallVersion || lastReviewRound >= round)) {
          invalidCalls += 1;
          results.push({ call, status: 'rejected', reason: 'Call review_changes after the last change, then finish in a later response.' });
          continue;
        }
        if (changesGoal && change.outcome === 'complete' && revisions.length !== changesGoal.change_alternatives_count) {
          invalidCalls += 1;
          results.push({ call, status: 'rejected', reason: `The turn intent is ${changesGoal.change_alternatives_count} alternatives for this change; review found ${revisions.length}.` });
          continue;
        }
        if (change.outcome === 'unable' && (typeof change.failure_reason !== 'string' || !change.failure_reason.trim())) {
          invalidCalls += 1;
          results.push({ call, status: 'rejected', reason: 'finish_changes with outcome "unable" requires failure_reason.' });
          continue;
        }
        if (changesGoal && change.outcome === 'unable' && revisions.length !== changesGoal.change_alternatives_count && !giveUpAllowed) {
          invalidCalls += 1;
          results.push({ call, status: 'rejected', reason: 'Follow the current managed recovery action before declaring the goal unable.' });
          continue;
        }
        finished = true;
        results.push({ call, status: 'finished', comment: change.comment });
        continue;
      }
      if (call.function.name === 'plan_changes') {
        const changeAlternativesCount = change?.change_alternatives_count;
        const intent = change?.intent;
        if (!Number.isSafeInteger(changeAlternativesCount) || changeAlternativesCount < 1 || typeof intent !== 'string' || !intent.trim()) {
          invalidCalls += 1;
          results.push({ call, status: 'rejected', reason: 'plan_changes requires a positive change_alternatives_count and a nonempty intent.' });
          continue;
        }
        if (chatPlan) chatPlan = null;
        const isInitialPlan = !changesGoal;
        if (isInitialPlan) changesGoal = {
          change_alternatives_count: changeAlternativesCount,
          intent: intent.trim(),
        };
        currentPlanAvailable = true;
        const plan = {
          change_alternatives_count: changeAlternativesCount,
          intent: intent.trim(),
        };
        currentPlan = plan;
        results.push({ call, status: 'accepted' });
        continue;
      }
      if (call.function.name === 'review_changes') {
        if (!change || Object.keys(change).length !== 0) {
          invalidCalls += 1;
          results.push({ call, status: 'rejected', reason: 'review_changes takes no arguments.' });
          continue;
        }
        if (!changesGoal) {
          invalidCalls += 1;
          results.push({ call, status: 'rejected', reason: 'review_changes requires an initial plan_changes call.' });
          continue;
        }
        if (changeCallVersion === 0 || reviewedChangeCallVersion === changeCallVersion) {
          invalidCalls += 1;
          results.push({ call, status: 'rejected', reason: 'review_changes requires a propose_change or retract_change since the previous review.' });
          continue;
        }
        reviewedChangeCallVersion = changeCallVersion;
        lastReviewRound = round;
        const goalStatus = changesGoal && revisions.length === changesGoal.change_alternatives_count ? 'met' : 'mismatched';
        const formatWarnings = insertionFormatWarnings(revisions, baseText, { from, to }, resultTexts);
        if (formatWarnings.length) {
          giveUpAllowed = false;
          results.push({ call, status: 'review_ready', recovery: { attempt: failedReviews, stage: 'correct_formatting' }, format_warnings: formatWarnings });
        } else if (goalStatus === 'met') {
          giveUpAllowed = false;
          results.push({ call, status: 'review_ready', recovery: { attempt: failedReviews, stage: 'met' } });
        } else {
          failedReviews += 1;
          const stage = failedReviews === 1 ? 'direct_retry' : failedReviews === 2 ? 'plan_retry' : failedReviews === 3 ? 'creative_retry' : 'give_up';
          giveUpAllowed = stage === 'give_up';
          results.push({ call, status: 'review_ready', recovery: { attempt: failedReviews, stage } });
        }
        continue;
      }
      if (call.function.name === 'retract_change') {
        changeCallVersion += 1;
        giveUpAllowed = false;
        currentPlanAvailable = false;
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
      if (!changesGoal) {
        invalidCalls += 1;
        results.push({ call, status: 'rejected', reason: 'Call plan_changes first to state the change-alternatives count and creative intent before propose_change.' });
        continue;
      }
      changeCallVersion += 1;
      giveUpAllowed = false;
      currentPlanAvailable = false;
      const expectedOperation = target.length ? 'replace' : 'insert';
      if (operation !== expectedOperation || typeof replacement !== 'string' || !replacement.trim()) {
        invalidCalls += 1;
        results.push({ call, status: 'rejected', reason: `Expected operation "${expectedOperation}" with nonempty text.` });
        continue;
      }
      const completeReplacement = operation === 'replace'
        ? retainTerminalLineBreak(replacement, target)
        : normalizeInsertionSpacing(replacement, baseText.at(from - 1) ?? '', baseText.at(to) ?? '');
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
  for (let round = 0; round < 32; round += 1) {
    if (!calls?.length) break;
    const results = await materialize(calls, round);
    const citations = results
      .filter(({ revision }) => revision)
      .map(({ revision }) => `[#${revision.id}](noirdraft://version/${root}/${revision.id})`);
    if (citations.length) chatParts.push({ type: 'citations', revisions: results.filter(({ revision }) => revision).map(({ revision }) => revision) });
    for (const { comment } of results) addChat(comment);
    const turnSummary = { changes_ready: revisions.length, invalid_calls: invalidCalls, retracted_changes: retractedChanges };
    const toolResults = results.map(({ call, revision, status, reason, allowedCalls, recommendedAction: resultRecommendedAction, chat_intent: chatIntent, recovery, format_warnings: formatWarnings = [] }) => ({
      role: 'tool', tool_call_id: call.id,
      content: status === 'review_ready'
        ? reviewResultText(revisions, baseText, { from, to }, resultTexts, changesGoal, currentPlan, recovery, formatWarnings, invalidCalls)
        : status === 'chat_review'
          ? chatReviewText(chatIntent)
          : changeResultJSON({ status, revision, reason, allowedCalls: status === 'rejected' ? (allowedCalls ?? allowedNextCalls()) : null, recommendedAction: status === 'rejected' ? (resultRecommendedAction ?? recommendedAction()) : null, summary: status === 'finished' ? turnSummary : null }),
    }));
    transcript.push(message, ...toolResults);
    rawTrace.push(...toolResults.map(({ tool_call_id: callId, content }) => `[noirdraft tool result: ${callId}]\n${content}\n[noirdraft end tool result: ${callId}]`));
    rawResponse = rawTrace.join('\n\n');
    reportProgress();
    if (finished) break;
    try {
      const next = await client.chatCompletion({ messages: transcript, tools: AGENT_TOOLS, toolChoice: 'required', maxTokens: Math.max(MIN_TOOL_RESPONSE_TOKENS, generationOptions.max_length ?? 0), temperature: generationOptions.temperature ?? 0, signal });
      if (next.raw) rawTrace.push(next.raw);
      rawResponse = rawTrace.join('\n\n');
      reportProgress();
      assertCompleteToolResponse({ message: next.message, finishReason: next.finishReason, raw: rawResponse, required: true });
      message = next.message;
      calls = message.tool_calls;
    } catch (cause) {
      if (cause instanceof AgentError) throw cause;
      throw new AgentError('KoboldCpp could not continue the tool-call response.', { code: cause?.code ?? 'GENERATE_FAILED', cause, rawText: rawResponse ?? cause?.rawText });
    }
  }
  if (!finished) {
    throw new AgentError('KoboldCpp did not finish the turn with a native completion call. Retry the turn.', {
      code: 'UNFINISHED_TURN', rawText: rawResponse,
    });
  }
  const chat = currentChat();
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
