import { wordDiff } from './word-diff.js';

// Bounds cost for the scrub overlay: only word-diff the span that actually
// differs between the scrub's origin revision and the currently-previewed
// revision, showing the matching prefix/suffix verbatim. Mirrors
// insertedPassages' prefix/suffix trim so a small edit inside a long
// manuscript stays cheap regardless of the document's overall length.
const DIFF_CHAR_BUDGET = 20_000_000;

/**
 * Returns a sequence of { type: 'equal' | 'insert' | 'delete', text } tokens
 * comparing `before` (the revision scrubbing started from) against `after`
 * (the revision currently previewed), for a read-only whole-document diff
 * overlay shown while a Ctrl+Alt/Shift+Alt scrub is held.
 */
export function scrubDocumentDiff(before, after) {
  const a = String(before);
  const b = String(after);
  if (a === b) return a ? [{ type: 'equal', text: a }] : [];
  const limit = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < limit && a[prefix] === b[prefix]) prefix += 1;
  while (prefix > 0 && !/\s/.test(a[prefix - 1])) prefix -= 1;
  let suffix = 0;
  while (suffix < limit - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;
  while (suffix > 0 && !/\s/.test(b[b.length - suffix])) suffix -= 1;
  const middleBefore = a.slice(prefix, a.length - suffix);
  const middleAfter = b.slice(prefix, b.length - suffix);

  const ops = [];
  if (prefix > 0) ops.push({ type: 'equal', text: a.slice(0, prefix) });
  if (middleBefore.length * middleAfter.length > DIFF_CHAR_BUDGET) {
    if (middleBefore) ops.push({ type: 'delete', text: middleBefore });
    if (middleAfter) ops.push({ type: 'insert', text: middleAfter });
  } else {
    for (const op of wordDiff(middleBefore, middleAfter)) if (op.text) ops.push(op);
  }
  if (suffix > 0) ops.push({ type: 'equal', text: b.slice(b.length - suffix) });
  return ops;
}
