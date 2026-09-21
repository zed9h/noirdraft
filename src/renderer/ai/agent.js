import { composeContext, sliceContextRows } from './context.js';
import { KoboldError } from './kobold.js';
import { commitRevision, reconstructRevision } from '../history/graph.js';
import { createUnifiedDiff } from '../history/diff.js';
import { hashStory } from '../history/hash.js';

export class AgentError extends Error {
  constructor(message, { code, cause, rawText } = {}) { super(message, { cause }); this.name = 'AgentError'; this.code = code; this.rawText = rawText; }
}

const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const text = { type: 'string' };
const proposal = object({ text: { ...text, description: 'The complete replacement for the selection only. Never include text before or after the selection.' } }, ['text']);
const copyedit = object({ sentence_integrity: { type: 'boolean', description: 'True only if the full revised passage has no duplicated, omitted, or stranded words and is syntactically complete.' }, mechanics: { type: 'boolean', description: 'True only if spelling, grammar, punctuation, capitalization, spacing, and line breaks are correct.' }, clarity: { type: 'boolean', description: 'True only if references and meaning are coherent and clear in the full passage.' }, style: { type: 'boolean', description: 'True only if diction, rhythm, concision, and tone fit the surrounding manuscript.' } }, ['sentence_integrity', 'mechanics', 'clarity', 'style']);
const assessment = object({ revision_id: { type: 'integer' }, copyedit, comment: text, verdict: { type: 'string', enum: ['approve', 'retract'] } }, ['revision_id', 'copyedit', 'comment', 'verdict']);
const tool = (name, description, parameters) => ({ type: 'function', function: { name, description, parameters } });

export const AGENT_TOOLS = [
  tool('draft_chat', 'Draft or rewrite the author-facing chat reply. Its result is a chat review.', object({ message: text }, ['message'])),
  tool('approve_chat', 'Send the currently displayed chat draft to the author.', object()),
  tool('propose_changes', 'Create one batch of fresh sibling change alternatives. On the first call, intent and alternative_count establish the fixed Objective; on later calls they are the next pending batch plan. Its result is the detailed review to inspect before reviewing.', object({ intent: text, alternative_count: { type: 'integer', minimum: 1 }, proposals: { type: 'array', minItems: 1, items: proposal } }, ['intent', 'alternative_count', 'proposals'])),
  tool('review_changes', 'First diagnose the whole displayed set, then copyedit every revision. Approval requires sentence integrity, mechanics, clarity, and style all true. Put next_batch_focus and next_batch_count last only when another proposal batch would help.', object({ set_overview: { ...text, description: 'A brief diagnosis of the set as a whole: its strongest quality and concrete problems to correct.' }, reviews: { type: 'array', items: assessment }, next_batch_focus: text, next_batch_count: { type: 'integer', minimum: 1 } }, ['set_overview', 'reviews'])),
  tool('finish_changes', 'Close a fully reviewed change set. It takes no parameters.', object()),
];

const MIN_TOOL_RESPONSE_TOKENS = 1024;
const EDITORIAL = 'Copyedit every proposal in its complete surrounding passage: first sentence integrity (no duplicated, missing, or stranded words); then mechanics (spelling, grammar, punctuation, capitalization, spacing, and line breaks); then clarity and coherence; then diction, rhythm, concision, tone, and consistency with the manuscript. Retract any proposal that fails a pass.';

