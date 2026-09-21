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
const proposal = object({ text }, ['text']);
const assessment = object({ revision_id: { type: 'integer' }, comment: text, verdict: { type: 'string', enum: ['approve', 'retract'] } }, ['revision_id', 'comment', 'verdict']);
const tool = (name, description, parameters) => ({ type: 'function', function: { name, description, parameters } });

export const AGENT_TOOLS = [
  tool('draft_chat', 'Draft or rewrite the author-facing chat reply. Its result is a chat review.', object({ message: text }, ['message'])),
  tool('approve_chat', 'Send the currently displayed chat draft to the author.', object()),
  tool('begin_changes', 'Always call this before propose_changes. Set the fixed objective for one set of sibling change alternatives.', object({ objective: text, alternative_count: { type: 'integer', minimum: 1 } }, ['objective', 'alternative_count'])),
  tool('propose_changes', 'Create one batch of fresh sibling change alternatives. Its result is the detailed review to inspect before reviewing.', object({ proposals: { type: 'array', minItems: 1, items: proposal } }, ['proposals'])),
  tool('review_changes', 'Assess every revision in the immediately preceding detailed review, then state the intent for the next proposal batch when more work is needed.', object({ reviews: { type: 'array', items: assessment }, pending_intent: text }, ['reviews'])),
  tool('finish_changes', 'Close a fully reviewed change set. When more alternatives than requested were approved, either choose the requested keep_revision_ids or set keep_all true.', object({ keep_revision_ids: { type: 'array', items: { type: 'integer' } }, keep_all: { type: 'boolean' } })),
];

const MIN_TOOL_RESPONSE_TOKENS = 1024;
const EDITORIAL = 'Read each proposal in its full surrounding passage. It must fulfill the author request while remaining grammatical, syntactically complete, meaningful, coherent, and properly formatted. Retract crude literal substitutions or weak alternatives.';

