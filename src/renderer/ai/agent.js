import { composeContext, sliceContextRows } from './context.js';
import { INLINE_WORD_LIMIT, classifyPlacement, renderInline } from './placement.js';
import { KoboldError } from './kobold.js';
import { applyOperations, createNotebook, resetNotebook, isEmptyNotebook, notebookText, placeholderIds, renderView, stateOf, wordCount } from './notebook.js';
import { commitRevision, reconstructRevision } from '../history/graph.js';
import { hashStory } from '../history/hash.js';

export class AgentError extends Error {
  constructor(message, { code, cause, rawText } = {}) { super(message, { cause }); this.name = 'AgentError'; this.code = code; this.rawText = rawText; }
}

const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const text = { type: 'string' };
const draftId = { type: 'integer', description: 'The number of the draft to act on (1, 2, ...).' };
const draftSpec = object({
  intent: { ...text, description: 'What this variation should be or do, in plain prose. The author reads it as progress; never name tools or protocol steps.' },
  target_words: { type: 'integer', minimum: 1, description: 'About how long this variation should be, in words. If the author asks for a longer, fuller, or expanded text, or names a length, be generous: at least the size asked for, rounded up, never below. NoirDraft derives your drafting budget and its reminders from it.' },
  start: { type: 'string', enum: ['selection', 'blank'], description: 'selection: begin from the selected text and refine it. blank: begin empty and write from scratch. Default: selection when text is selected.' },
}, ['intent', 'target_words']);
const draftText = { ...text, description: 'One or more paragraphs separated by blank lines. A whole paragraph in [square brackets] is a placeholder note to replace later.' };
const paragraphId = { type: 'integer', description: 'A paragraph id from the latest view_draft.' };
const copyedit = object({ sentence_integrity: { type: 'boolean', description: 'True only if the text has no duplicated, omitted, or stranded words and is syntactically complete in context.' }, mechanics: { type: 'boolean', description: 'True only if spelling, grammar, punctuation, capitalization, spacing, and line breaks are correct.' }, clarity: { type: 'boolean', description: 'True only if references and meaning are coherent and clear in context.' }, style: { type: 'boolean', description: 'True only if diction, rhythm, concision, and tone fit the surrounding manuscript.' } }, ['sentence_integrity', 'mechanics', 'clarity', 'style']);
const proposal = object({ text: { ...text, description: 'The complete replacement for the selection only. Never include text before or after the selection.' } }, ['text']);
const assessment = object({ revision_id: { type: 'integer' }, copyedit, comment: text, verdict: { type: 'string', enum: ['approve', 'retract'] } }, ['revision_id', 'copyedit', 'comment', 'verdict']);
const tool = (name, description, parameters) => ({ type: 'function', function: { name, description, parameters } });