function assertComplete({ message, finishReason, raw }) {
  if (finishReason === 'length') throw new AgentError('KoboldCpp stopped before completing the tool response. Increase the output limit and retry.', { code: 'TRUNCATED_TOOL_RESPONSE', rawText: raw });
  const content = String(message?.content ?? '').trim();
  const unparsed = /^[\[{]/.test(content) && /"(?:tool_calls|function|draft_chat|propose_changes)"/.test(content) || /<\|tool_call(?:\|>|>)|call:(?:draft_chat|propose_changes)\{|\b(?:draft_chat|propose_changes)\s*\(/.test(content);
  if (!message?.tool_calls?.length && unparsed) throw new AgentError('KoboldCpp returned an unparsed tool call instead of a completed response. Retry the turn.', { code: 'UNPARSED_TOOL_CALL', rawText: raw });
  if (!message?.tool_calls?.length) throw new AgentError('KoboldCpp did not return the required native tool call. Retry the turn.', { code: 'MISSING_REQUIRED_TOOL_CALL', rawText: raw });
}
function receipt(status, reason, extra = {}) { return JSON.stringify({ status, ...(reason ? { reason } : {}), ...extra }); }
function retainBreak(value, target) { const ending = String(target).match(/(?:\r\n|\n)+$/)?.[0]; return !ending || /(?:\r\n|\n)$/.test(value) ? value : `${value}${ending}`; }
function word(value) { return /[\p{L}\p{N}]/u.test(value); }
function inserted(value, before, after) { let result = String(value); if (word(before) && word(result[0] ?? '')) result = ` ${result}`; if (word(result.at(-1) ?? '') && word(after)) result = `${result} `; return result; }
function additions(before, after) { const lines = createUnifiedDiff(before, after).split(/\r?\n/).filter((line) => line.startsWith('+') && !line.startsWith('+++')); return lines.length ? lines.join('\n') : '+(no added text)'; }
function removals(before, after) { const lines = createUnifiedDiff(before, after).split(/\r?\n/).filter((line) => line.startsWith('-') && !line.startsWith('---')); return lines.length ? lines.join('\n') : '-(no removed text)'; }

export async function requestRewrite({ client, history, baseRevisionId, range, root = 'STORY', contextStoryText, request, metadataText = '', pins = [], references = [], chatHistory = [], contextRows = 12, agentProtocol, generationOptions = {}, onProgress, signal }) {
  const base = await reconstructRevision(history, baseRevisionId);
  const [from, to] = range;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to > base.length) throw new AgentError('The selected range is invalid for its base revision.', { code: 'INVALID_RANGE' });
  const context = sliceContextRows(base, from, to, contextRows);
  const composed = composeContext({ storyText: contextStoryText ?? (root === 'STORY' ? base : ''), metadataText, pins, references, before: context.before, target: context.target, after: context.after, request, agentProtocol, chatHistory });
  const prompt = `${composed.staticPrompt}\n\n${composed.turnPrompt}`;
  const transcript = [{ role: 'system', content: composed.staticPrompt }, { role: 'user', content: composed.turnPrompt }];
  const trace = [];
  let raw = ''; let message; let calls;
  const getResponse = async () => {
    try {
      const response = await client.chatCompletion({ messages: transcript, tools: AGENT_TOOLS, toolChoice: 'required', maxTokens: Math.max(MIN_TOOL_RESPONSE_TOKENS, generationOptions.max_length ?? 0), temperature: generationOptions.temperature ?? 0, signal });
      if (response.raw) trace.push(response.raw);
      raw = trace.join('\n\n');
      assertComplete({ message: response.message, finishReason: response.finishReason, raw });
      message = response.message; calls = message.tool_calls;
    } catch (cause) {
      if (cause?.name === 'AbortError') throw new AgentError('Generation was cancelled.', { code: 'ABORTED', cause, rawText: raw });
      throw new AgentError('KoboldCpp generation failed.', { code: cause instanceof KoboldError ? cause.code : 'GENERATE_FAILED', cause, rawText: cause?.rawText ?? raw });
    }
  };
  await getResponse();

  let phase = 'chat'; let chatDraft = null; let chatRetries = 0; let objective = null; let batchIntent = null; let nextBatchFocus = null; let nextBatchCount = null; let reviewVisible = false; let changeRetries = 0; let complete = false;
  const pending = []; const approved = []; const active = []; const texts = new Map(); const cached = new Map([[baseRevisionId, base]]);
  const citations = () => approved.filter((revision) => history.revisions.get(revision.id) === revision).map((revision) => `[#${revision.id}](noirdraft://version/${root}/${revision.id})`);
  const finalChat = () => complete && chatDraft ? [...citations(), chatDraft.message].join(' ') : citations().join(' ');
  const report = () => onProgress?.({ rawResponse: raw, chat: finalChat(), revisions: [...active], intent: nextBatchFocus ? { intent: nextBatchFocus } : chatDraft });
  const reject = (reason) => ({ ok: false, content: receipt('rejected', reason) });
  const rejectBatch = (errors) => ({ ok: false, content: ['NOIRDRAFT BATCH ERRORS', ...errors.map((error) => `- ${error}`), 'Correct every listed proposal, then call propose_changes with a fresh batch.'].join('\n') });
  const accept = (content) => ({ ok: true, content });
  const remove = (revision) => { for (const list of [active, pending, approved]) { const index = list.indexOf(revision); if (index >= 0) list.splice(index, 1); } history.revisions.delete(revision.id); history.retiredRevisionIdFloor = Math.max(history.retiredRevisionIdFloor ?? -1, revision.id); };
  const identical = async (candidate) => {
    const candidateHash = await hashStory(candidate);
    for (const revision of history.revisions.values()) {
      if (!revision.parents.includes(baseRevisionId) || revision.resultHash !== candidateHash) continue;
      const existing = cached.get(revision.id) ?? await reconstructRevision(history, revision.id);
      cached.set(revision.id, existing);
      if (existing === candidate) return revision;
    }
    return null;
  };
  const chatReview = () => [
    'NOIRDRAFT CHAT REVIEW',
    'Editorial concern: Is this reply accurate, helpful, complete, concise, and free of promises or delegation that should instead be an edit?',
    phase === 'conclusion' ? 'Managerial concern: Approve this reply or draft a replacement. Changes are closed.' : `Managerial concern: Approve this reply, draft a replacement, or call propose_changes to edit. Chat revision ${chatRetries} of 3.`,
    '----- PROPOSED REPLY -----', chatDraft.message, '----- END OF REPLY -----',
  ].join('\n');
  const detailedReview = (omitted = []) => {
    const needed = Math.max(0, objective.alternativeCount - approved.length - pending.length);
    const lines = ['NOIRDRAFT CHANGE REVIEW', `Objective: ${objective.alternativeCount} alternatives — ${objective.text}`, `This batch: ${pending.length} alternatives — ${batchIntent}`, `Approved so far: ${approved.length} · Remaining objective: ${needed}`, `Editorial concern: ${EDITORIAL} A replacement must contain only replacement text, never a copied sentence or other surrounding context.`, 'Managerial concern: First give review_changes a brief set_overview identifying strengths and concrete problems. Then copyedit every listed revision: sentence_integrity, mechanics, clarity, and style must all be true before verdict approve; otherwise retract it. At its end, optionally set next_batch_focus and next_batch_count only if another batch would help; finish_changes is also allowed after this review.'];
    if (omitted.length) lines.push(`Before review, ignored invalid proposals: ${omitted.join(' ')}`);
    if (!pending.length) lines.push('No valid proposals were created. Call review_changes with reviews: [] and, if useful, a clearer next_batch_focus.');
    else { lines.push('Proposals to inspect:', '----- ORIGINAL TEXT -----', removals(base, texts.get(pending[0].id))); for (const revision of pending) lines.push(`----- REVISION #${revision.id} -----`, additions(base, texts.get(revision.id))); lines.push('----- END REVISIONS -----'); }
    return lines.join('\n');
  };
  const progress = () => {
    const needed = Math.max(0, objective.alternativeCount - approved.length);
    const alternative = (count) => `${count} alternative${count === 1 ? '' : 's'}`;
    const summary = `The stated objective is: ${objective.text} (${objective.alternativeCount} ${alternative(objective.alternativeCount)}). Progress: ${approved.length}/${objective.alternativeCount} ${alternative(objective.alternativeCount)} approved${needed ? `; ${needed} pending` : '; the objective is met'}.`;
    const recommendation = nextBatchFocus
      ? ` If you continue, run propose_changes for ${alternative((nextBatchCount ?? needed) || 1)} focused on: ${nextBatchFocus}.`
      : needed
        ? ` If you continue, run propose_changes for ${alternative(needed)}.`
        : ' You may run another batch only if it would add useful alternatives.';
    const exit = needed
      ? ' You may instead call finish_changes to end early if pursuing the remaining alternatives is not worthwhile.'
      : ' You may call finish_changes now.';
    return `NOIRDRAFT PROGRESS\n${summary}${recommendation}${exit}`;
  };
  const createBatch = async (proposals) => {
    if (!Array.isArray(proposals) || !proposals.length) return reject('propose_changes requires at least one proposal.');
    const prepared = [];
    const errors = [];
    for (const [index, item] of proposals.entries()) {
      const label = `Proposal ${index + 1}`;
      if (typeof item?.text !== 'string' || !item.text.trim()) { errors.push(`${label} has no text.`); continue; }
      const replacement = context.target.length ? retainBreak(item.text, context.target) : inserted(item.text, base.at(from - 1) ?? '', base.at(to) ?? '');
      const candidate = `${base.slice(0, from)}${replacement}${base.slice(to)}`;
      if (candidate === base) { errors.push(`${label} leaves the document unchanged.`); continue; }
      if (prepared.some(({ candidate: existing }) => existing === candidate)) { errors.push(`${label} duplicates another proposal in this batch.`); continue; }
      const sibling = await identical(candidate);
      if (sibling) { errors.push(`${label} is identical to existing revision #${sibling.id}.`); continue; }
      prepared.push({ candidate });
    }
    if (!prepared.length) return rejectBatch(errors);
    for (const { candidate } of prepared) {
      const revision = await commitRevision(history, base, candidate, { origin: 'agent', parentId: baseRevisionId, setCurrent: false, note: null });
      active.push(revision); pending.push(revision); texts.set(revision.id, candidate);
    }
    reviewVisible = true;
    return accept(detailedReview(errors));
  };
  const assessBatch = (setOverview, reviews, nextIntent, nextCount) => {
    if (!reviewVisible) return reject('Call review_changes only after NoirDraft has shown a detailed change review.');
    if (typeof setOverview !== 'string' || !setOverview.trim()) return reject('review_changes requires a brief set_overview before the individual assessments.');
    const candidates = pending;
    if (!Array.isArray(reviews) || reviews.length !== candidates.length) return reject('review_changes needs exactly one assessment for every revision in the displayed review.');
    const byId = new Map(reviews.map((review) => [review?.revision_id, review]));
    if (byId.size !== candidates.length || candidates.some((revision) => !byId.has(revision.id))) return reject('Each displayed revision must be assessed exactly once.');
    for (const revision of candidates) {
      const review = byId.get(revision.id);
      const checklist = review.copyedit;
      if (typeof review.comment !== 'string' || !review.comment.trim() || !['approve', 'retract'].includes(review.verdict) || !checklist || !['sentence_integrity', 'mechanics', 'clarity', 'style'].every((key) => typeof checklist[key] === 'boolean')) return reject('Each assessment requires copyedit sentence_integrity, mechanics, clarity, and style; then a comment and verdict approve or retract.');
      if (review.verdict === 'approve' && !Object.values(checklist).every(Boolean)) return reject('Approve only when every copyedit check is true; otherwise retract the revision.');
    }
    for (const revision of [...candidates]) {
      const review = byId.get(revision.id);
      pending.splice(pending.indexOf(revision), 1);
      if (review.verdict === 'retract') remove(revision);
      else approved.push(revision);
    }
    reviewVisible = false;
    if (approved.length < objective.alternativeCount) changeRetries += 1;
    nextBatchFocus = typeof nextIntent === 'string' && nextIntent.trim() ? nextIntent.trim() : null;
    nextBatchCount = Number.isSafeInteger(nextCount) && nextCount > 0 ? nextCount : null;
    return accept(progress());
  };
  const execute = async (call) => {
    const name = call?.function?.name;
    let args; try { args = JSON.parse(call?.function?.arguments ?? '{}'); } catch { return reject('Tool arguments must be valid JSON.'); }
    if (name === 'draft_chat') {
      if (phase === 'changes') return reject('Changes are active. Complete the review cycle before drafting the final chat reply.');
      if (typeof args.message !== 'string' || !args.message.trim()) return reject('draft_chat requires a nonempty message.');
      chatDraft = { message: args.message.trim() }; chatRetries += 1;
      if (chatRetries > 3) { complete = true; return accept(receipt('approved', 'The chat retry limit selected the latest draft.')); }
      return accept(chatReview());
    }
    if (name === 'approve_chat') {
      if (!chatDraft || phase === 'changes') return reject('There is no displayed chat draft to approve.');
      complete = true; return accept(receipt('approved'));
    }
    if (name === 'propose_changes') {
      if (typeof args.intent !== 'string' || !args.intent.trim() || !Number.isSafeInteger(args.alternative_count) || args.alternative_count < 1) return reject('propose_changes requires a clear intent and positive alternative_count before its proposals.');
      if (phase === 'chat') { objective = { text: args.intent.trim(), alternativeCount: args.alternative_count }; phase = 'changes'; chatDraft = null; }
      if (phase !== 'changes' || !objective) return reject('Changes are unavailable after the final conclusion begins.');
      if (reviewVisible) return reject('The previous detailed review is still awaiting assessment. Call review_changes before another proposal batch.');
      batchIntent = args.intent.trim();
      return createBatch(args.proposals);
    }
    if (name === 'review_changes') {
      if (phase !== 'changes' || !objective) return reject('There is no active change objective to review.');
      return assessBatch(args.set_overview, args.reviews, args.next_batch_focus, args.next_batch_count);
    }
    if (name === 'finish_changes') {
      if (phase !== 'changes') return reject('There is no active change set to finish.');
      if (reviewVisible || pending.length) return accept(detailedReview());
      phase = 'conclusion';
      return accept('NOIRDRAFT CHANGE SET COMPLETE\nDraft the concise author-facing conclusion with draft_chat. Do not repeat the revision text.');
    }
    return reject(`Unknown NoirDraft tool "${name}".`);
  };

  report();
  for (let round = 0; round < 40 && !complete; round += 1) {
    if (!Array.isArray(calls) || !calls.length) throw new AgentError('KoboldCpp did not return a tool call.', { code: 'MISSING_REQUIRED_TOOL_CALL', rawText: raw });
    const entries = [];
    for (const call of calls) entries.push({ call, ...(await execute(call)) });
    for (const entry of entries) trace.push(`[noirdraft tool result: ${entry.call.id}]\n${entry.content}\n[noirdraft end tool result: ${entry.call.id}]`);
    raw = trace.join('\n\n'); report();
    if (complete) break;
    const accepted = entries.filter((entry) => entry.ok);
    const rejected = entries.filter((entry) => !entry.ok);
    if (accepted.length) {
      transcript.push({ role: 'assistant', content: message.content ?? null, tool_calls: accepted.map(({ call }) => call) });
      transcript.push(...accepted.map(({ call, content }) => ({ role: 'tool', tool_call_id: call.id, content })));
    }
    if (rejected.length) {
      const reason = (content) => { try { return JSON.parse(content).reason; } catch { return content; } };
      transcript.push({ role: 'user', content: `<noirdraft_manager_correction><![CDATA[The rejected tool call${rejected.length === 1 ? '' : 's'} was not applied. ${rejected.map(({ content }) => reason(content)).join(' ')} Use the valid next tool; do not repeat the rejected call.]]></noirdraft_manager_correction>` });
    }
    await getResponse(); report();
  }
  if (!complete) throw new AgentError('KoboldCpp did not approve a final chat reply. Retry the turn.', { code: 'UNFINISHED_TURN', rawText: raw });
  const chat = finalChat();
  if (!chat) throw new AgentError('KoboldCpp approved an empty chat reply.', { code: 'EMPTY_RESPONSE', rawText: raw });
  return { revision: approved[0] ?? null, revisions: active, generated: approved[0] ? texts.get(approved[0].id) : undefined, chat, changes: approved.map((revision) => texts.get(revision.id)), rawResponse: raw, prompt, unresolvedPins: composed.unresolvedPins, anchor: { root, baseRevisionId, range: [from, to], targetHash: await hashStory(context.target), before: context.before, after: context.after } };
}
