/**
 * Tracks text copied out of pinned revisions so the next recorded revision can
 * list those revisions as secondary parents. A copy only counts if some of it
 * actually landed in what the commit changed: text pasted and then deleted
 * again (scratchpad use) leaves no link. This is a text-presence heuristic on
 * the commit's before/after, not per-character provenance.
 */

const SHINGLE_WORDS = 4;
const MAX_PENDING_COPIES = 20;

const words = (text) => String(text).split(/\s+/).filter(Boolean);

function occurrences(haystack, needle) {
  let count = 0;
  for (let from = haystack.indexOf(needle); from !== -1; from = haystack.indexOf(needle, from + needle.length)) count += 1;
  return count;
}

// Whole snippet, or — so light edits of a pasted passage still count — any
// run of a few consecutive words from it.
function probes(snippetWords) {
  if (snippetWords.length <= SHINGLE_WORDS) return [snippetWords.join(' ')];
  const runs = [];
  for (let index = 0; index + SHINGLE_WORDS <= snippetWords.length; index += 1) {
    runs.push(snippetWords.slice(index, index + SHINGLE_WORDS).join(' '));
  }
  return runs;
}

export function addPendingCopy(copies, { sourceRevisionId, text }) {
  if (words(text).length === 0) return copies;
  return [...copies, { sourceRevisionId, text }].slice(-MAX_PENDING_COPIES);
}

/**
 * Splits pending copies into those whose text was added by this commit
 * (`used`, deduplicated source ids in copy order) and the rest (`remaining`,
 * kept for a later commit, since a copy may simply not be pasted yet).
 */
export function resolvePendingCopies(copies, baseText, resultText) {
  const base = words(baseText).join(' ');
  const result = words(resultText).join(' ');
  const used = [];
  const remaining = [];
  for (const copy of copies) {
    const landed = probes(words(copy.text)).some((probe) => occurrences(result, probe) > occurrences(base, probe));
    if (landed) { if (!used.includes(copy.sourceRevisionId)) used.push(copy.sourceRevisionId); } else remaining.push(copy);
  }
  return { used, remaining };
}