const SEND_CONTINUE = tool('send_chat_message_and_continue', 'Send a message to the author without ending the turn. It does not change any drafting state. Use it to say something before or during the work: what you intend to do, a promise, an early note, or an answer alongside further editing still to come.', object({ message: text }, ['message']));
const SEND_TERMINATE = tool('send_chat_response_and_terminate', 'Send your final response to the author and end the turn immediately. Nothing happens after this call. Use it only when everything you intend to do is already complete: after finishing changes, explain what was done and why it satisfies the request; it may also be your first and only call when no edit is needed. Never use it to promise work you have not performed. NoirDraft saves ready work before sending it.', object({ message: text }, ['message']));
const INLINE_TOOLS = [
  tool('propose_edits', 'Propose a batch of fresh sibling alternatives for the selection or cursor. On the first call, intent and alternative_count establish the fixed Objective; on later calls they are the next pending batch plan. Its result shows every alternative inside its surrounding text, to review.', object({ intent: { ...text, description: 'What this batch aims for, in plain prose. The author reads it as progress; never name tools or protocol steps.' }, alternative_count: { type: 'integer', minimum: 1 }, proposals: { type: 'array', minItems: 1, items: proposal } }, ['intent', 'alternative_count', 'proposals'])),
  tool('review_edits', 'First diagnose the whole displayed set, then copyedit every alternative in its context. Approval requires sentence integrity, mechanics, clarity, and style all true; approved alternatives are recorded, retracted ones discarded.', object({ set_overview: { ...text, description: 'A brief diagnosis of the set as a whole: its strongest quality and concrete problems to correct.' }, reviews: { type: 'array', items: assessment } }, ['set_overview', 'reviews'])),
];
const INITIALIZE_ALL_DRAFTS_ONCE = tool('initialize_all_drafts_once', 'One-time setup: call this exactly once, declaring the overall intent and ALL drafts (one per variation) together. It is removed after use; from then on, work each draft through view_draft and the editing tools by its number. For a very long text or an unrequested single result, open one draft; open several only for requested alternatives.', object({ intent: { ...text, description: 'What the whole piece of writing is meant to achieve, in plain prose. The author reads it as progress; never name tools or protocol steps.' }, drafts: { type: 'array', minItems: 1, maxItems: 6, items: draftSpec } }, ['intent', 'drafts']));
const VIEW_DRAFT = tool('view_draft', 'Show the complete working state of a draft: the read-only context before and after it, its numbered paragraphs, its length against target, any placeholders, and what to do next. Call it after opening a draft, and again whenever you want to see the accumulated effect of your edits before continuing.', object({ draft: draftId }, ['draft']));
const REPLACE_DRAFT_TEXT = tool('replace_draft_text', 'Replace one paragraph, or a range of paragraphs, with new text.', object({ draft: draftId, from_paragraph: paragraphId, to_paragraph: { type: 'integer', description: 'Optional: the last paragraph of the range, if replacing more than one.' }, text: draftText }, ['draft', 'from_paragraph', 'text']));
const INSERT_DRAFT_TEXT_BEFORE = tool('insert_draft_text_before', 'Insert new text immediately before a paragraph.', object({ draft: draftId, paragraph: paragraphId, text: draftText }, ['draft', 'paragraph', 'text']));
const INSERT_DRAFT_TEXT_AFTER = tool('insert_draft_text_after', 'Insert new text immediately after a paragraph.', object({ draft: draftId, paragraph: paragraphId, text: draftText }, ['draft', 'paragraph', 'text']));
const DELETE_DRAFT_TEXT = tool('delete_draft_text', 'Delete one paragraph, or a range of paragraphs.', object({ draft: draftId, from_paragraph: paragraphId, to_paragraph: { type: 'integer', description: 'Optional: the last paragraph of the range, if deleting more than one.' } }, ['draft', 'from_paragraph']));
const SAVE_DRAFT = tool('save_draft', 'Record the draft as a change to the document. Only offered once the draft has been viewed after its latest edit, has no placeholders, and has changed. You may edit and save it again later; each save continues the same chain.', object({ draft: draftId }, ['draft']));
const RESTART_DRAFT = tool('restart_draft', 'Wipe a draft to start it over. Any revisions it saved are retracted, and its next save starts a new alternative.', object({ draft: draftId, start: { type: 'string', enum: ['blank', 'selection'], description: 'blank: empty. selection: back to the originally selected text.' } }, ['draft', 'start']));
const FINISH_CHANGES = tool('finish_changes', 'Close the drafting phase. NoirDraft saves drafts that are ready, and answers with a summary of what was delivered and a reminder of what to tell the author. It takes no parameters.', object());

const EDITORIAL = 'Copyedit every alternative in its complete surrounding passage: first sentence integrity (no duplicated, missing, or stranded words); then mechanics (spelling, grammar, punctuation, capitalization, spacing, and line breaks); then clarity and coherence; then diction, rhythm, concision, tone, and consistency with the manuscript. Retract any alternative that fails a pass.';

const TOOL_NAME = /\b(?:send_chat_message_and_continue|send_chat_response_and_terminate|initialize_all_drafts_once|view_draft|replace_draft_text|insert_draft_text_before|insert_draft_text_after|delete_draft_text|save_draft|restart_draft|finish_changes|propose_edits|review_edits)\b/;
// Intents are shown to the author as live progress, so they must read as plain prose.
const leaked = (value, label) => { const name = String(value ?? '').match(TOOL_NAME)?.[0]; return name ? `${label} names an internal tool (${name}). The author reads it as progress, so say it in plain prose about the writing, for example "the scene is finished and ready to be delivered" or "I will make the ending less abrupt".` : null; };

const MIN_TOOL_RESPONSE_TOKENS = 1024;
const MAX_NOTEBOOKS = 6;
const CHAT_ROUND_LIMIT = 40;

