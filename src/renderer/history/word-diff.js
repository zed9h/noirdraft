/**
 * Prose-oriented word/whitespace diff for comparing two passages side by
 * side. This is deliberately separate from the whole-STORY unified-diff
 * patches in diff.js: those are the canonical stored history, while this is
 * only a presentation aid for the comparison workbench and is never stored.
 */

const WORD_OR_SPACE = /\s+|[^\s]+/g;

function tokenize(text, pattern = WORD_OR_SPACE) {
  return text.match(pattern) ?? [];
}

/**
 * Returns a sequence of { type: 'equal' | 'delete' | 'insert', text }
 * tokens describing how to turn `before` into `after`, diffing at word
 * granularity via a longest-common-subsequence over tokens. `pattern`
 * (global) changes what a token is; the default keeps punctuation attached.
 */
export function wordDiff(before, after, pattern = WORD_OR_SPACE) {
  const a = tokenize(String(before), pattern);
  const b = tokenize(String(after), pattern);
  const lengths = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lengths[i][j] = a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ type: 'equal', text: a[i] });
      i += 1;
      j += 1;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      ops.push({ type: 'delete', text: a[i] });
      i += 1;
    } else {
      ops.push({ type: 'insert', text: b[j] });
      j += 1;
    }
  }
  while (i < a.length) { ops.push({ type: 'delete', text: a[i] }); i += 1; }
  while (j < b.length) { ops.push({ type: 'insert', text: b[j] }); j += 1; }

  const merged = [];
  for (const op of ops) {
    const last = merged.at(-1);
    if (last && last.type === op.type) last.text += op.text;
    else merged.push({ ...op });
  }
  return merged;
}

/**
 * The passages `after` added relative to `before`, in order. Only the span
 * between the shared prefix and suffix is diffed, so a small edit in a long
 * text stays cheap; inserted runs separated only by shared whitespace are one
 * passage. Pure deletions yield an empty list.
 */
export function insertedPassages(before, after) {
  const a = String(before);
  const b = String(after);
  const limit = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < limit && a[prefix] === b[prefix]) prefix += 1;
  while (prefix > 0 && !/\s/.test(a[prefix - 1])) prefix -= 1;
  let suffix = 0;
  while (suffix < limit - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;
  while (suffix > 0 && !/\s/.test(b[b.length - suffix])) suffix -= 1;
  const middleBefore = a.slice(prefix, a.length - suffix);
  const middleAfter = b.slice(prefix, b.length - suffix);
  if (middleAfter.trim() === '') return [];
  if (tokenize(middleBefore).length * tokenize(middleAfter).length > 4_000_000) return [middleAfter.trim()];
  const passages = [];
  let open = null;
  let gap = '';
  for (const op of wordDiff(middleBefore, middleAfter)) {
    if (op.type === 'insert') {
      open = open === null ? op.text : `${open}${gap}${op.text}`;
      gap = '';
    } else if (op.type === 'equal' && open !== null && op.text.trim() === '') {
      gap += op.text;
    } else if (op.type === 'equal') {
      if (open !== null) passages.push(open.trim());
      open = null;
      gap = '';
    }
  }
  if (open !== null) passages.push(open.trim());
  return passages.filter((passage) => passage !== '');
}
