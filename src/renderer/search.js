// Pure search helpers: text matches for the editor, and revision matches for
// the version graph. Offsets are UTF-16, matching StoryModel.

/** Case-insensitive, non-overlapping matches of `query` in `text`. */
export function findTextMatches(text, query) {
  const needle = String(query).toLowerCase();
  if (needle === '') return [];
  const haystack = text.toLowerCase();
  // toLowerCase can change length for a few characters; offsets would then
  // drift from the source text, so fall back to a literal search there.
  const source = haystack.length === text.length ? haystack : text;
  const target = haystack.length === text.length ? needle : String(query);
  const matches = [];
  let index = source.indexOf(target);
  while (index !== -1) {
    matches.push({ from: index, to: index + target.length });
    index = source.indexOf(target, index + target.length);
  }
  return matches;
}

/** A one-line excerpt around a match, with the match's position inside it. */
export function excerptAround(text, match, radius = 32) {
  const start = Math.max(0, match.from - radius);
  const end = Math.min(text.length, match.to + radius);
  const flatten = (value) => value.replace(/\s+/g, ' ');
  const before = flatten(text.slice(start, match.from));
  const hit = flatten(text.slice(match.from, match.to));
  const after = flatten(text.slice(match.to, end));
  return { before: `${start > 0 ? '…' : ''}${before}`, hit, after: `${after}${end < text.length ? '…' : ''}` };
}

/**
 * Revisions whose note or change set (payload) contain the query, oldest
 * first. `where` says which field matched so the UI can point at it.
 */
export function searchHistory(history, query) {
  const needle = String(query).trim().toLowerCase();
  if (needle === '') return [];
  const results = [];
  for (const revision of history.revisions.values()) {
    const note = revision.note ?? '';
    let where = null;
    if (note.toLowerCase().includes(needle)) where = 'note';
    else if (String(revision.payload ?? '').toLowerCase().includes(needle)) where = 'change';
    if (where) results.push({ revision, where });
  }
  return results.sort((left, right) => left.revision.id - right.revision.id);
}

/** The blank-line-delimited paragraph around `offset`, as a from/to range. */
export function paragraphRange(text, offset) {
  const before = text.lastIndexOf('\n\n', Math.max(0, offset - 1));
  const after = text.indexOf('\n\n', offset);
  return { from: before === -1 ? 0 : before + 2, to: after === -1 ? text.length : after };
}