function assertComplete({ message, finishReason, raw }) {
  if (finishReason === 'length') throw new AgentError('The AI stopped before completing the tool response. Increase the output limit and retry.', { code: 'TRUNCATED_TOOL_RESPONSE', rawText: raw });
  const content = String(message?.content ?? '').trim();
  const names = 'send_chat_message_and_continue|send_chat_response_and_terminate|initialize_all_drafts_once|view_draft|replace_draft_text|insert_draft_text_before|insert_draft_text_after|delete_draft_text|save_draft|restart_draft|propose_edits|review_edits';
  const unparsed = /^[\[{]/.test(content) && new RegExp(`"(?:tool_calls|function|${names})"`).test(content) || new RegExp(`<\\|tool_call(?:\\|>|>)|call:(?:${names})\\{|\\b(?:${names})\\s*\\(`).test(content);
  if (!message?.tool_calls?.length && unparsed) throw new AgentError('The AI returned an unparsed tool call instead of a completed response. Retry the turn.', { code: 'UNPARSED_TOOL_CALL', rawText: raw });
  if (!message?.tool_calls?.length) throw new AgentError('The AI did not return the required native tool call. Retry the turn.', { code: 'MISSING_REQUIRED_TOOL_CALL', rawText: raw });
}
function receipt(status, reason, extra = {}) { return JSON.stringify({ status, ...(reason ? { reason } : {}), ...extra }); }
function retainBreak(value, target) { const ending = String(target).match(/(?:\r\n|\n)+$/)?.[0]; return !ending || /(?:\r\n|\n)$/.test(value) ? value : `${value}${ending}`; }
function word(value) { return /[\p{L}\p{N}]/u.test(value); }
function inserted(value, before, after) { let result = String(value); if (word(before) && word(result[0] ?? '')) result = ` ${result}`; if (word(result.at(-1) ?? '') && word(after)) result = `${result} `; return result; }
const idList = (ids) => ids.map((id) => `¶${id}`).join(', ');
const formatGuidance = ({ manager, next }) => `Manager: ${manager}\n\nNext: ${next}`;

export async function requestRewrite({ client, history, baseRevisionId, range, mode: forcedMode, inlineWordLimit = INLINE_WORD_LIMIT, root = 'STORY', contextStoryText, request, metadataText = '', pins = [], references = [], chatHistory = [], retry = false, contextRows = 12, agentProtocol, generationOptions = {}, onProgress, signal }) {
  const base = await reconstructRevision(history, baseRevisionId);
  const [from, to] = range;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to > base.length) throw new AgentError('The selected range is invalid for its base revision.', { code: 'INVALID_RANGE' });
  const context = sliceContextRows(base, from, to, contextRows);
  let mode = forcedMode ?? classifyPlacement(base, from, to);
  const composeMode = mode;
  const composed = composeContext({ mode: composeMode, storyText: contextStoryText ?? (root === 'STORY' ? base : ''), metadataText, pins, references, before: context.before, target: context.target, after: context.after, request, agentProtocol, chatHistory, retry });
  const prompt = `${composed.staticPrompt}\n\n${composed.turnPrompt}`;
  const transcript = [{ role: 'system', content: composed.staticPrompt }, { role: 'user', content: composed.turnPrompt }];
  const trace = [];
  let raw = ''; let message; let calls; let tools = []; let allowed = new Set();

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
    const rows = notebooks.map((notebook, index) => `Draft ${notebook.id === activeId && notebooks.length > 1 ? '▸' : ' '}${String(notebook.id).padStart(idWidth)} ${delivered[index].padStart(deliveredWidth)}/${planned[index].padStart(plannedWidth)}w ${status(notebook)}`);
    return rows.join('\n');
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
  const pick = (args) => {
    const id = args.draft ?? activeId;
    const notebook = notebooks.find((item) => item.id === id);
    if (!notebook) return { error: reject(`Draft ${id} does not exist. Your drafts are ${notebooks.map((item) => item.id).join(', ')}.`) };
    activeId = notebook.id;
    return { notebook };
  };
  const replaceNotebook = (notebook) => { notebooks = notebooks.map((item) => item.id === notebook.id ? notebook : item); return notebook; };
  const totalCycles = () => notebooks.reduce((sum, notebook) => sum + notebook.cycles, 0);
  const totalHard = () => notebooks.reduce((sum, notebook) => sum + notebook.budget.hard, 0);
  const problem = (notebook) => {
    if (isEmptyNotebook(notebook)) return 'It is empty, so there is nothing to save.';
    if (notebook.needsView) return 'It changed since it was last viewed. Call view_draft first.';
    const placeholders = placeholderIds(notebook);
    if (placeholders.length) return `Placeholder paragraphs remain: ${idList(placeholders)}. Replace them with finished text or delete them.`;
    return null;
  };
  const saveGate = (notebook) => !problem(notebook) && notebookText(notebook) !== (notebook.submissions.length ? notebook.submittedText : notebook.baseline);
  const submit = async (notebook, summary) => {
    const body = notebookText(notebook);
    const previous = notebook.submissions.length ? notebook.submittedText : notebook.baseline;
    if (body === previous) return reject(`Draft ${notebook.id} has no changes ${notebook.submissions.length ? 'since it was saved' : 'from its starting text'}. What did you intend? You may have edited a different draft, or meant to save another id. Edit this draft, or save the one you changed.`);
    const candidate = compose(notebook);
    if (candidate === base) return reject(`Draft ${notebook.id} would leave the document unchanged. Change its text before submitting.`);
    const parentId = notebook.submissions.at(-1) ?? baseRevisionId;
    if (!notebook.submissions.length) {
      const sibling = await identical(candidate);
      if (sibling) return reject(`Draft ${notebook.id} matches existing revision #${sibling.id}. Give this variation its own direction, or save a different draft.`);
    }
    const parentText = notebook.submissions.length ? texts.get(parentId) : base;
    const revision = await commitRevision(history, parentText, candidate, { origin: 'agent', parentId, setCurrent: false, note: null });
    if (!revision) return reject(`Draft ${notebook.id} would leave the document unchanged. Change its text before submitting.`);
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
  const pendingSummary = () => {
    const pendingList = notebooks.filter((notebook) => !notebook.submissions.length);
    if (!pendingList.length) return formatGuidance({ manager: 'Every requested draft now has a saved version. Further revision should have a concrete purpose.', next: 'finish the changes; alternatively, continue refining a saved draft.' });
    const next = pendingList.find((notebook) => isEmptyNotebook(notebook)) ?? pendingList[0];
    return formatGuidance({ manager: `Draft ${next.id} already exists and is the next requested variation.`, next: `view Draft ${next.id}.` });
  };
  const receiptText = () => {
    const lines = ['NOIRDRAFT CHANGES READY', `The author's request: ${request}`];
    if (firstMessage()) lines.push(`Your first message to the author: "${firstMessage()}"`);
    if (grandIntent) lines.push(`Your overall intent: ${grandIntent}`);
    for (const notebook of notebooks) {
      const words = wordCount(notebookText(notebook));
      const size = notebook.targetWords && words < notebook.targetWords * 0.5 ? ' (well under target)' : notebook.targetWords && words > notebook.targetWords * 1.5 ? ' (well over target)' : '';
      lines.push(`Draft ${notebook.id} — ${notebook.intent} (target about ${notebook.targetWords} words)`);
      if (notebook.submissions.length) lines.push(`  achieved: ${stateOf(notebook)}, ${words} words${size}${notebook.summary ? ` — ${notebook.summary}` : ''}`);
      else if (isEmptyNotebook(notebook)) lines.push('  not achieved: empty, nothing delivered.');
      else lines.push(`  not achieved: not delivered — ${problem(notebook) ?? 'left unsaved'}`);
    }
    if (deadline) lines.push(deadline);
    lines.push('', formatGuidance({ manager: 'The requested writing work is complete.', next: 'send the final chat response and terminate.' }), 'Continue naturally from your first message with send_chat_response_and_terminate: say what was achieved and what was not (unmet targets, dropped variations, limits), and why it satisfies the request. Do not narrate the drafting steps, and do not repeat the revision text.');
    return lines.join('\n');
  };
  const wrapUp = async () => {
    const { delivered, blocked } = await settle();
    deadline = `The cycle deadline was reached, so NoirDraft closed the work. ${delivered.length ? `It saved draft${delivered.length === 1 ? '' : 's'} ${delivered.join(', ')}. ` : ''}${blocked.length ? `Not ready and discarded: ${blocked.map(({ id }) => id).join(', ')}.` : ''}`.trim();
    closed = true;
    return accept(receiptText());
  };
  const blockSettle = async () => {
    if (!notebooks.length || closed) return null;
    const { delivered, blocked } = await settle();
    if (blocked.length && !finishWarned) {
      finishWarned = true;
      return ['NOIRDRAFT RESPONSE NOT SENT YET', delivered.length ? `NoirDraft saved the ready draft${delivered.length === 1 ? '' : 's'}: ${delivered.join(', ')}.` : '', ...blocked.map(({ id, reason }) => `- Draft ${id}: ${reason}`), 'Fix and save these, or restart_draft to abandon one, then call send_chat_response_and_terminate again. Calling it again now leaves them out and ends the turn.'].filter(Boolean).join('\n');
    }
    closed = true;
    return null;
  };
  const discard = (revision) => { for (const list of [pending, approved]) { const index = list.indexOf(revision); if (index >= 0) list.splice(index, 1); } remove(revision.id); };
  const inlineSettle = () => {
    if (!reviewVisible && !pending.length) return null;
    if (!finishWarned) { finishWarned = true; return ['NOIRDRAFT RESPONSE NOT SENT YET', 'The displayed alternatives have not been reviewed. Call review_edits, or call send_chat_response_and_terminate again to discard them and end the turn.'].join('\n'); }
    for (const revision of [...pending]) discard(revision);
    reviewVisible = false;
    return null;
  };
  const inline = (value) => renderInline({ before: context.before, text: value, after: context.after });
  const inlineReview = (omitted = []) => {
    const lines = ['NOIRDRAFT EDIT REVIEW', `Objective: ${objective.alternativeCount} alternatives — ${objective.text}`];
    if (batchNumber > 1) lines.push(`This batch: ${pending.length} alternatives — ${batchIntent}`);
    lines.push(`Editorial concern: ${EDITORIAL}`, 'Managerial concern: First give review_edits a brief set_overview identifying strengths and concrete problems. Then copyedit every listed revision: sentence_integrity, mechanics, clarity, and style must all be true before verdict approve; otherwise retract it. After this review, either call propose_edits with a fresh intent and alternative_count, or call send_chat_response_and_terminate.');
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
    const exit = needed === 0 ? ' You may call send_chat_response_and_terminate now.' : approved.length === 0 ? ' You may call send_chat_response_and_terminate early if further alternatives are not worthwhile; briefly explain why none were produced.' : ' You may call send_chat_response_and_terminate early if the approved alternatives sufficiently serve the objective; briefly note that fewer than planned were approved.';
    return `NOIRDRAFT PROGRESS\nThe author's request: ${request}\n${firstMessage() ? `Your first message to the author: "${firstMessage()}"\n` : ''}The stated objective: ${objective.text}\n${issues.length ? `Along the way:\n${issues.map((issue) => `- ${issue}`).join('\n')}\n` : ''}${summary}${recommendation}${exit}\nWhen you send the chat response, continue naturally from your first message, say what was achieved and what was not, and why it satisfies the request.`;
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

  // --- block-flow guidance -------------------------------------------------
  const draftGuidance = (notebook, { initialView = false } = {}) => {
    const { soft, hard, paragraphs: projected } = notebook.budget;
    const placeholders = placeholderIds(notebook);
    if (initialView && isEmptyNotebook(notebook) && projected >= 6) {
      return { manager: 'This is a long blank draft. Establish its structure first with short [placeholder] paragraphs for the major sections or beats, then expand them progressively.', next: `outline Draft ${notebook.id} with placeholder paragraphs.` };
    }
    if (placeholders.length) {
      return { manager: `Placeholder paragraphs remain: ${idList(placeholders)}. Replace them with finished text before this draft can be saved.`, next: `continue editing Draft ${notebook.id}.` };
    }
    if (isEmptyNotebook(notebook)) {
      return { manager: 'The draft is still empty.', next: `write Draft ${notebook.id}.` };
    }
    if (notebook.cycles >= hard) {
      return { manager: 'Do not begin another general revision cycle.', next: `save Draft ${notebook.id}.` };
    }
    if (notebook.cycles >= soft) {
      return { manager: 'The expected drafting budget has passed. Delivery should now be the default.', next: `save Draft ${notebook.id}.` };
    }
    if (notebook.cycles >= Math.floor(soft * 0.75)) {
      return { manager: 'Start converging. Avoid opening new directions.', next: `save Draft ${notebook.id} if it is ready; alternatively, make one focused correction.` };
    }
    return { manager: 'The draft has ample drafting budget remaining.', next: `continue editing Draft ${notebook.id}.` };
  };
  const editGuidance = (notebook) => {
    const currentIds = new Set(notebook.paragraphs.map((item) => item.id));
    const structural = notebook.viewedIds.length > 0 && notebook.viewedIds.filter((id) => currentIds.has(id)).length < notebook.viewedIds.length / 2;
    if (structural) return `Next: view Draft ${notebook.id}.`;
    const nearDeadline = notebook.cycles >= Math.floor(notebook.budget.soft * 0.75);
    const n = notebook.editsSinceView;
    const lowCeiling = nearDeadline ? 1 : 2;
    const midCeiling = nearDeadline ? 2 : 4;
    if (n <= lowCeiling) return `Next: continue editing Draft ${notebook.id}; alternatively, view the accumulated changes.`;
    if (n <= midCeiling) return `Next: view Draft ${notebook.id}; alternatively, make one final focused edit.`;
    return `Next: view Draft ${notebook.id} before continuing.`;
  };
  const currentGuidance = () => {
    if (closed) return { manager: 'The requested work is finished.', next: 'send the final chat response and terminate.' };
    if (mode === 'inline') {
      if (!objective) return { manager: 'No alternatives have been proposed yet.', next: 'call propose_edits, or send the chat response if no edit is needed.' };
      const needed = Math.max(0, objective.alternativeCount - approved.length);
      return { manager: needed ? `${approved.length} of ${objective.alternativeCount} planned alternatives are approved.` : 'All planned alternatives are approved.', next: needed ? 'call propose_edits for the remaining alternatives, or review any pending batch.' : 'send the chat response.' };
    }
    if (!notebooks.length) return { manager: 'No drafts are open yet.', next: 'call initialize_all_drafts_once, or send the chat response if no edit is needed.' };
    const active = notebooks.find((item) => item.id === activeId) ?? notebooks[0];
    return draftGuidance(active);
  };
  const applyEdit = (notebook, operation) => {
    const beforeIds = new Set(notebook.paragraphs.map((item) => item.id));
    const result = applyOperations(notebook, [operation]);
    if (!result.ok) return { ok: false, content: ['NOIRDRAFT EDIT ERRORS', ...result.errors.map((error) => `- ${error}`)].join('\n') };
    let updated = result.notebook;
    const retracted = isEmptyNotebook(updated) && updated.submissions.length > 0;
    if (retracted) updated = retract(updated);
    updated = replaceNotebook(updated);
    snapshots.push({ notebook: updated.id, cycles: updated.cycles, text: notebookText(updated) });
    const added = updated.paragraphs.filter((item) => !beforeIds.has(item.id)).map((item) => item.id);
    const summary = [`Draft ${updated.id} updated.`, added.length ? `New paragraph${added.length > 1 ? 's' : ''}: ${added.length > 1 ? `¶${added[0]}–¶${added.at(-1)}` : `¶${added[0]}`}.` : '', retracted ? 'It is now empty, so its saved revisions were retracted; anything you write next starts a new alternative.' : ''].filter(Boolean).join(' ');
    return accept(`${summary}\n\n${editGuidance(updated)}`);
  };

  // --- dynamic tool availability -------------------------------------------
  const currentTools = () => {
    if (closed) return [SEND_CONTINUE, SEND_TERMINATE];
    if (mode === 'inline') return [SEND_CONTINUE, SEND_TERMINATE, ...INLINE_TOOLS];
    if (!notebooks.length) return [SEND_CONTINUE, SEND_TERMINATE, INITIALIZE_ALL_DRAFTS_ONCE];
    const list = [SEND_CONTINUE, SEND_TERMINATE, VIEW_DRAFT, REPLACE_DRAFT_TEXT, INSERT_DRAFT_TEXT_BEFORE, INSERT_DRAFT_TEXT_AFTER, DELETE_DRAFT_TEXT, RESTART_DRAFT];
    if (notebooks.some(saveGate)) list.push(SAVE_DRAFT);
    list.push(FINISH_CHANGES);
    return list;
  };

  const getResponse = async () => {
    tools = currentTools();
    allowed = new Set(tools.map((item) => item.function.name));
    try {
      const response = await client.chatCompletion({ messages: transcript, tools, toolChoice: 'required', maxTokens: Math.max(MIN_TOOL_RESPONSE_TOKENS, generationOptions.max_length ?? 0), temperature: generationOptions.temperature ?? 0, signal });
      if (response.raw) trace.push(response.raw);
      raw = trace.join('\n\n');
      assertComplete({ message: response.message, finishReason: response.finishReason, raw });
      message = response.message; calls = message.tool_calls;
    } catch (cause) {
      if (cause?.name === 'AbortError') throw new AgentError('Generation was cancelled.', { code: 'ABORTED', cause, rawText: raw });
      throw new AgentError(cause instanceof KoboldError ? cause.message : `AI generation failed.${cause?.message ? ` ${cause.message}` : ''}`, { code: cause instanceof KoboldError ? cause.code : 'GENERATE_FAILED', cause, rawText: cause?.rawText ?? raw });
    }
  };
  await getResponse();

  const execute = async (call) => {
    const name = call?.function?.name;
    let args; try { args = JSON.parse(call?.function?.arguments ?? '{}'); } catch { return reject('Tool arguments must be valid JSON.'); }
    if (!allowed.has(name)) return reject(`"${name}" is not available in this turn. Your tools are ${[...allowed].join(', ')}.`);
    if (name === 'send_chat_message_and_continue') {
      if (typeof args.message !== 'string' || !args.message.trim()) return reject('send_chat_message_and_continue requires a nonempty message.');
      segments.push({ say: args.message.trim() });
      return accept(`Message sent.\n\n${formatGuidance(currentGuidance())}`);
    }
    if (name === 'send_chat_response_and_terminate') {
      if (typeof args.message !== 'string' || !args.message.trim()) return reject('send_chat_response_and_terminate requires a nonempty message.');
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
    if (name === 'initialize_all_drafts_once') {
      if (closed) return reject('Your work is finished. Tell the author what happened with send_chat_response_and_terminate.');
      if (notebooks.length) return reject(`Drafts are already initialized: that setup step happens exactly once and is done. Continue with view_draft or the editing tools on the draft you want to work on next.`);
      if (typeof args.intent !== 'string' || !args.intent.trim()) return reject('initialize_all_drafts_once requires the overall intent of the writing.');
      if (!Array.isArray(args.drafts) || !args.drafts.length || args.drafts.length > MAX_NOTEBOOKS) return reject(`initialize_all_drafts_once requires between 1 and ${MAX_NOTEBOOKS} drafts.`);
      const specs = args.drafts;
      const bad = specs.findIndex((spec) => typeof spec?.intent !== 'string' || !spec.intent.trim() || !Number.isSafeInteger(spec.target_words) || spec.target_words < 1 || (spec.start != null && !['selection', 'blank'].includes(spec.start)));
      if (bad >= 0) return reject(`Draft ${bad + 1} needs an intent and a positive target_words; start, if given, is selection or blank.`);
      const leak = leaked(args.intent, 'Your overall intent') ?? specs.map((spec, index) => leaked(spec.intent, `Draft ${index + 1}'s intent`)).find(Boolean);
      if (leak) return reject(leak);
      if (specs.every((spec) => spec.target_words < inlineWordLimit)) {
        mode = 'inline';
        return accept(['NOIRDRAFT SWITCHED TO INLINE ALTERNATIVES', `The text you plan is small (under ${inlineWordLimit} words each), so drafts are not needed. NoirDraft has switched this request to inline alternatives, and no draft was opened.`, `Now call propose_edits with your intent and alternative_count ${specs.length}, giving the complete text of each alternative.`].join('\n'));
      }
      grandIntent = args.intent.trim();
      notebooks = specs.map((spec, index) => createNotebook({ id: index + 1, intent: spec.intent.trim(), targetWords: spec.target_words, seed: (spec.start ?? (context.target ? 'selection' : 'blank')) === 'selection' ? context.target : '' }));
      activeId = 1;
      roundLimit = CHAT_ROUND_LIMIT + 4 * totalHard();
      return accept(['NOIRDRAFT DRAFTS INITIALIZED', `Setup is done and never repeats. ${notebooks.length === 1 ? 'Your draft is' : `Your ${notebooks.length} drafts are`} open:`, ...notebooks.map((notebook) => `- Draft ${notebook.id}: ${notebook.intent} (about ${notebook.targetWords} words)`), '', formatGuidance({ manager: 'All requested drafts already exist. Begin with Draft 1.', next: 'view Draft 1.' })].join('\n'));
    }
    if (['view_draft', 'replace_draft_text', 'insert_draft_text_before', 'insert_draft_text_after', 'delete_draft_text', 'save_draft', 'restart_draft'].includes(name)) {
      if (!notebooks.length) return reject('There are no open drafts. Call initialize_all_drafts_once first.');
      if (closed) return reject('Your work is finished. Tell the author what happened with send_chat_response_and_terminate.');
    }
    if (name === 'view_draft') {
      const { notebook, error } = pick(args); if (error) return error;
      const wasViewed = notebook.hasViewed;
      const currentText = notebookText(notebook);
      const changed = notebook.hasViewed && currentText !== notebook.viewedFrom;
      const viewed = replaceNotebook({ ...notebook, hasViewed: true, needsView: false, editsSinceView: 0, viewedFrom: currentText, viewedIds: notebook.paragraphs.map((item) => item.id), cycles: notebook.cycles + (changed ? 1 : 0) });
      if (viewed.cycles >= viewed.budget.hard || totalCycles() >= totalHard()) return wrapUp();
      const guidance = formatGuidance(draftGuidance(viewed, { initialView: !wasViewed }));
      return accept(renderView({ grandIntent, notebooks, activeId: viewed.id, before: context.before, after: context.after, guidance }));
    }
    if (name === 'replace_draft_text') {
      const { notebook, error } = pick(args); if (error) return error;
      if (typeof args.text !== 'string' || !args.text.trim()) return reject('replace_draft_text needs text. To remove a paragraph, use delete_draft_text.');
      return applyEdit(notebook, { op: 'replace', paragraph_id: args.from_paragraph, through_paragraph_id: args.to_paragraph, text: args.text });
    }
    if (name === 'insert_draft_text_before') {
      const { notebook, error } = pick(args); if (error) return error;
      if (typeof args.text !== 'string' || !args.text.trim()) return reject('insert_draft_text_before needs text.');
      return applyEdit(notebook, { op: 'insert_before', paragraph_id: args.paragraph, text: args.text });
    }
    if (name === 'insert_draft_text_after') {
      const { notebook, error } = pick(args); if (error) return error;
      if (typeof args.text !== 'string' || !args.text.trim()) return reject('insert_draft_text_after needs text.');
      return applyEdit(notebook, { op: 'insert_after', paragraph_id: args.paragraph, text: args.text });
    }
    if (name === 'delete_draft_text') {
      const { notebook, error } = pick(args); if (error) return error;
      return applyEdit(notebook, { op: 'delete', paragraph_id: args.from_paragraph, through_paragraph_id: args.to_paragraph });
    }
    if (name === 'restart_draft') {
      const { notebook, error } = pick(args); if (error) return error;
      if (!['blank', 'selection'].includes(args.start)) return reject('restart_draft start must be blank or selection.');
      const had = notebook.submissions.length > 0;
      const cleared = replaceNotebook(resetNotebook(retract(notebook), args.start === 'selection' ? context.target : ''));
      return accept(`Draft ${cleared.id} restarted${args.start === 'selection' ? ' back to the selected text' : ''}.${had ? ' Its saved revisions were retracted.' : ''}\n\n${formatGuidance({ manager: 'Its paragraph ids changed.', next: `view Draft ${cleared.id}.` })}`);
    }
    if (name === 'save_draft') {
      const { notebook, error } = pick(args); if (error) return error;
      const blocked = problem(notebook);
      if (blocked) return reject(`Draft ${notebook.id} cannot be saved yet. ${blocked}`);
      const words = wordCount(notebookText(notebook));
      if (!notebook.shortWarned && !notebook.submissions.length && notebook.targetWords && words < notebook.targetWords * 0.6) {
        replaceNotebook({ ...notebook, shortWarned: true });
        return reject(`Draft ${notebook.id} is ${words} words against a target of about ${notebook.targetWords}. The author asked for more: keep expanding it, or save again to deliver it as it is.`);
      }
      const result = await submit(notebook, null);
      if (!result.revision) return result;
      const label = notebook.submissions.length ? `a continuation of revision #${notebook.submissions.at(-1)}` : 'a new alternative';
      return accept(`NOIRDRAFT SAVED\nDraft ${notebook.id} is recorded as revision #${result.revision.id}, ${label}. Saving is a checkpoint, not an ending: the draft stays open, and you can keep editing it and save again at any time.\n\n${pendingSummary()}`);
    }
    if (name === 'finish_changes') {
      if (!notebooks.length) return reject('There are no drafts to finish. If you are done, tell the author with send_chat_response_and_terminate.');
      if (closed) return reject('The changes are already finished. Tell the author what happened with send_chat_response_and_terminate.');
      const { delivered, blocked } = await settle();
      if (blocked.length && !finishWarned) {
        finishWarned = true;
        return accept(['NOIRDRAFT NOT READY TO FINISH', delivered.length ? `NoirDraft saved the ready draft${delivered.length === 1 ? '' : 's'}: ${delivered.join(', ')}.` : '', ...blocked.map(({ id, reason }) => `- Draft ${id}: ${reason}`), '', formatGuidance({ manager: 'Some drafts are not ready.', next: 'fix and save these, restart_draft to abandon one, or call finish_changes again to leave them out.' })].filter(Boolean).join('\n'));
      }
      closed = true;
      return accept(receiptText());
    }
    return reject(`Unknown NoirDraft tool "${name}".`);
  };

  report();
  for (let round = 0; round < roundLimit && !complete; round += 1) {
    if (!Array.isArray(calls) || !calls.length) throw new AgentError('The AI did not return a tool call.', { code: 'MISSING_REQUIRED_TOOL_CALL', rawText: raw });
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
  if (!complete) throw new AgentError('The AI did not finish the turn. Retry the turn.', { code: 'UNFINISHED_TURN', rawText: raw });
  const chat = finalChat();
  if (!chat) throw new AgentError('The AI finished without any reply for the author.', { code: 'EMPTY_RESPONSE', rawText: raw });
  const finalHeads = heads();
  return { revision: finalHeads[0] ?? null, revisions: finalHeads, generated: finalHeads[0] ? texts.get(finalHeads[0].id) : undefined, chat, changes: finalHeads.map((revision) => texts.get(revision.id)), snapshots, rawResponse: raw, prompt, unresolvedPins: composed.unresolvedPins, anchor: { root, baseRevisionId, range: [from, to], targetHash: await hashStory(context.target), before: context.before, after: context.after } };
}
