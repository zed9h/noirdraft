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
        intent: { type: 'string', description: 'Brief creative purpose of the changes, in your own words.' },
        acceptance_criteria: { type: 'string', description: 'Optional concrete qualities the changes should satisfy.' },
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

const AGENT_TOOLS = [PLAN_CHANGES_TOOL, SUBMIT_CHANGE_TOOL, RETRACT_CHANGE_TOOL, REVIEW_CHANGES_TOOL, FINISH_TURN_TOOL];

const MIN_TOOL_RESPONSE_TOKENS = 1024;

function assertCompleteToolResponse({ message, finishReason, raw, required = false }) {
  if (finishReason === 'length') {
    throw new AgentError('KoboldCpp stopped before completing the tool response. Increase the output limit and retry.', {
      code: 'TRUNCATED_TOOL_RESPONSE', rawText: raw,
    });
  }
  const content = String(message?.content ?? '').trim();
  const unparsedToolTranscript = /^[\[{]/.test(content) && /"(?:tool_calls|function|plan_changes|submit_change|review_changes|finish_turn|text)"/.test(content)
    || /<\|tool_call(?:\|>|>)|call:(?:plan_changes|submit_change|retract_change|review_changes|finish_turn)\{/.test(content)
    || /\b(?:plan_changes|submit_change|retract_change|review_changes|finish_turn)\s*\(/.test(content);
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

function changeResultJSON({ status, revision, reason, summary, turnIntent, allowedCalls, recommendedAction }) {
  const result = { status };
  if (revision) result.revision_id = revision.id;
  if (reason) result.reason = reason;
  if (summary) result.turn_summary = summary;
  if (turnIntent) result.turn_intent = turnIntent;
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

function reviewResultText(revisions, baseText, { from, to }, resultTexts, goal, currentPlan, recovery, formatWarnings) {
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
          : { action: 'give_up', instruction: 'The managed recovery attempts are exhausted. Explain the unresolved issue to the author with finish_turn outcome "unable" and failure_reason.' };
  const progress = remaining === 0
    ? `Turn intent met — ${revisions.length} alternatives are ready.`
    : remaining > 0
      ? `Not complete — ${revisions.length} alternatives are ready; ${remaining} still needed.`
      : `Over the turn intent — ${revisions.length} alternatives are ready; ${-remaining} should be retracted.`;
  const criteria = goal.acceptance_criteria || 'Faithfully fulfill the author request.';
  const pendingCriteria = currentPlan.acceptance_criteria || criteria;
  const warnings = formatWarnings.length
    ? ` Formatting to correct: ${formatWarnings.map((warning) => `revision #${warning.revision_id} — ${warning.message}`).join('; ')}.`
    : '';
  const lines = [
    'NOIRDRAFT REVIEW',
    `Objective: submit ${goal.change_alternatives_count} alternatives for this change — ${goal.intent} Acceptance criteria: ${criteria}`,
    `Progress: ${progress}`,
    `Pending: submit ${currentPlan.change_alternatives_count} alternatives for this change — ${currentPlan.intent} Acceptance criteria: ${pendingCriteria}`,
    `Question: Does every alternative fulfill the author request, remain distinct, and read correctly in context? ${nextAction.instruction}${warnings}`,
  ];
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
  let currentPlan = null;
  let failedReviews = 0;
  let giveUpAllowed = false;
  let currentPlanAvailable = false;
  const allowedNextCalls = () => {
    if (!changesGoal) {
      return ['plan_changes'];
    }
    const actions = ['plan_changes', 'submit_change', 'retract_change'];
    if (changeCallVersion > 0 && reviewedChangeCallVersion !== changeCallVersion) {
      actions.push('review_changes');
    }
    if (changeCallVersion > 0 && reviewedChangeCallVersion === changeCallVersion && lastReviewRound >= 0) {
      if (revisions.length === changesGoal.change_alternatives_count) {
        actions.push('finish_turn');
      } else if (giveUpAllowed) {
        actions.push('finish_turn');
      }
    }
    return actions;
  };
  const recommendedAction = () => {
    if (!changesGoal) return { call: 'plan_changes', attempt: 'State how many versions of this change you intend to submit and their creative intent.' };
    if (changeCallVersion > 0 && reviewedChangeCallVersion !== changeCallVersion) {
      return { call: 'review_changes', attempt: 'Inspect the changes or retractions made since the last review before trying to finish.' };
    }
    if (reviewedChangeCallVersion === changeCallVersion && revisions.length === changesGoal.change_alternatives_count) {
      return { call: 'finish_turn', attempt: 'Use outcome "complete" and concise commentary, unless you first retract a weak proposal.' };
    }
    if (giveUpAllowed) return { call: 'finish_turn', attempt: 'Use outcome "unable" with failure_reason explaining the unresolved issue to the author.' };
    if (currentPlanAvailable) return { call: 'submit_change', attempt: 'Apply the current plan with a fresh, distinct version of the change.' };
    if (failedReviews === 2) return { call: 'plan_changes', attempt: 'State a concrete change-alternatives count and fresh creative intent, then submit distinct changes.' };
    return { call: 'submit_change', attempt: 'Submit a fresh, distinct version of the change that moves the work toward the turn intent.' };
  };
  const planResult = (currentIntent, managerPrompt) => JSON.stringify({
    status: 'accepted',
    current_intent: currentIntent,
    manager_prompt: managerPrompt,
    turn_state: changesGoal
      ? {
        turn_intent: changesGoal,
        current_intent: currentPlan,
        changes_ready: revisions.length,
        remaining_change_alternatives: Math.max(0, changesGoal.change_alternatives_count - revisions.length),
        allowed_calls: allowedNextCalls(),
        recommended_action: recommendedAction(),
      }
      : { allowed_calls: allowedNextCalls(), recommended_action: recommendedAction() },
  });
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
  const materialize = async (toolCalls, round) => {
    const results = [];
    for (const call of toolCalls.filter((item) => ['plan_changes', 'submit_change', 'retract_change', 'review_changes', 'finish_turn'].includes(item?.function?.name))) {
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
          results.push({ call, status: 'rejected', reason: 'finish_turn with outcome "unable" requires failure_reason.' });
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
        const acceptanceCriteria = change?.acceptance_criteria;
        if (!Number.isSafeInteger(changeAlternativesCount) || changeAlternativesCount < 1 || typeof intent !== 'string' || !intent.trim()) {
          invalidCalls += 1;
          results.push({ call, status: 'rejected', reason: 'plan_changes requires a positive change_alternatives_count and a nonempty intent.' });
          continue;
        }
        const isInitialPlan = !changesGoal;
        if (isInitialPlan) changesGoal = {
          change_alternatives_count: changeAlternativesCount,
          intent: intent.trim(),
          acceptance_criteria: typeof acceptanceCriteria === 'string' ? acceptanceCriteria.trim() : '',
        };
        currentPlanAvailable = true;
        const plan = {
          change_alternatives_count: changeAlternativesCount,
          intent: intent.trim(),
          acceptance_criteria: typeof acceptanceCriteria === 'string' ? acceptanceCriteria.trim() : '',
        };
        currentPlan = plan;
        results.push({ call, status: 'accepted', turn_intent: isInitialPlan ? changesGoal : null, current_intent: plan, manager_prompt: isInitialPlan
          ? 'Turn intent recorded. Submit the first changes when ready.'
          : `Turn intent remains ${changesGoal.change_alternatives_count} alternatives for this change. Submit this group without restating or changing it.` });
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
          results.push({ call, status: 'rejected', reason: 'review_changes requires a submit_change or retract_change since the previous review.' });
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
        results.push({ call, status: 'rejected', reason: 'Call plan_changes first to state the change-alternatives count and creative intent before submit_change.' });
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
    const toolResults = results.map(({ call, revision, status, reason, turn_intent: turnIntent, current_intent: currentIntent, manager_prompt: managerPrompt, recovery, format_warnings: formatWarnings = [] }) => ({
      role: 'tool', tool_call_id: call.id,
      content: status === 'review_ready'
        ? reviewResultText(revisions, baseText, { from, to }, resultTexts, changesGoal, currentPlan, recovery, formatWarnings)
        : currentIntent
          ? planResult(currentIntent, managerPrompt)
          : changeResultJSON({ status, revision, reason, turnIntent, allowedCalls: status === 'rejected' ? allowedNextCalls() : null, recommendedAction: status === 'rejected' ? recommendedAction() : null, summary: status === 'finished' ? turnSummary : null }),
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
