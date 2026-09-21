import { composeContext, sliceContextRows } from './context.js';
import { KoboldError } from './kobold.js';
import { commitRevision, reconstructRevision } from '../history/graph.js';
import { createUnifiedDiff } from '../history/diff.js';
import { hashStory } from '../history/hash.js';

export class AgentError extends Error {
  constructor(message, { code, cause, rawText } = {}) { super(message, { cause }); this.name = 'AgentError'; this.code = code; this.rawText = rawText; }
}

const textItem = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false };
const revisionReview = { type: 'object', properties: { revision_id: { type: 'integer' }, editorial_comment: { type: 'string', description: 'Write this editorial assessment before verdict.' }, verdict: { type: 'string', enum: ['approve', 'retract'] } }, required: ['revision_id', 'editorial_comment', 'verdict'], additionalProperties: false };

export const TURN_ITERATE_TOOL = {
  type: 'function', function: {
    name: 'turn_iterate',
    description: 'The only NoirDraft turn function. Use chat for an author-facing draft and its assessment; use changes for manuscript proposals and their assessments. Both roots can occur in one valid chat-to-changes or changes-to-conclusion-chat transition.',
    parameters: { type: 'object', properties: {
      chat: { type: 'object', properties: {
        intent: { type: 'string', description: 'Purpose of a new chat draft. It may be repeated while reviewing that draft.' }, message: { type: 'string', description: 'Complete new author-facing draft. It may be repeated unchanged while reviewing that draft.' },
        editorial_comment: { type: 'string', description: 'Assessment of the preceding chat draft; write before verdict. When present, intent and message may remain as the reviewed draft.' }, verdict: { type: 'string', enum: ['approve', 'rewrite', 'switch_to_changes'], description: 'A new chat draft may use approve to send itself immediately; otherwise this is the verdict on the preceding draft.' },
      }, additionalProperties: false },
      changes: { type: 'object', properties: {
        change_alternatives_count: { type: 'integer', minimum: 1, description: 'Required only in the first changes batch: total alternatives the author asked this change to offer.' },
        intent: { type: 'string', description: 'Purpose of this pending batch; state remaining constraints or difficulties.' }, operation: { type: 'string', enum: ['replace', 'insert'] },
        proposals: { type: 'array', items: textItem, description: 'Fresh proposals. Every new proposal must be assessed later.' }, reviews: { type: 'array', items: revisionReview, description: 'Assess every currently pending revision exactly once.' },
      }, additionalProperties: false },
    }, additionalProperties: false },
  },
};

const AGENT_TOOLS = [TURN_ITERATE_TOOL];
const MIN_TOOL_RESPONSE_TOKENS = 1024;
const EDITORIAL = 'Read each proposal in its full surrounding passage. It must honor the author’s intent while remaining grammatical, syntactically complete, meaningful, coherent, and properly formatted. Do not accept a lazy literal substitution that leaves an unnatural or nonsensical phrase.';

