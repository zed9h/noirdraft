// Pure notebook model for the agent drafting protocol (PLAN.md Phase 16).
// A notebook is a working draft made of numbered paragraphs. Ids are monotonic
// and never reused; only paragraphs carry ids, blank lines are separators.

export const MAX_OPERATIONS = 12;
export const OPERATIONS = ['replace', 'delete', 'insert_before', 'insert_after'];
const WORDS_PER_PARAGRAPH = 100;

export function splitParagraphs(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').split(/\n[ \t]*\n(?:[ \t]*\n)*/).map((block) => block.replace(/^\n+|\n+$/g, '')).filter((block) => block.trim());
}
export function wordCount(text) { return String(text ?? '').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0; }
export function isPlaceholder(paragraph) { const value = String(paragraph).trim(); return value.length >= 2 && value.startsWith('[') && value.endsWith(']'); }

export function budgetFor(targetWords) {
  const paragraphs = Math.max(1, Math.ceil((Number(targetWords) || 0) / WORDS_PER_PARAGRAPH));
  const soft = Math.ceil(2 + 1.5 * paragraphs ** 1.2);
  return { paragraphs, soft, hard: Math.ceil(soft * 2.5) + 4 };
}

export function createNotebook({ id, intent, targetWords, seed = '' }) {
  const blocks = splitParagraphs(seed);
  const paragraphs = (blocks.length ? blocks : ['']).map((text, index) => ({ id: index + 1, text }));
  const notebook = { id, intent, targetWords, budget: budgetFor(targetWords), paragraphs, nextId: paragraphs.length + 1, reviewedFrom: paragraphs.length + 1, reviews: 0, needsReview: false, nextIntent: null, submissions: [], submittedText: null, journal: [] };
  notebook.baseline = notebookText(notebook);
  return notebook;
}

export function resetNotebook(notebook, seed = '') {
  const blocks = splitParagraphs(seed);
  let nextId = notebook.nextId;
  const paragraphs = (blocks.length ? blocks : ['']).map((text) => ({ id: nextId++, text }));
  const reset = { ...notebook, paragraphs, nextId, reviewedFrom: nextId, needsReview: false, nextIntent: null, lastReviewClean: undefined, submissions: [], submittedText: null, summary: null };
  return { ...reset, baseline: notebookText(reset) };
}

export function notebookText(notebook) { return notebook.paragraphs.map(({ text }) => text).filter((text) => text.trim()).join('\n\n'); }
export function isEmptyNotebook(notebook) { return !notebookText(notebook).trim(); }
export function placeholderIds(notebook) { return notebook.paragraphs.filter(({ text }) => isPlaceholder(text)).map(({ id }) => id); }
export function touchedIds(notebook) { return notebook.paragraphs.filter(({ id, text }) => id >= notebook.reviewedFrom && text.trim()).map(({ id }) => id); }
export function markReviewed(notebook, nextIntent) { return { ...notebook, reviewedFrom: notebook.nextId, reviews: notebook.reviews + 1, needsReview: false, nextIntent: nextIntent?.trim() || null }; }

const idList = (ids) => ids.map((id) => `¶${id}`).join(', ');

/**
 * Applies a batch of range operations against the paragraph ids the model last
 * saw. The batch is atomic: any error rejects everything, and every error is
 * listed with a constructive next step. Replaced and inserted text always gets
 * fresh ids, so an id identifies one version of one paragraph.
 */
export function applyOperations(notebook, operations) {
  const errors = [];
  if (!Array.isArray(operations) || !operations.length) return { ok: false, errors: ['edit_notebook needs at least one operation. Pick a paragraph to replace, delete, or add text next to.'] };
  if (operations.length > MAX_OPERATIONS) return { ok: false, errors: [`A batch may hold at most ${MAX_OPERATIONS} operations; you sent ${operations.length}. Make smaller edits this round, use whole-paragraph [placeholder notes] for the parts you are deferring, and continue next round.`] };
  const order = new Map(notebook.paragraphs.map(({ id }, index) => [id, index]));
  const claimed = new Map();
  const plans = [];
  for (const [index, operation] of operations.entries()) {
    const label = `Operation ${index + 1}`;
    const { op } = operation ?? {};
    if (!OPERATIONS.includes(op)) { errors.push(`${label}: op must be one of ${OPERATIONS.join(', ')}.`); continue; }
    const from = order.get(operation.paragraph_id);
    if (from === undefined) { errors.push(`${label}: paragraph ${operation.paragraph_id} is not in this notebook. Use an id from the latest review; text outside the notebook is read-only context.`); continue; }
    const ranged = op === 'replace' || op === 'delete';
    const through = ranged && operation.through_paragraph_id != null ? order.get(operation.through_paragraph_id) : from;
    if (through === undefined || through < from) { errors.push(`${label}: through_paragraph_id must be a later paragraph of this notebook, or omitted.`); continue; }
    if (!ranged && operation.through_paragraph_id != null) { errors.push(`${label}: ${op} takes a single paragraph_id.`); continue; }
    let blocks = [];
    if (op !== 'delete') {
      blocks = splitParagraphs(operation.text);
      if (!blocks.length) { errors.push(`${label}: ${op} needs text. To remove a paragraph, use delete.`); continue; }
    } else if (operation.text != null) { errors.push(`${label}: delete takes no text.`); continue; }
    if (ranged) {
      const overlap = Array.from({ length: through - from + 1 }, (_, offset) => from + offset).find((position) => claimed.has(position));
      if (overlap !== undefined) { errors.push(`${label}: ¶${notebook.paragraphs[overlap].id} is already changed by another operation in this batch. Combine them into one operation.`); continue; }
      for (let position = from; position <= through; position += 1) claimed.set(position, true);
    }
    plans.push({ op, from, through, blocks });
  }
  for (const plan of plans) {
    if (!plan.op.startsWith('insert') || !claimed.has(plan.from)) continue;
    errors.push(`${plan.op} on ¶${notebook.paragraphs[plan.from].id}, which another operation in this batch replaces or deletes. Anchor on a neighbouring paragraph instead.`);
  }
  if (errors.length) return { ok: false, errors: [...errors, 'Nothing was applied. Fix the listed operations, or make smaller edits this round and use more [placeholder notes].'] };

  let nextId = notebook.nextId;
  const fresh = (blocks) => blocks.map((text) => ({ id: nextId++, text }));
  const before = new Map(); const after = new Map(); const replaced = new Map(); const removed = new Set();
  for (const { op, from, through, blocks } of plans) {
    if (op === 'insert_before') before.set(from, [...(before.get(from) ?? []), ...fresh(blocks)]);
    else if (op === 'insert_after') after.set(from, [...(after.get(from) ?? []), ...fresh(blocks)]);
    else { for (let position = from; position <= through; position += 1) removed.add(position); if (op === 'replace') replaced.set(from, fresh(blocks)); }
  }
  const paragraphs = [];
  notebook.paragraphs.forEach((paragraph, position) => {
    paragraphs.push(...(before.get(position) ?? []));
    if (replaced.has(position)) paragraphs.push(...replaced.get(position));
    else if (!removed.has(position)) paragraphs.push(paragraph);
    paragraphs.push(...(after.get(position) ?? []));
  });
  const kept = paragraphs.filter(({ text }) => text.trim());
  const finalParagraphs = kept.length ? kept : [{ id: nextId++, text: '' }];
  return { ok: true, notebook: { ...notebook, paragraphs: finalParagraphs, nextId, needsReview: true } };
}