function assertComplete({ message, finishReason, raw }) {
  if (finishReason === 'length') throw new AgentError('KoboldCpp stopped before completing the tool response. Increase the output limit and retry.', { code: 'TRUNCATED_TOOL_RESPONSE', rawText: raw });
  const content = String(message?.content ?? '').trim();
  const unparsed = /^[\[{]/.test(content) && /"(?:tool_calls|function|draft_chat|begin_changes|propose_changes)"/.test(content) || /<\|tool_call(?:\|>|>)|call:(?:draft_chat|begin_changes|propose_changes)\{|\b(?:draft_chat|begin_changes|propose_changes)\s*\(/.test(content);
  if (!message?.tool_calls?.length && unparsed) throw new AgentError('KoboldCpp returned an unparsed tool call instead of a completed response. Retry the turn.', { code: 'UNPARSED_TOOL_CALL', rawText: raw });
  if (!message?.tool_calls?.length) throw new AgentError('KoboldCpp did not return the required native tool call. Retry the turn.', { code: 'MISSING_REQUIRED_TOOL_CALL', rawText: raw });
}
function receipt(status, reason, extra = {}) { return JSON.stringify({ status, ...(reason ? { reason } : {}), ...extra }); }
function retainBreak(value, target) { const ending = String(target).match(/(?:\r\n|\n)+$/)?.[0]; return !ending || /(?:\r\n|\n)$/.test(value) ? value : `${value}${ending}`; }
function word(value) { return /[\p{L}\p{N}]/u.test(value); }
function inserted(value, before, after) { let result = String(value); if (word(before) && word(result[0] ?? '')) result = ` ${result}`; if (word(result.at(-1) ?? '') && word(after)) result = `${result} `; return result; }
function additions(before, after) { const lines = createUnifiedDiff(before, after).split(/\r?\n/).filter((line) => line.startsWith('+') && !line.startsWith('+++')); return lines.length ? lines.join('\n') : '+(no added text)'; }

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

  let phase = 'chat'; let chatDraft = null; let chatRetries = 0; let objective = null; let pendingIntent = null; let reviewVisible = false; let changeRetries = 0; let complete = false;
  const pending = []; const approved = []; const active = []; const texts = new Map(); const cached = new Map([[baseRevisionId, base]]);
  const citations = () => approved.filter((revision) => history.revisions.get(revision.id) === revision).map((revision) => `[#${revision.id}](noirdraft://version/${root}/${revision.id})`);
  const finalChat = () => complete && chatDraft ? [...citations(), chatDraft.message].join(' ') : citations().join(' ');
  const report = () => onProgress?.({ rawResponse: raw, chat: finalChat(), revisions: [...active], intent: pendingIntent ? { intent: pendingIntent } : chatDraft });
  const reject = (reason) => ({ ok: false, content: receipt('rejected', reason) });
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
    phase === 'conclusion' ? 'Managerial concern: Approve this reply or draft a replacement. Changes are closed.' : `Managerial concern: Approve this reply, draft a replacement, or call begin_changes to edit. Chat revision ${chatRetries} of 3.`,
    '----- PROPOSED REPLY -----', chatDraft.message, '----- END OF REPLY -----',
  ].join('\n');
  const detailedReview = () => {
    const needed = Math.max(0, objective.alternativeCount - approved.length - pending.length);
    const lines = ['NOIRDRAFT CHANGE REVIEW', `Objective: ${objective.alternativeCount} alternatives — ${objective.text}`, `Progress: ${approved.length} approved · ${pending.length} awaiting review · ${needed} still needed`, `Pending: ${pendingIntent ?? objective.text}`, `Editorial concern: ${EDITORIAL}`, 'Managerial concern: Inspect every listed revision, then call review_changes with one assessment per revision and a pending_intent if another batch is needed.'];
    if (!pending.length) lines.push('No valid proposals were created. Call review_changes with reviews: [] and a clearer pending_intent.');
    else { lines.push('Proposals to inspect:'); for (const revision of pending) lines.push(`----- REVISION #${revision.id} -----`, additions(base, texts.get(revision.id))); lines.push('----- END REVISIONS -----'); }
    return lines.join('\n');
  };
  const progress = () => {
    const needed = Math.max(0, objective.alternativeCount - approved.length);
    const completeObjective = needed === 0;
    const retryHint = changeRetries === 1 ? 'Submit the next proposal batch directly.' : changeRetries === 2 ? 'Use the pending intent to address the remaining difficulty concretely.' : 'Use a broader, imaginative approach that still serves the objective.';
    return ['NOIRDRAFT PROGRESS', `Objective: ${objective.alternativeCount} alternatives — ${objective.text}`, `Progress: ${approved.length} approved · ${needed} still needed`, `Pending: ${pendingIntent ?? (completeObjective ? 'No further proposals needed.' : 'Set a pending_intent for the next proposal batch.')}`, `Managerial concern: ${completeObjective ? 'The objective is met. Call finish_changes.' : changeRetries >= 3 ? 'The managed retry limit is reached. Call finish_changes for an honest conclusion.' : retryHint}`].join('\n');
  };
  const finalSelection = () => [
    'NOIRDRAFT FINAL SELECTION',
    `Objective: retain ${objective.alternativeCount} alternatives — ${objective.text}`,
    `Approved: ${approved.length}`,
    'Choose the strongest requested alternatives, or explicitly keep all approved alternatives:',
    ...approved.flatMap((revision) => [`----- APPROVED REVISION #${revision.id} -----`, additions(base, texts.get(revision.id))]),
    'Managerial concern: Call finish_changes with keep_revision_ids containing exactly the requested number, or finish_changes with keep_all: true.',
  ].join('\n');
  const createBatch = async (proposals) => {
    if (!Array.isArray(proposals) || !proposals.length) return reject('propose_changes requires at least one proposal.');
    const prepared = [];
    for (const item of proposals) {
      if (typeof item?.text !== 'string' || !item.text.trim()) return reject('Every proposal requires nonempty text.');
      const replacement = context.target.length ? retainBreak(item.text, context.target) : inserted(item.text, base.at(from - 1) ?? '', base.at(to) ?? '');
      const candidate = `${base.slice(0, from)}${replacement}${base.slice(to)}`;
      if (candidate === base) return reject('A proposal cannot leave the document unchanged.');
      if (prepared.some(({ candidate: existing }) => existing === candidate)) return reject('A proposal batch cannot contain duplicate alternatives. Use distinct text for every proposal.');
      const sibling = await identical(candidate);
      if (sibling) return reject(`A proposal is identical to revision #${sibling.id}. Use a different alternative.`);
      prepared.push({ candidate });
    }
    for (const { candidate } of prepared) {
      const revision = await commitRevision(history, base, candidate, { origin: 'agent', parentId: baseRevisionId, setCurrent: false, note: null });
      active.push(revision); pending.push(revision); texts.set(revision.id, candidate);
    }
    reviewVisible = true;
    return accept(detailedReview());
  };
  const assessBatch = (reviews, nextIntent) => {
    if (!reviewVisible) return reject('Call review_changes only after NoirDraft has shown a detailed change review.');
    if (!Array.isArray(reviews) || reviews.length !== pending.length) return reject('review_changes needs exactly one assessment for every revision in the displayed review.');
    const byId = new Map(reviews.map((review) => [review?.revision_id, review]));
    if (byId.size !== pending.length || pending.some((revision) => !byId.has(revision.id))) return reject('Each displayed revision must be assessed exactly once.');
    for (const revision of pending) { const review = byId.get(revision.id); if (typeof review.comment !== 'string' || !review.comment.trim() || !['approve', 'retract'].includes(review.verdict)) return reject('Each assessment requires a comment followed by verdict approve or retract.'); }
    for (const revision of [...pending]) { const review = byId.get(revision.id); pending.splice(pending.indexOf(revision), 1); if (review.verdict === 'approve') approved.push(revision); else remove(revision); }
    reviewVisible = false;
    if (approved.length < objective.alternativeCount) { changeRetries += 1; if (typeof nextIntent !== 'string' || !nextIntent.trim()) return reject('More alternatives are needed. Set pending_intent to steer the next proposal batch.'); pendingIntent = nextIntent.trim(); }
    else pendingIntent = null;
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
    if (name === 'begin_changes') {
      if (phase !== 'chat') return reject('A change objective is already active. Continue its proposal and review cycle.');
      if (typeof args.objective !== 'string' || !args.objective.trim() || !Number.isSafeInteger(args.alternative_count) || args.alternative_count < 1) return reject('begin_changes requires a clear objective and a positive alternative_count.');
      objective = { text: args.objective.trim(), alternativeCount: args.alternative_count }; pendingIntent = objective.text; phase = 'changes'; chatDraft = null;
      return accept(receipt('accepted', null, { objective: objective.text, alternative_count: objective.alternativeCount }));
    }
    if (name === 'propose_changes') {
      if (phase !== 'changes' || !objective) return reject('Call begin_changes before proposing a change batch.');
      if (reviewVisible) return reject('The previous detailed review is still awaiting assessment. Call review_changes before another proposal batch.');
      return createBatch(args.proposals);
    }
    if (name === 'review_changes') {
      if (phase !== 'changes' || !objective) return reject('There is no active change objective to review.');
      return assessBatch(args.reviews, args.pending_intent);
    }
    if (name === 'finish_changes') {
      if (phase !== 'changes' || reviewVisible || pending.length) return reject('Finish is allowed only after the displayed review has been assessed.');
      if (approved.length < objective.alternativeCount && changeRetries < 3) return reject('The objective is not yet met. Follow the latest progress guidance with another proposal batch.');
      if (approved.length > objective.alternativeCount) {
        if (args.keep_all === true) {
          // The agent may deliberately preserve a richer set than it originally planned.
        } else if (Array.isArray(args.keep_revision_ids)) {
          const keep = new Set(args.keep_revision_ids);
          if (keep.size !== objective.alternativeCount || ![...keep].every((id) => approved.some((revision) => revision.id === id))) return reject(`keep_revision_ids must name exactly ${objective.alternativeCount} approved revisions.`);
          for (const revision of [...approved]) if (!keep.has(revision.id)) remove(revision);
        } else return accept(finalSelection());
      }
      phase = 'conclusion';
      return accept('NOIRDRAFT CHANGE SET COMPLETE\nManagerial concern: Draft the concise author-facing conclusion with draft_chat. Do not repeat the revision text.');
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
    if (rejected.length) transcript.push({ role: 'user', content: `<noirdraft_manager_correction><![CDATA[The rejected tool call${rejected.length === 1 ? '' : 's'} was not applied. ${rejected.map(({ content }) => JSON.parse(content).reason).join(' ')} Use the valid next tool; do not repeat the rejected call.]]></noirdraft_manager_correction>` });
    await getResponse(); report();
  }
  if (!complete) throw new AgentError('KoboldCpp did not approve a final chat reply. Retry the turn.', { code: 'UNFINISHED_TURN', rawText: raw });
  const chat = finalChat();
  if (!chat) throw new AgentError('KoboldCpp approved an empty chat reply.', { code: 'EMPTY_RESPONSE', rawText: raw });
  return { revision: approved[0] ?? null, revisions: active, generated: approved[0] ? texts.get(approved[0].id) : undefined, chat, changes: approved.map((revision) => texts.get(revision.id)), rawResponse: raw, prompt, unresolvedPins: composed.unresolvedPins, anchor: { root, baseRevisionId, range: [from, to], targetHash: await hashStory(context.target), before: context.before, after: context.after } };
}