function assertComplete({ message, finishReason, raw }) {
  if (finishReason === 'length') throw new AgentError('KoboldCpp stopped before completing the tool response. Increase the output limit and retry.', { code: 'TRUNCATED_TOOL_RESPONSE', rawText: raw });
  const content = String(message?.content ?? '').trim();
  const unparsed = /^[\[{]/.test(content) && /"(?:tool_calls|function|turn_iterate|chat|changes)"/.test(content) || /<\|tool_call(?:\|>|>)|call:turn_iterate\{|\bturn_iterate\s*\(/.test(content);
  if (!message?.tool_calls?.length && unparsed) throw new AgentError('KoboldCpp returned an unparsed tool call instead of a completed response. Retry the turn.', { code: 'UNPARSED_TOOL_CALL', rawText: raw });
  if (!message?.tool_calls?.length) throw new AgentError('KoboldCpp did not return the required native tool call. Retry the turn.', { code: 'MISSING_REQUIRED_TOOL_CALL', rawText: raw });
}
function retainBreak(text, target) { const suffix = String(target).match(/(?:\r\n|\n)+$/)?.[0]; return !suffix || /(?:\r\n|\n)$/.test(text) ? text : `${text}${suffix}`; }
function word(value) { return /[\p{L}\p{N}]/u.test(value); }
function inserted(text, before, after) { let value = String(text); if (word(before) && word(value[0] ?? '')) value = ` ${value}`; if (word(value.at(-1) ?? '') && word(after)) value = `${value} `; return value; }
function diffText(before, after) { const lines = createUnifiedDiff(before, after).split(/\r?\n/).filter((line) => line.startsWith('+') && !line.startsWith('+++')); return lines.length ? lines.join('\n') : '+(no added text)'; }
function receipt(status, reason, extra = {}) { return JSON.stringify({ status, ...(reason ? { reason } : {}), ...extra }); }

export async function requestRewrite({ client, history, baseRevisionId, range, root = 'STORY', contextStoryText, request, metadataText = '', pins = [], references = [], chatHistory = [], contextRows = 12, agentProtocol, generationOptions = {}, onProgress, signal }) {
  const base = await reconstructRevision(history, baseRevisionId);
  const [from, to] = range;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to > base.length) throw new AgentError('The selected range is invalid for its base revision.', { code: 'INVALID_RANGE' });
  const context = sliceContextRows(base, from, to, contextRows);
  const composed = composeContext({ storyText: contextStoryText ?? (root === 'STORY' ? base : ''), metadataText, pins, references, before: context.before, target: context.target, after: context.after, request, agentProtocol, chatHistory });
  const prompt = `${composed.staticPrompt}\n\n${composed.turnPrompt}`;
  const transcript = [{ role: 'system', content: composed.staticPrompt }, { role: 'user', content: composed.turnPrompt }];
  const trace = [];
  let raw = '';
  let message; let calls;
  try {
    const response = await client.chatCompletion({ messages: transcript, tools: AGENT_TOOLS, toolChoice: 'required', maxTokens: Math.max(MIN_TOOL_RESPONSE_TOKENS, generationOptions.max_length ?? 0), temperature: generationOptions.temperature ?? 0, signal });
    message = response.message; calls = message.tool_calls; raw = response.raw ?? ''; if (response.raw) trace.push(response.raw); assertComplete({ message, finishReason: response.finishReason, raw });
  } catch (cause) {
    if (cause?.name === 'AbortError') throw new AgentError('Generation was cancelled.', { code: 'ABORTED', cause, rawText: raw });
    throw new AgentError('KoboldCpp generation failed.', { code: cause instanceof KoboldError ? cause.code : 'GENERATE_FAILED', cause, rawText: cause?.rawText ?? raw });
  }

  let phase = 'chat';
  let chatDraft = null;
  let objective = null;
  let pendingIntent = null;
  const pending = []; const approved = []; const active = []; const resultTexts = new Map(); const cached = new Map([[baseRevisionId, base]]);
  let retries = 0; let chatRetries = 0; let invalid = 0; let retracted = 0; let complete = false;
  const finalChat = () => complete && chatDraft ? [...approved.filter((revision) => history.revisions.get(revision.id) === revision).map((revision) => `[#${revision.id}](noirdraft://version/${root}/${revision.id})`), chatDraft.message].join(' ') : approved.filter((revision) => history.revisions.get(revision.id) === revision).map((revision) => `[#${revision.id}](noirdraft://version/${root}/${revision.id})`).join(' ');
  const report = () => onProgress?.({ rawResponse: raw, chat: finalChat(), revisions: [...active], intent: pendingIntent ?? chatDraft });
  const remove = (revision) => { for (const collection of [active, pending, approved]) { const index = collection.indexOf(revision); if (index >= 0) collection.splice(index, 1); } history.revisions.delete(revision.id); history.retiredRevisionIdFloor = Math.max(history.retiredRevisionIdFloor ?? -1, revision.id); retracted += 1; };
  const identical = async (text) => {
    const hash = await hashStory(text);
    for (const revision of history.revisions.values()) {
      if (!revision.parents.includes(baseRevisionId) || revision.resultHash !== hash) continue;
      const existing = cached.get(revision.id) ?? await reconstructRevision(history, revision.id); cached.set(revision.id, existing);
      if (existing === text) return revision;
    }
    return null;
  };
  const chatReview = () => [
    'NOIRDRAFT CHAT REVIEW', `Intent: ${chatDraft.intent}`,
    'Editorial concern: Is this reply accurate, helpful, complete, and appropriately concise? Does it postpone or delegate editorial work to the author, promise a change, or clearly entail a manuscript change?',
    phase === 'conclusion' ? 'Managerial concern: This is the final conclusion. Approve it, or provide a revised message. Changes are unavailable.' : `Managerial concern: Approve this reply, provide a revised message, or include a changes root to do the edit now. This is chat revision ${chatRetries + 1} of 3; after three revisions NoirDraft sends the latest reply rather than continuing to loop.`,
    '----- PROPOSED REPLY -----', chatDraft.message, '----- END OF REPLY -----',
  ].join('\n');
  const changeReview = (managerial) => {
    const needed = Math.max(0, objective.change_alternatives_count - approved.length - pending.length);
    const lines = ['NOIRDRAFT CHANGE REVIEW', `Objective: ${objective.change_alternatives_count} alternatives — ${objective.intent}`, `Progress: ${approved.length} approved · ${pending.length} awaiting review · ${needed} still needed`, `Pending: ${pendingIntent?.intent ?? 'Assess the listed revisions.'}`, `Editorial concern: ${EDITORIAL} Write editorial_comment followed by approve or retract for every listed revision. Approved revisions will not be shown again.`, `Managerial concern: ${managerial}`];
    if (!pending.length) lines.push('No pending revisions to inspect.');
    else { lines.push('Proposals to inspect:'); for (const revision of pending) { lines.push(`----- REVISION #${revision.id} -----`, diffText(base, resultTexts.get(revision.id))); } lines.push('----- END REVISIONS -----'); }
    return lines.join('\n');
  };
  const manager = () => {
    if (pending.length) return 'Assess every pending revision. You may add fresh proposals in the same changes root, but they must be assessed in a later iteration.';
    if (approved.length >= objective.change_alternatives_count) return 'All required alternatives are approved. The change phase is closed: include a chat root now for the final conclusion, or start it in the next call.';
    if (retries >= 3) return 'The managed retry limit is exhausted. The change phase is closed: include a chat root now with an honest conclusion, or start it in the next call.';
    return retries === 0 ? 'Retry directly with fresh, distinct proposals.' : retries === 1 ? 'Use the next pending intent to address the missing difficulty concretely.' : 'Use a broader, imaginative approach that still honors the author’s intent.';
  };
  const reject = (reason) => ({ type: 'json', text: receipt('rejected', reason) });

  const create = async (changes) => {
    const proposals = Array.isArray(changes.proposals) ? changes.proposals : [];
    if (!proposals.length) return [];
    const expected = context.target.length ? 'replace' : 'insert';
    if (changes.operation !== expected) return [reject(`Expected operation "${expected}" for this target.`)];
    const results = [];
    for (const proposal of proposals) {
      if (approved.length + pending.length >= objective.change_alternatives_count) {
        invalid += 1; results.push(reject('The Objective already has enough approved or pending alternatives. Review the pending revisions or conclude instead of adding another proposal.')); continue;
      }
      if (typeof proposal?.text !== 'string' || !proposal.text.trim()) { invalid += 1; results.push(reject('Each changes.proposals entry requires nonempty text.')); continue; }
      const replacement = expected === 'replace' ? retainBreak(proposal.text, context.target) : inserted(proposal.text, base.at(from - 1) ?? '', base.at(to) ?? '');
      const text = `${base.slice(0, from)}${replacement}${base.slice(to)}`;
      if (text === base) { invalid += 1; results.push(reject('The proposed result is unchanged.')); continue; }
      const sibling = await identical(text);
      if (sibling) { invalid += 1; results.push(reject(`The proposed result is identical to revision #${sibling.id}.`)); continue; }
      const revision = await commitRevision(history, base, text, { origin: 'agent', parentId: baseRevisionId, setCurrent: false, note: null });
      active.push(revision); pending.push(revision); resultTexts.set(revision.id, text); results.push({ type: 'receipt', text: receipt('accepted', null, { revision_id: revision.id }) });
    }
    return results;
  };
  const assess = (reviews) => {
    if (!pending.length) return null;
    if (!Array.isArray(reviews) || reviews.length !== pending.length) return 'changes.reviews must assess every pending revision exactly once.';
    const entries = new Map(reviews.map((review) => [review?.revision_id, review]));
    if (entries.size !== pending.length || pending.some((revision) => !entries.has(revision.id))) return 'changes.reviews must identify every pending revision exactly once.';
    for (const revision of pending) { const review = entries.get(revision.id); if (typeof review.editorial_comment !== 'string' || !review.editorial_comment.trim() || !['approve', 'retract'].includes(review.verdict)) return 'Every revision requires a nonempty editorial_comment followed by approve or retract.'; }
    for (const revision of [...pending]) { const review = entries.get(revision.id); pending.splice(pending.indexOf(revision), 1); if (review.verdict === 'approve') approved.push(revision); else remove(revision); }
    return null;
  };
  const doChanges = async (changes, first) => {
    if (!changes || typeof changes !== 'object') return [reject('A changes root is required.')];
    if (first) {
      if (!Number.isSafeInteger(changes.change_alternatives_count) || changes.change_alternatives_count < 1 || typeof changes.intent !== 'string' || !changes.intent.trim() || !Array.isArray(changes.proposals) || !changes.proposals.length) return [reject('The first changes root requires positive change_alternatives_count, nonempty intent, and at least one proposal.')];
      const expected = context.target.length ? 'replace' : 'insert';
      if (changes.operation !== expected) return [reject(expected === 'insert'
        ? 'No selection is marked. This is an insertion at the cursor: retry this changes root with operation "insert" and only new text at that point.'
        : 'A selection is marked. This change must use operation "replace" with the complete replacement selection.')];
      objective = { change_alternatives_count: changes.change_alternatives_count, intent: changes.intent.trim() }; phase = 'changes';
    } else {
      if (changes.change_alternatives_count !== undefined) return [reject('The Objective count is already recorded; use intent only for the current pending batch.')];
      const error = assess(changes.reviews); if (error) return [reject(error)];
      if (!pending.length && approved.length < objective.change_alternatives_count && Array.isArray(changes.proposals) && changes.proposals.length === 0) retries += 1;
    }
    if (typeof changes.intent === 'string' && changes.intent.trim()) pendingIntent = { intent: changes.intent.trim() };
    else if (Array.isArray(changes.proposals) && changes.proposals.length) return [reject('A changes root with proposals requires nonempty intent.')];
    const results = await create(changes);
    if (!first && !pending.length && (approved.length >= objective.change_alternatives_count || retries >= 3)) { phase = 'conclusion'; pendingIntent = null; }
    return results;
  };
  const doChat = (chat, allowSwitch) => {
    if (!chat || typeof chat !== 'object') return [reject('A chat root is required.')];
    if (!chatDraft) {
      if (typeof chat.intent !== 'string' || !chat.intent.trim() || typeof chat.message !== 'string' || !chat.message.trim()) return [reject('A new chat draft requires nonempty chat.intent and chat.message.')];
      if (chat.editorial_comment !== undefined || (chat.verdict !== undefined && chat.verdict !== 'approve')) return [reject('A new chat draft may omit verdict for review, or use verdict approve to send it immediately.')];
      chatDraft = { intent: chat.intent.trim(), message: chat.message.trim() };
      if (chat.verdict === 'approve') { complete = true; return [{ type: 'receipt', text: receipt('approved') }]; }
      return [{ type: 'chat' }];
    }
    if (chat.verdict === 'approve') { complete = true; return [{ type: 'receipt', text: receipt('approved') }]; }
    const revisedMessage = typeof chat.message === 'string' && chat.message.trim() && chat.message.trim() !== chatDraft.message;
    if (chat.verdict === 'rewrite' || (chat.verdict === undefined && revisedMessage)) {
      if (!revisedMessage) return [reject('A chat rewrite needs a different nonempty message. To keep the current reply, use verdict "approve".')];
      chatDraft = { intent: typeof chat.intent === 'string' && chat.intent.trim() ? chat.intent.trim() : chatDraft.intent, message: chat.message.trim() };
      chatRetries += 1;
      if (chatRetries >= 3) { complete = true; return [{ type: 'receipt', text: receipt('approved', 'The chat retry limit selected the latest revised reply.') }]; }
      return [{ type: 'chat' }];
    }
    if (typeof chat.editorial_comment !== 'string' || !chat.editorial_comment.trim() || chat.verdict !== 'switch_to_changes') return [reject('Keep the current reply with verdict "approve", provide a different chat.message to revise it, or include a changes root to edit the document.')];
    if (!allowSwitch || phase === 'conclusion') return [reject('The final conclusion chat cannot switch back to changes.')];
    return [{ type: 'switch' }];
  };
  const iterate = async () => {
    if (!Array.isArray(calls) || calls.length !== 1 || calls[0]?.function?.name !== 'turn_iterate') { invalid += 1; return [reject('Return exactly one native turn_iterate call.')]; }
    let payload; try { payload = JSON.parse(calls[0].function.arguments); } catch { payload = null; }
    if (!payload || typeof payload !== 'object' || (!payload.chat && !payload.changes)) { invalid += 1; return [reject('turn_iterate requires a chat root, a changes root, or a valid transition with both.')]; }
    if (phase === 'chat') {
      if (payload.changes) {
        if (chatDraft && payload.chat) {
          const review = doChat({ ...payload.chat, verdict: 'switch_to_changes' }, true); if (review.some(({ type }) => type === 'json')) return review;
        }
        const precedingDraft = chatDraft;
        chatDraft = null;
        const results = await doChanges(payload.changes, true);
        if (phase === 'chat') chatDraft = precedingDraft;
        return results;
      }
      return doChat(payload.chat, true);
    }
    if (phase === 'changes') {
      const results = await doChanges(payload.changes, false);
      if (payload.chat) { if (phase !== 'conclusion') results.push(reject('The change phase remains open; resolve its pending review or manager direction before starting conclusion chat.')); else results.push(...doChat(payload.chat, false)); }
      return results;
    }
    if (payload.changes) return [reject('Changes are closed for this turn. The conclusion chat may only be rewritten or approved.')];
    return doChat(payload.chat, false);
  };

  report();
  for (let round = 0; round < 32 && !complete; round += 1) {
    const results = await iterate();
    const hasJson = results.some(({ type }) => type === 'json');
    const applied = results.some(({ type }) => type !== 'json');
    const content = complete || (hasJson && !applied) ? results.map(({ text }) => text).join('\n') : phase === 'changes' ? changeReview(manager()) : chatReview();
    const toolResult = { role: 'tool', tool_call_id: calls[0].id, content };
    trace.push(`[noirdraft tool result: ${calls[0].id}]\n${content}\n[noirdraft end tool result: ${calls[0].id}]`); raw = trace.join('\n\n');
    if (hasJson && !applied) transcript.push({ role: 'user', content: `<noirdraft_manager_correction><![CDATA[The last turn_iterate was not applied. ${results.map(({ text }) => JSON.parse(text).reason).join(' ')} Return one corrected turn_iterate call; do not repeat the rejected call.]]></noirdraft_manager_correction>` });
    else transcript.push(message, toolResult);
    report();
    if (complete) break;
    try {
      const response = await client.chatCompletion({ messages: transcript, tools: AGENT_TOOLS, toolChoice: 'required', maxTokens: Math.max(MIN_TOOL_RESPONSE_TOKENS, generationOptions.max_length ?? 0), temperature: generationOptions.temperature ?? 0, signal });
      if (response.raw) trace.push(response.raw); raw = trace.join('\n\n'); report(); assertComplete({ message: response.message, finishReason: response.finishReason, raw }); message = response.message; calls = message.tool_calls;
    } catch (cause) { if (cause instanceof AgentError) throw cause; throw new AgentError('KoboldCpp could not continue the tool-call response.', { code: cause?.code ?? 'GENERATE_FAILED', cause, rawText: raw }); }
  }
  if (!complete) throw new AgentError('KoboldCpp did not approve a final chat reply. Retry the turn.', { code: 'UNFINISHED_TURN', rawText: raw });
  const chat = finalChat();
  if (!chat) throw new AgentError('KoboldCpp approved an empty chat reply.', { code: 'EMPTY_RESPONSE', rawText: raw });
  return { revision: approved[0] ?? null, revisions: active, generated: approved[0] ? resultTexts.get(approved[0].id) : undefined, chat, changes: approved.map((revision) => resultTexts.get(revision.id)), rawResponse: raw, prompt, unresolvedPins: composed.unresolvedPins, anchor: { root, baseRevisionId, range: [from, to], targetHash: await hashStory(context.target), before: context.before, after: context.after } };
}