export function lengthCheck(notebook) {
  const words = wordCount(notebookText(notebook));
  const target = notebook.targetWords;
  if (!target) return `Length: ${words} words.`;
  const ratio = words / target;
  const verdict = ratio < 0.5 ? ' Well under target: the author wants substantially more. Expand generously: write out the placeholders and give thin paragraphs their full weight.'
    : ratio < 0.9 ? ` Still short of the target: keep writing until it reaches about ${target} words; do not stop early.`
    : ratio > 1.5 ? ' Well over target: trim or delete paragraphs.' : '';
  return `Length: ${words} words against a target of about ${target} (${Math.round(ratio * 100)}%).${verdict}`;
}

export function budgetStatus(notebook) {
  const { soft, hard } = notebook.budget;
  const round = notebook.reviews;
  const short = notebook.targetWords && wordCount(notebookText(notebook)) < notebook.targetWords * 0.8 ? ' The text is still short of its length, so keep writing rather than polishing.' : '';
  if (round >= hard) return `Deadline passed (${round} reviews). NoirDraft will wrap this turn up now.`;
  if (round >= Math.ceil((soft + hard) / 2)) return `Well past the deadline (${round} reviews; target was about ${soft}). Fix only what is listed as failing, then save_notebook or drop this notebook. NoirDraft ends the turn at ${hard} reviews.${short}`;
  if (round >= soft) return `Past the review target (${round} of about ${soft}). Address the outstanding findings and save soon; the manager is waiting for delivery.${short}`;
  if (round >= Math.floor(soft * 0.75)) return `Review ${round} of about ${soft}: approaching the review target. Aim to converge.${short}`;
  return `Review ${round} of about ${soft}.`;
}

export function renderParagraphs(notebook) {
  return notebook.paragraphs.map(({ id, text }) => `[¶${id}]${isPlaceholder(text) ? ' (placeholder)' : ''}\n${text}`).join('\n\n');
}

export function stateOf(notebook) {
  if (notebook.submissions.length) return notebookText(notebook) === notebook.submittedText ? `saved (revision #${notebook.submissions.at(-1)})` : `saved (revision #${notebook.submissions.at(-1)}), edited since`;
  return isEmptyNotebook(notebook) ? 'empty' : 'open';
}

/** Review form shown to the model after opening and after every edit. */
export function renderReview({ grandIntent, notebooks, activeId, before = '', after = '', lastEdit = null }) {
  const active = notebooks.find(({ id }) => id === activeId);
  const lines = ['NOIRDRAFT NOTEBOOK REVIEW', `Overall intent: ${grandIntent}`, `Notebook ${active.id} of ${notebooks.length} — ${active.intent}`];
  if (active.nextIntent) lines.push(`Your plan from the last review: ${active.nextIntent}`);
  if (lastEdit) lines.push(lastEdit);
  lines.push('Only notebook paragraphs are editable. The surrounding context is read-only; judge the notebook by how it joins it.', '----- CONTEXT BEFORE (read-only) -----', before, '----- NOTEBOOK (editable) -----', renderParagraphs(active), '----- CONTEXT AFTER (read-only) -----', after, '----- END -----');
  const placeholders = placeholderIds(active); const touched = touchedIds(active);
  lines.push('Checks:', `- ${lengthCheck(active)}`, placeholders.length ? `- Placeholders still to write: ${idList(placeholders)}. save_notebook is rejected until they are replaced or deleted.` : '- No placeholders remain.', touched.length ? `- Changed since your last review: ${idList(touched)}. Reread these in context.` : '- Nothing changed since your last review.', `- ${budgetStatus(active)}`);
  lines.push(active.needsReview ? 'Next: call review_notebook with your editorial findings and next_intent.' : 'Next: edit_notebook to act on your plan, or save_notebook if this notebook is ready, or open another notebook for comparison.');
  return lines.join('\n');
}
