import { composeContext, sliceContextRows } from './context.js';
import { INLINE_WORD_LIMIT, classifyPlacement, renderInline } from './placement.js';
import { KoboldError } from './kobold.js';
import { applyOperations, createNotebook, resetNotebook, isEmptyNotebook, markReviewed, notebookText, placeholderIds, renderReview, stateOf, wordCount, OPERATIONS } from './notebook.js';
import { commitRevision, reconstructRevision } from '../history/graph.js';
import { hashStory } from '../history/hash.js';

export class AgentError extends Error {
  constructor(message, { code, cause, rawText } = {}) { super(message, { cause }); this.name = 'AgentError'; this.code = code; this.rawText = rawText; }
}

const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const text = { type: 'string' };
const notebookId = { type: 'integer', description: 'The number of the notebook to act on (1, 2, ...). Use it to switch between notebooks.' };
const notebookSpec = object({
  intent: { ...text, description: 'What this variation should be or do, in plain prose. The author reads it as progress; never name tools or protocol steps.' },
  target_words: { type: 'integer', minimum: 1, description: 'About how long this variation should be, in words. If the author asks for a longer, fuller, or expanded text, or names a length, be generous: at least the size asked for, rounded up, never below. NoirDraft derives your review budget and its reminders from it.' },
  start: { type: 'string', enum: ['selection', 'blank'], description: 'selection: begin from the selected text and refine it. blank: begin empty and write from scratch. Default: selection when text is selected.' },
}, ['intent', 'target_words']);
const operation = object({
  op: { type: 'string', enum: OPERATIONS },
  paragraph_id: { type: 'integer', description: 'A paragraph id from the latest review.' },
  through_paragraph_id: { type: 'integer', description: 'replace/delete only: the last paragraph of the range.' },
  text: { ...text, description: 'replace/insert only: one or more paragraphs separated by blank lines. A whole paragraph in [square brackets] is a placeholder note to replace later.' },
}, ['op', 'paragraph_id']);
const copyedit = object({ sentence_integrity: { type: 'boolean', description: 'True only if the text has no duplicated, omitted, or stranded words and is syntactically complete in context.' }, mechanics: { type: 'boolean', description: 'True only if spelling, grammar, punctuation, capitalization, spacing, and line breaks are correct.' }, clarity: { type: 'boolean', description: 'True only if references and meaning are coherent and clear in context.' }, style: { type: 'boolean', description: 'True only if diction, rhythm, concision, and tone fit the surrounding manuscript.' } }, ['sentence_integrity', 'mechanics', 'clarity', 'style']);
const proposal = object({ text: { ...text, description: 'The complete replacement for the selection only. Never include text before or after the selection.' } }, ['text']);
const assessment = object({ revision_id: { type: 'integer' }, copyedit, comment: text, verdict: { type: 'string', enum: ['approve', 'retract'] } }, ['revision_id', 'copyedit', 'comment', 'verdict']);
const tool = (name, description, parameters) => ({ type: 'function', function: { name, description, parameters } });

const COMMENT = tool('comment_before_changes', 'Say something to the author before the work starts: what you intend to do, a promise, an introduction to the work ahead, or an early warning about the hard parts or quality risks you expect. Optional, and only before changes begin. It is never your final answer: after the work, finish with send_response.', object({ message: text }, ['message']));
const RESPONSE = tool('send_response', 'Send your message to the author and end the turn. This is how you answer: questions about the text, craft and style, research on any setting, culture, period or subject, brainstorming, or plain conversation, in as much substance as it deserves. After changes, use it to explain what was done and why it satisfies the request, with any limits or trade-offs. It may also be your first and only call when no edit is needed: to answer a question about the story or its text, to help with research or understanding, to ask about a doubt in the request, to simply chat, or to explain why the request will not be done. NoirDraft saves ready work before sending it.', object({ message: text }, ['message']));
const INLINE_TOOLS = [
  tool('propose_edits', 'Propose a batch of fresh sibling alternatives for the selection or cursor. On the first call, intent and alternative_count establish the fixed Objective; on later calls they are the next pending batch plan. Its result shows every alternative inside its surrounding text, to review.', object({ intent: { ...text, description: 'What this batch aims for, in plain prose. The author reads it as progress; never name tools or protocol steps.' }, alternative_count: { type: 'integer', minimum: 1 }, proposals: { type: 'array', minItems: 1, items: proposal } }, ['intent', 'alternative_count', 'proposals'])),
  tool('review_edits', 'First diagnose the whole displayed set, then copyedit every alternative in its context. Approval requires sentence integrity, mechanics, clarity, and style all true; approved alternatives are recorded, retracted ones discarded.', object({ set_overview: { ...text, description: 'A brief diagnosis of the set as a whole: its strongest quality and concrete problems to correct.' }, reviews: { type: 'array', items: assessment } }, ['set_overview', 'reviews'])),
];
const BLOCK_TOOLS = [
  tool('initialize_changes', 'Initialize the changes, once per request: declare the overall intent and every notebook (one per variation) in this single call. Never call it again to add or open a notebook; use edit_notebook to work on any of them. For a very long text or an unrequested single result, open one notebook; open several only for requested alternatives. Its result is the first notebook review.', object({ intent: { ...text, description: 'What the whole piece of writing is meant to achieve, in plain prose. The author reads it as progress; never name tools or protocol steps.' }, notebooks: { type: 'array', minItems: 1, maxItems: 6, items: notebookSpec } }, ['intent', 'notebooks'])),
  tool('edit_notebook', 'Apply a batch of operations to numbered notebook paragraphs. Only notebook paragraphs can be edited; the surrounding context is read-only. Its result is the updated review.', object({ notebook: notebookId, operations: { type: 'array', minItems: 1, items: operation } }, ['notebook', 'operations'])),
  tool('review_notebook', 'Give your editorial findings on the notebook as displayed in its context, and state what you will do next. This is a critique to guide the next edit, not a verdict.', object({ notebook: notebookId, copyedit, findings: { ...text, description: 'Concise, concrete problems, naming paragraph ids. Required when any check is false.' }, next_intent: { ...text, description: 'A short working note, one line of about a dozen words, in plain prose: what you will do next, or that the draft is finished and ready to be delivered. The author sees it as live progress. Never write tool or function names.' } }, ['notebook', 'copyedit', 'next_intent'])),
  tool('save_notebook', 'Record the notebook as a change to the document. Save only when you consider it good. You may edit and save it again later; each save continues the same chain.', object({ notebook: notebookId, summary: { ...text, description: 'One line, in plain prose, on what this version offers.' } }, ['notebook'])),
  tool('clear_notebook', 'Wipe a notebook to start it over. Any revisions it saved are retracted, and its next save starts a new alternative.', object({ notebook: notebookId, restart: { type: 'string', enum: ['blank', 'selection'], description: 'blank (default): empty. selection: back to the originally selected text.' } }, ['notebook'])),
  tool('finish_changes', 'Close the drafting phase. NoirDraft saves notebooks that are ready, and answers with a summary of what was delivered and a reminder of what to tell the author. It takes no parameters.', object()),
];
export const agentTools = (mode) => [COMMENT, ...(mode === 'inline' ? INLINE_TOOLS : BLOCK_TOOLS), RESPONSE];

const EDITORIAL = 'Copyedit every alternative in its complete surrounding passage: first sentence integrity (no duplicated, missing, or stranded words); then mechanics (spelling, grammar, punctuation, capitalization, spacing, and line breaks); then clarity and coherence; then diction, rhythm, concision, tone, and consistency with the manuscript. Retract any alternative that fails a pass.';

const TOOL_NAME = /\b(?:comment_before_changes|send_response|initialize_changes|edit_notebook|review_notebook|save_notebook|clear_notebook|finish_changes|propose_edits|review_edits)\b/;
// Intents are shown to the author as live progress, so they must read as plain prose.
const leaked = (value, label) => { const name = String(value ?? '').match(TOOL_NAME)?.[0]; return name ? `${label} names an internal tool (${name}). The author reads it as progress, so say it in plain prose about the writing, for example "the scene is finished and ready to be delivered" or "I will make the ending less abrupt".` : null; };

const MIN_TOOL_RESPONSE_TOKENS = 1024;
const MAX_NOTEBOOKS = 6;
const CHAT_ROUND_LIMIT = 40;

function assertComplete({ message, finishReason, raw }) {
  if (finishReason === 'length') throw new AgentError('KoboldCpp stopped before completing the tool response. Increase the output limit and retry.', { code: 'TRUNCATED_TOOL_RESPONSE', rawText: raw });
  const content = String(message?.content ?? '').trim();
  const names = 'comment_before_changes|send_response|initialize_changes|edit_notebook|review_notebook|save_notebook|propose_edits|review_edits';
  const unparsed = /^[\[{]/.test(content) && new RegExp(`"(?:tool_calls|function|${names})"`).test(content) || new RegExp(`<\\|tool_call(?:\\|>|>)|call:(?:${names})\\{|\\b(?:${names})\\s*\\(`).test(content);
  if (!message?.tool_calls?.length && unparsed) throw new AgentError('KoboldCpp returned an unparsed tool call instead of a completed response. Retry the turn.', { code: 'UNPARSED_TOOL_CALL', rawText: raw });
  if (!message?.tool_calls?.length) throw new AgentError('KoboldCpp did not return the required native tool call. Retry the turn.', { code: 'MISSING_REQUIRED_TOOL_CALL', rawText: raw });
}
function receipt(status, reason, extra = {}) { return JSON.stringify({ status, ...(reason ? { reason } : {}), ...extra }); }
function retainBreak(value, target) { const ending = String(target).match(/(?:\r\n|\n)+$/)?.[0]; return !ending || /(?:\r\n|\n)$/.test(value) ? value : `${value}${ending}`; }
function word(value) { return /[\p{L}\p{N}]/u.test(value); }
function inserted(value, before, after) { let result = String(value); if (word(before) && word(result[0] ?? '')) result = ` ${result}`; if (word(result.at(-1) ?? '') && word(after)) result = `${result} `; return result; }

export async function requestRewrite({ client, history, baseRevisionId, range, mode: forcedMode, inlineWordLimit = INLINE_WORD_LIMIT, root = 'STORY', contextStoryText, request, metadataText = '', pins = [], references = [], chatHistory = [], contextRows = 12, agentProtocol, generationOptions = {}, onProgress, signal }) {
  const base = await reconstructRevision(history, baseRevisionId);
  const [from, to] = range;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to > base.length) throw new AgentError('The selected range is invalid for its base revision.', { code: 'INVALID_RANGE' });
  const context = sliceContextRows(base, from, to, contextRows);
  let mode = forcedMode ?? classifyPlacement(base, from, to);
  let tools = agentTools(mode);
  let allowed = new Set(tools.map((item) => item.function.name));
  const composeMode = mode;
  const composed = composeContext({ mode: composeMode, storyText: contextStoryText ?? (root === 'STORY' ? base : ''), metadataText, pins, references, before: context.before, target: context.target, after: context.after, request, agentProtocol, chatHistory });
  const prompt = `${composed.staticPrompt}\n\n${composed.turnPrompt}`;
  const transcript = [{ role: 'system', content: composed.staticPrompt }, { role: 'user', content: composed.turnPrompt }];
  const trace = [];
  let raw = ''; let message; let calls;
  const getResponse = async () => {
    try {
      const response = await client.chatCompletion({ messages: transcript, tools, toolChoice: 'required', maxTokens: Math.max(MIN_TOOL_RESPONSE_TOKENS, generationOptions.max_length ?? 0), temperature: generationOptions.temperature ?? 0, signal });
      if (response.raw) trace.push(response.raw);
      raw = trace.join('\n\n');
      assertComplete({ message: response.message, finishReason: response.finishReason, raw });
      message = response.message; calls = message.tool_calls;
    } catch (cause) {
      if (cause?.name === 'AbortError') throw new AgentError('Generation was cancelled.', { code: 'ABORTED', cause, rawText: raw });
      throw new AgentError(`KoboldCpp generation failed.${cause?.message ? ` ${cause.message}` : ''}`, { code: cause instanceof KoboldError ? cause.code : 'GENERATE_FAILED', cause, rawText: cause?.rawText ?? raw });
    }
  };
  await getResponse();

  let grandIntent = null; let complete = false; let closed = false; let finishWarned = false; let deadline = null;
  let objective = null; let lastOverview = ''; let batchIntent = null; let batchNumber = 0; let reviewVisible = false;
  const pending = []; const approved = []; const replacements = new Map(); const issues = [];
  const firstMessage = () => segments.find((segment) => segment.say != null)?.say ?? null;
  let notebooks = []; let activeId = null; let roundLimit = CHAT_ROUND_LIMIT;
  const segments = [];
  const texts = new Map(); const cached = new Map([[baseRevisionId, base]]); const snapshots = [];
  const heads = () => mode === 'inline' ? approved.filter((revision) => history.revisions.get(revision.id) === revision) : notebooks.filter((notebook) => notebook.submissions.length && !isEmptyNotebook(notebook)).map((notebook) => history.revisions.get(notebook.submissions.at(-1))).filter(Boolean);
  const link = (revision) => `[#${revision.id}](noirdraft://version/${root}/${revision.id})`;
  // The reply is paragraphs: each message alone, and all change links together.
  const finalChat = () => {
    const paragraphs = []; let linkIndex = -1;
    for (const segment of segments) {
      if (segment.say != null) { linkIndex = -1; paragraphs.push(segment.say); continue; }
      const revision = segment.revision != null ? history.revisions.get(segment.revision) : (() => { const notebook = notebooks.find((item) => item.id === segment.notebook); return notebook?.submissions.length && !isEmptyNotebook(notebook) ? history.revisions.get(notebook.submissions.at(-1)) : null; })();
      if (!revision) continue;
      if (linkIndex >= 0) paragraphs[linkIndex] += ` ${link(revision)}`; else linkIndex = paragraphs.push(link(revision)) - 1;
    }
    return paragraphs.join('\n\n');
  };
  const progressLine = () => {
    if (mode === 'inline') {
      if (!objective) return '';
      const states = [...approved.map(() => '✓'), ...pending.map(() => '…')];
      while (states.length < objective.alternativeCount) states.push('–');
      const width = String(states.length).length;
      const rows = states.map((state, index) => `Alternative ${String(index + 1).padStart(width)} ${state}`);
      return `${rows.join('\n')}${lastOverview ? `\n> ${lastOverview.replace(/\n+/g, '\n> ')}` : ''}`;
    }
    const status = (notebook) => isEmptyNotebook(notebook) ? '–' : notebook.submissions.length && notebookText(notebook) === notebook.submittedText ? '✓' : '…';
    const delivered = notebooks.map((notebook) => String(wordCount(notebookText(notebook))));
    const planned = notebooks.map((notebook) => String(notebook.targetWords));
    const idWidth = Math.max(...notebooks.map((notebook) => String(notebook.id).length));
    const deliveredWidth = Math.max(...delivered.map((text) => text.length));
    const plannedWidth = Math.max(...planned.map((text) => text.length));
    const rows = notebooks.map((notebook, index) => `Notebook ${notebook.id === activeId && notebooks.length > 1 ? '▸' : ' '}${String(notebook.id).padStart(idWidth)} ${delivered[index].padStart(deliveredWidth)}/${planned[index].padStart(plannedWidth)}w ${status(notebook)}`);
    const next = notebooks.find((notebook) => notebook.id === activeId)?.nextIntent;
    return `${rows.join('\n')}${next ? `\nNext: ${next}` : ''}`;
  };
  const report = () => onProgress?.({ rawResponse: raw, chat: finalChat(), revisions: heads(), intent: grandIntent ?? objective?.text ? { intent: grandIntent ?? objective.text, progress: progressLine() } : null });
  const reject = (reason) => ({ ok: false, content: receipt('rejected', reason) });
  const accept = (content) => ({ ok: true, content });
  const reasonOf = (result) => { try { return JSON.parse(result.content).reason; } catch { return result.content; } };
  const remove = (id) => { history.revisions.delete(id); history.retiredRevisionIdFloor = Math.max(history.retiredRevisionIdFloor ?? -1, id); };
  const retract = (notebook) => {
    notebook.submissions.forEach(remove);
    const index = segments.findIndex((segment) => segment.notebook === notebook.id);
    if (index >= 0) segments.splice(index, 1);
    return { ...notebook, submissions: [], submittedText: null, summary: null };
  };
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
  const replacementFor = (body) => context.target.length ? retainBreak(body, context.target) : inserted(body, base.at(from - 1) ?? '', base.at(to) ?? '');
  const place = (body) => `${base.slice(0, from)}${replacementFor(body)}${base.slice(to)}`;
  const compose = (notebook) => place(notebookText(notebook));
  const form = (notebook, lastEdit) => renderReview({ grandIntent, notebooks, activeId: notebook.id, before: context.before, after: context.after, lastEdit });
  const pick = (args) => {
    const id = args.notebook ?? activeId;
    const notebook = notebooks.find((item) => item.id === id);
    if (!notebook) return { error: reject(`Notebook ${id} does not exist. Your notebooks are ${notebooks.map((item) => item.id).join(', ')}.`) };
    activeId = notebook.id;
    return { notebook };
  };
  const replaceNotebook = (notebook) => { notebooks = notebooks.map((item) => item.id === notebook.id ? notebook : item); return notebook; };
  const totalReviews = () => notebooks.reduce((sum, notebook) => sum + notebook.reviews, 0);
  const totalHard = () => notebooks.reduce((sum, notebook) => sum + notebook.budget.hard, 0);
  const problem = (notebook) => {
    if (isEmptyNotebook(notebook)) return 'It is empty, so there is nothing to save.';
    if (notebook.needsReview) return 'It changed since its last review. Call review_notebook first.';
    const placeholders = placeholderIds(notebook);
    if (placeholders.length) return `Placeholder paragraphs remain: ${placeholders.map((id) => `¶${id}`).join(', ')}. Replace them with finished text or delete them.`;
    if (notebook.lastReviewClean === false) return 'Your last review found problems. Edit to address them, review again, then save.';
    return null;
  };
  const submit = async (notebook, summary) => {
    const body = notebookText(notebook);
    const previous = notebook.submissions.length ? notebook.submittedText : notebook.baseline;
    if (body === previous) return reject(`Notebook ${notebook.id} has no changes ${notebook.submissions.length ? 'since it was saved' : 'from its starting text'}. What did you intend? You may have edited a different notebook, or meant to save another id. Edit this notebook, or save the one you changed.`);
    const candidate = compose(notebook);
    if (candidate === base) return reject(`Notebook ${notebook.id} would leave the document unchanged. Change its text before submitting.`);
    const parentId = notebook.submissions.at(-1) ?? baseRevisionId;
    if (!notebook.submissions.length) {
      const sibling = await identical(candidate);
      if (sibling) return reject(`Notebook ${notebook.id} matches existing revision #${sibling.id}. Give this variation its own direction, or save a different notebook.`);
    }
    const parentText = notebook.submissions.length ? texts.get(parentId) : base;
    const revision = await commitRevision(history, parentText, candidate, { origin: 'agent', parentId, setCurrent: false, note: null });
    if (!revision) return reject(`Notebook ${notebook.id} would leave the document unchanged. Change its text before submitting.`);
    texts.set(revision.id, candidate); cached.set(revision.id, candidate);
    replaceNotebook({ ...notebook, submissions: [...notebook.submissions, revision.id], submittedText: body, summary: summary?.trim() || notebook.summary });
    if (!segments.some((segment) => segment.notebook === notebook.id)) segments.push({ notebook: notebook.id });
    return { revision };
  };
  // Submits every changed notebook that passes the gates; reports the rest.
  const settle = async () => {
    const delivered = []; const blocked = [];
    for (const { id } of [...notebooks]) {
      const current = notebooks.find((item) => item.id === id);
      if (isEmptyNotebook(current) || notebookText(current) === (current.submissions.length ? current.submittedText : current.baseline)) continue;
      const reason = problem(current);
      if (reason) { blocked.push({ id, reason }); continue; }
      const result = await submit(current, null);
      if (result.revision) delivered.push(id); else blocked.push({ id, reason: reasonOf(result) });
    }
    return { delivered, blocked };
  };
  const pendingText = () => {
    const pending = notebooks.filter((notebook) => !notebook.submissions.length);
    if (!pending.length) return '';
    const next = pending.find((notebook) => isEmptyNotebook(notebook));
    const lines = ['', `${notebooks.length - pending.length}/${notebooks.length} notebooks saved.`];
    if (next) lines.push(`Next, write notebook ${next.id}: "${next.intent}" It is still empty. Start with edit_notebook (notebook: ${next.id}), then review and save it.`);
    else lines.push(`Still unsaved: ${pending.map((notebook) => `notebook ${notebook.id}`).join(', ')}.`);
    return lines.join('\n');
  };
  const receiptText = () => {
    const lines = ['NOIRDRAFT WORK SUMMARY', `The author's request: ${request}`];
    if (firstMessage()) lines.push(`Your first message to the author: "${firstMessage()}"`);
    if (grandIntent) lines.push(`Your overall intent: ${grandIntent}`);
    for (const notebook of notebooks) {
      const words = wordCount(notebookText(notebook));
      const size = notebook.targetWords && words < notebook.targetWords * 0.5 ? ' (well under target)' : notebook.targetWords && words > notebook.targetWords * 1.5 ? ' (well over target)' : '';
      lines.push(`Notebook ${notebook.id} — ${notebook.intent} (target about ${notebook.targetWords} words)`);
      if (notebook.submissions.length) lines.push(`  achieved: ${stateOf(notebook)}, ${words} words${size}${notebook.summary ? ` — ${notebook.summary}` : ''}`);
      else if (isEmptyNotebook(notebook)) lines.push('  not achieved: empty, nothing delivered.');
      else lines.push(`  not achieved: not delivered — ${problem(notebook) ?? 'left unsaved'}`);
    }
    if (deadline) lines.push(deadline);
    lines.push('Now use send_response as the culmination of this: continue naturally from your first message, say what was achieved and what was not (unmet targets, dropped variations, limits), and why it satisfies the request. Do not narrate the drafting, editing, or review steps, and do not repeat the revision text.');
    return lines.join('\n');
  };
  const wrapUp = async () => {
    const { delivered, blocked } = await settle();
    deadline = `The review deadline was reached, so NoirDraft closed the work. ${delivered.length ? `It saved notebook${delivered.length === 1 ? '' : 's'} ${delivered.join(', ')}. ` : ''}${blocked.length ? `Not ready and discarded: ${blocked.map(({ id }) => id).join(', ')}.` : ''}`.trim();
    closed = true;
    return accept(receiptText());
  };
  const blockSettle = async () => {
    if (!notebooks.length || closed) return null;
    const { delivered, blocked } = await settle();
    if (blocked.length && !finishWarned) {
      finishWarned = true;
      return ['NOIRDRAFT RESPONSE NOT SENT YET', delivered.length ? `NoirDraft saved the ready notebook${delivered.length === 1 ? '' : 's'}: ${delivered.join(', ')}.` : '', ...blocked.map(({ id, reason }) => `- Notebook ${id}: ${reason}`), 'Fix and save these, or clear_notebook to abandon one, then call send_response again. Calling it again now leaves them out and ends the turn.'].filter(Boolean).join('\n');
    }
    closed = true;
    return null;
  };
  const discard = (revision) => { for (const list of [pending, approved]) { const index = list.indexOf(revision); if (index >= 0) list.splice(index, 1); } remove(revision.id); };
  const inlineSettle = () => {
    if (!reviewVisible && !pending.length) return null;
    if (!finishWarned) { finishWarned = true; return ['NOIRDRAFT RESPONSE NOT SENT YET', 'The displayed alternatives have not been reviewed. Call review_edits, or call send_response again to discard them and end the turn.'].join('\n'); }
    for (const revision of [...pending]) discard(revision);
    reviewVisible = false;
    return null;
  };
  const inline = (value) => renderInline({ before: context.before, text: value, after: context.after });
  const inlineReview = (omitted = []) => {
    const lines = ['NOIRDRAFT EDIT REVIEW', `Objective: ${objective.alternativeCount} alternatives — ${objective.text}`];
    if (batchNumber > 1) lines.push(`This batch: ${pending.length} alternatives — ${batchIntent}`);
    lines.push(`Editorial concern: ${EDITORIAL}`, 'Managerial concern: First give review_edits a brief set_overview identifying strengths and concrete problems. Then copyedit every listed revision: sentence_integrity, mechanics, clarity, and style must all be true before verdict approve; otherwise retract it. After this review, either call propose_edits with a fresh intent and alternative_count, or call send_response.');
    if (omitted.length) lines.push(`Before review, ignored invalid proposals: ${omitted.join(' ')}`);
    lines.push('Each text is shown in its surrounding passage; ⟦ ⟧ marks exactly the replaced text.', '----- ORIGINAL -----', inline(context.target));
    for (const revision of pending) lines.push(`----- REVISION #${revision.id} -----`, inline(replacements.get(revision.id)));
    lines.push('----- END REVISIONS -----');
    return lines.join('\n');
  };
  const shortProgress = () => {
    const needed = Math.max(0, objective.alternativeCount - approved.length);
    const alternative = (count) => `${count} alternative${count === 1 ? '' : 's'}`;
    const summary = needed ? `Progress: ${approved.length} of ${objective.alternativeCount} planned alternatives are approved; ${alternative(needed)} remain${needed === 1 ? 's' : ''} pending.` : `Progress: all ${objective.alternativeCount} planned alternatives are approved (100%).`;
    const recommendation = needed ? ' I recommend calling propose_edits to pursue the remaining alternatives.' : ' You may run another batch only if it would add useful alternatives.';
    const exit = needed === 0 ? ' You may call send_response now.' : approved.length === 0 ? ' You may call send_response early if further alternatives are not worthwhile; briefly explain why none were produced.' : ' You may call send_response early if the approved alternatives sufficiently serve the objective; briefly note that fewer than planned were approved.';
    return `NOIRDRAFT PROGRESS\nThe author's request: ${request}\n${firstMessage() ? `Your first message to the author: "${firstMessage()}"\n` : ''}The stated objective: ${objective.text}\n${issues.length ? `Along the way:\n${issues.map((issue) => `- ${issue}`).join('\n')}\n` : ''}${summary}${recommendation}${exit}\nWhen you send_response, continue naturally from your first message, say what was achieved and what was not, and why it satisfies the request.`;
  };
  const createBatch = async (proposals) => {
    if (!Array.isArray(proposals) || !proposals.length) return reject('propose_edits requires at least one proposal.');
    const prepared = []; const errors = [];
    for (const [index, item] of proposals.entries()) {
      const label = `Proposal ${index + 1}`;
      if (typeof item?.text !== 'string' || !item.text.trim()) { errors.push(`${label} has no text.`); continue; }
      const candidate = place(item.text);
      if (candidate === base) { errors.push(`${label} leaves the document unchanged.`); continue; }
      if (prepared.some((existing) => existing.candidate === candidate)) { errors.push(`${label} duplicates another proposal in this batch.`); continue; }
      const sibling = await identical(candidate);
      if (sibling) { errors.push(`${label} is identical to existing revision #${sibling.id}.`); continue; }
      prepared.push({ candidate, replacement: replacementFor(item.text) });
    }
    if (!prepared.length) return { ok: false, content: ['NOIRDRAFT BATCH ERRORS', ...errors.map((error) => `- ${error}`), 'Correct every listed proposal, then call propose_edits with a fresh batch.'].join('\n') };
    for (const { candidate, replacement } of prepared) {
      const revision = await commitRevision(history, base, candidate, { origin: 'agent', parentId: baseRevisionId, setCurrent: false, note: null });
      if (!revision) { errors.push('A proposal leaves the document unchanged.'); continue; }
      texts.set(revision.id, candidate); cached.set(revision.id, candidate); replacements.set(revision.id, replacement); pending.push(revision);
    }
    batchNumber += 1; reviewVisible = true;
    return accept(inlineReview(errors));
  };
  const assessBatch = (setOverview, reviews) => {
    if (!reviewVisible) return reject('Call review_edits only after NoirDraft has shown alternatives to review.');
    if (typeof setOverview !== 'string' || !setOverview.trim()) return reject('review_edits requires a brief set_overview before the individual assessments.');
    const candidates = [...pending];
    if (!Array.isArray(reviews) || reviews.length !== candidates.length) return reject('review_edits needs exactly one assessment for every revision in the displayed review.');
    const byId = new Map(reviews.map((review) => [review?.revision_id, review]));
    if (byId.size !== candidates.length || candidates.some((revision) => !byId.has(revision.id))) return reject('Each displayed revision must be assessed exactly once.');
    for (const revision of candidates) {
      const review = byId.get(revision.id); const checklist = review.copyedit;
      if (typeof review.comment !== 'string' || !review.comment.trim() || !['approve', 'retract'].includes(review.verdict) || !checklist || !['sentence_integrity', 'mechanics', 'clarity', 'style'].every((key) => typeof checklist[key] === 'boolean')) return reject('Each assessment requires copyedit sentence_integrity, mechanics, clarity, and style; then a comment and verdict approve or retract.');
      if (review.verdict === 'approve' && !Object.values(checklist).every(Boolean)) return reject('Approve only when every copyedit check is true; otherwise retract the revision.');
    }
    issues.push(`review overview: ${setOverview.trim()}`);
    lastOverview = setOverview.trim();
    for (const revision of candidates) {
      pending.splice(pending.indexOf(revision), 1);
      if (byId.get(revision.id).verdict === 'retract') { issues.push(`#${revision.id} retracted: ${byId.get(revision.id).comment.trim()}`); remove(revision.id); }
      else { approved.push(revision); segments.push({ revision: revision.id }); }
    }
    reviewVisible = false;
    return accept(shortProgress());
  };
  const execute = async (call) => {
    const name = call?.function?.name;
    let args; try { args = JSON.parse(call?.function?.arguments ?? '{}'); } catch { return reject('Tool arguments must be valid JSON.'); }
    if (!allowed.has(name)) return reject(`"${name}" is not available in this turn. Your tools are ${[...allowed].join(', ')}.`);
    if (name === 'comment_before_changes') {
      if (typeof args.message !== 'string' || !args.message.trim()) return reject('comment_before_changes requires a nonempty message.');
      if (notebooks.length || batchNumber) return reject('Changes have already started. Use send_response after the work to explain what was done.');
      segments.push({ say: args.message.trim() });
      return accept(['NOIRDRAFT COMMENT ADDED', 'Your comment was added to the reply. Now start the work, or, if no edit is needed, answer with send_response.', mode === 'inline' ? 'Start with propose_edits.' : 'Start with initialize_changes.'].join('\n'));
    }
    if (name === 'send_response') {
      if (typeof args.message !== 'string' || !args.message.trim()) return reject('send_response requires a nonempty message.');
      const bounce = mode === 'inline' ? inlineSettle() : await blockSettle();
      if (bounce) return accept(bounce);
      segments.push({ say: args.message.trim() });
      complete = true; return accept(receipt('finished'));
    }
    if (name === 'propose_edits') {
      if (typeof args.intent !== 'string' || !args.intent.trim() || !Number.isSafeInteger(args.alternative_count) || args.alternative_count < 1) return reject('propose_edits requires a clear intent and positive alternative_count before its proposals.');
      if (reviewVisible) return reject('The previous alternatives are still awaiting review. Call review_edits before proposing another batch.');
      const leak = leaked(args.intent, 'Your intent'); if (leak) return reject(leak);
      if (!objective) objective = { text: args.intent.trim(), alternativeCount: args.alternative_count };
      batchIntent = args.intent.trim();
      return createBatch(args.proposals);
    }
    if (name === 'review_edits') {
      if (!objective) return reject('There is no active objective to review. Call propose_edits first.');
      return assessBatch(args.set_overview, args.reviews);
    }
    if (name === 'initialize_changes') {
      if (closed) return reject('Your work is finished. Tell the author what happened with send_response.');
      if (notebooks.length) return reject('Notebooks are already open. Use edit_notebook on them, or call finish_changes.');
      if (typeof args.intent !== 'string' || !args.intent.trim()) return reject('initialize_changes requires the overall intent of the writing.');
      if (!Array.isArray(args.notebooks) || !args.notebooks.length || args.notebooks.length > MAX_NOTEBOOKS) return reject(`initialize_changes requires between 1 and ${MAX_NOTEBOOKS} notebooks.`);
      const specs = args.notebooks;
      const bad = specs.findIndex((spec) => typeof spec?.intent !== 'string' || !spec.intent.trim() || !Number.isSafeInteger(spec.target_words) || spec.target_words < 1 || (spec.start != null && !['selection', 'blank'].includes(spec.start)));
      if (bad >= 0) return reject(`Notebook ${bad + 1} needs an intent and a positive target_words; start, if given, is selection or blank.`);
      const leak = leaked(args.intent, 'Your overall intent') ?? specs.map((spec, index) => leaked(spec.intent, `Notebook ${index + 1}'s intent`)).find(Boolean);
      if (leak) return reject(leak);
      if (specs.every((spec) => spec.target_words < inlineWordLimit)) {
        mode = 'inline'; tools = agentTools(mode); allowed = new Set(tools.map((item) => item.function.name));
        return accept(['NOIRDRAFT SWITCHED TO INLINE ALTERNATIVES', `The text you plan is small (under ${inlineWordLimit} words each), so notebooks are not needed. NoirDraft has switched this request to inline alternatives, and no notebook was opened.`, `Now call propose_edits with your intent and alternative_count ${specs.length}, giving the complete text of each alternative.`].join('\n'));
      }
      grandIntent = args.intent.trim();
      notebooks = specs.map((spec, index) => createNotebook({ id: index + 1, intent: spec.intent.trim(), targetWords: spec.target_words, seed: (spec.start ?? (context.target ? 'selection' : 'blank')) === 'selection' ? context.target : '' }));
      activeId = 1;
      roundLimit = CHAT_ROUND_LIMIT + 4 * totalHard();
      return accept(form(notebooks[0]));
    }
    if (['edit_notebook', 'review_notebook', 'save_notebook', 'clear_notebook'].includes(name)) {
      if (!notebooks.length) return reject('There are no open notebooks. Call initialize_changes first.');
      if (closed) return reject('Your work is finished. Tell the author what happened with send_response.');
    }
    if (name === 'edit_notebook') {
      const { notebook, error } = pick(args); if (error) return error;
      if (notebook.needsReview) return reject(`Notebook ${notebook.id} has unreviewed edits. Call review_notebook with your findings and next_intent before editing again.`);
      const result = applyOperations(notebook, args.operations);
      if (!result.ok) return { ok: false, content: ['NOIRDRAFT EDIT ERRORS', ...result.errors.map((error) => `- ${error}`)].join('\n') };
      let updated = result.notebook; const retracted = isEmptyNotebook(updated) && updated.submissions.length > 0;
      if (retracted) updated = retract(updated);
      updated = replaceNotebook(updated);
      snapshots.push({ notebook: updated.id, review: updated.reviews, text: notebookText(updated) });
      return accept(form(updated, `Applied ${args.operations.length} operation${args.operations.length === 1 ? '' : 's'}.${retracted ? ` Notebook ${updated.id} is now empty, so its saved revisions were retracted; anything you write next starts a new alternative.` : ''}`));
    }
    if (name === 'clear_notebook') {
      const { notebook, error } = pick(args); if (error) return error;
      const restart = args.restart ?? 'blank';
      if (!['blank', 'selection'].includes(restart)) return reject('clear_notebook restart must be blank or selection.');
      const had = notebook.submissions.length > 0;
      const cleared = replaceNotebook(resetNotebook(retract(notebook), restart === 'selection' ? context.target : ''));
      return accept(form(cleared, `Notebook ${cleared.id} was cleared${restart === 'selection' ? ' back to the selected text' : ''}.${had ? ' Its saved revisions were retracted.' : ''} Its next save starts a new alternative.`));
    }
    if (name === 'review_notebook') {
      const { notebook, error } = pick(args); if (error) return error;
      const checklist = args.copyedit;
      if (!checklist || !['sentence_integrity', 'mechanics', 'clarity', 'style'].every((key) => typeof checklist[key] === 'boolean')) return reject('review_notebook requires copyedit sentence_integrity, mechanics, clarity, and style, each true or false.');
      if (typeof args.next_intent !== 'string' || !args.next_intent.trim()) return reject('review_notebook requires next_intent: what you will do next, or that the notebook is ready to save.');
      const leak = leaked(args.next_intent, 'Your next_intent') ?? leaked(args.findings, 'Your findings'); if (leak) return reject(leak);
      if (args.next_intent.trim().length > 200) return reject('Keep next_intent to one short line, a working note about what comes next, for example "tighten the dialogue in the middle". Put detail about problems in findings.');
      const clean = Object.values(checklist).every(Boolean);
      if (!clean && (typeof args.findings !== 'string' || !args.findings.trim())) return reject('A false copyedit check needs findings that name the paragraph ids affected, so the next edit knows where to look.');
      const marked = markReviewed(notebook, args.next_intent);
      const reviewed = replaceNotebook({ ...marked, lastReviewClean: clean, journal: [...notebook.journal, `review ${marked.reviews}: ${clean ? 'no problems found' : args.findings.trim()}; next: ${args.next_intent.trim()}`] });
      if (reviewed.reviews >= reviewed.budget.hard || totalReviews() >= totalHard()) return wrapUp();
      return accept(form(reviewed));
    }
    if (name === 'save_notebook') {
      const { notebook, error } = pick(args); if (error) return error;
      const leak = leaked(args.summary, 'Your summary'); if (leak) return reject(leak);
      const blocked = problem(notebook);
      if (blocked) return reject(`Notebook ${notebook.id} cannot be saved yet. ${blocked}`);
      const words = wordCount(notebookText(notebook));
      if (!notebook.shortWarned && !notebook.submissions.length && notebook.targetWords && words < notebook.targetWords * 0.6) {
        replaceNotebook({ ...notebook, shortWarned: true });
        return reject(`Notebook ${notebook.id} is ${words} words against a target of about ${notebook.targetWords}. The author asked for more: keep expanding it, or save again to deliver it as it is.`);
      }
      const result = await submit(notebook, args.summary);
      if (!result.revision) return result;
      const label = notebook.submissions.length ? `a continuation of revision #${notebook.submissions.at(-1)}` : 'a new alternative';
      if (notebooks.length === 1) { closed = true; return accept(`NOIRDRAFT SAVED\nNotebook ${notebook.id} is recorded as revision #${result.revision.id}, ${label}. It is your only notebook, so there is nothing to compare and NoirDraft closed the drafting.\n${receiptText()}`); }
      return accept(`NOIRDRAFT SAVED\nNotebook ${notebook.id} is recorded as revision #${result.revision.id}, ${label}. Saving is not final: the notebook stays open, and you can keep editing it and save again at any time.${pendingText()}`);
    }
    if (name === 'finish_changes') {
      if (!notebooks.length) return reject('There are no notebooks to finish. If you are done, tell the author with send_response.');
      if (closed) return reject('The changes are already finished. Tell the author what happened with send_response.');
      const { delivered, blocked } = await settle();
      if (blocked.length && !finishWarned) {
        finishWarned = true;
        return accept(['NOIRDRAFT NOT READY TO FINISH', delivered.length ? `NoirDraft saved the ready notebook${delivered.length === 1 ? '' : 's'}: ${delivered.join(', ')}.` : '', ...blocked.map(({ id, reason }) => `- Notebook ${id}: ${reason}`), 'Fix and save these, clear_notebook to abandon one, or call finish_changes again to leave them out.'].filter(Boolean).join('\n'));
      }
      closed = true;
      return accept(receiptText());
    }
    return reject(`Unknown NoirDraft tool "${name}".`);
  };

  report();
  for (let round = 0; round < roundLimit && !complete; round += 1) {
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
  if (!complete) throw new AgentError('KoboldCpp did not finish the turn. Retry the turn.', { code: 'UNFINISHED_TURN', rawText: raw });
  const chat = finalChat();
  if (!chat) throw new AgentError('KoboldCpp finished without any reply for the author.', { code: 'EMPTY_RESPONSE', rawText: raw });
  const finalHeads = heads();
  return { revision: finalHeads[0] ?? null, revisions: finalHeads, generated: finalHeads[0] ? texts.get(finalHeads[0].id) : undefined, chat, changes: finalHeads.map((revision) => texts.get(revision.id)), snapshots, rawResponse: raw, prompt, unresolvedPins: composed.unresolvedPins, anchor: { root, baseRevisionId, range: [from, to], targetHash: await hashStory(context.target), before: context.before, after: context.after } };
}
