// A chronological log of checked-out revision ids, independent of the
// revision graph's parent/child structure (PLAN.md's back/forward timeline).
// Pure and immutable: every function returns a new log rather than mutating
// its argument.

export function createVisitLog(initialId = null) {
  const entries = initialId == null ? [] : [initialId];
  return { entries, cursor: entries.length - 1 };
}

// Appends revisionId as the most recent visit, unless it repeats the
// immediately preceding entry. Re-visiting an older entry (e.g. after
// stepping back) records a fresh entry at the end, matching "store a time we
// visited each" rather than deduplicating across the whole log.
export function recordVisit(log, revisionId) {
  if (revisionId == null) return log;
  if (log.entries.at(-1) === revisionId) return { entries: log.entries, cursor: log.entries.length - 1 };
  const entries = [...log.entries, revisionId];
  return { entries, cursor: entries.length - 1 };
}

export function stepVisitLog(log, direction) {
  const next = log.cursor + direction;
  if (next < 0 || next >= log.entries.length) return { log, id: null };
  const nextLog = { entries: log.entries, cursor: next };
  return { log: nextLog, id: nextLog.entries[next] };
}

export function jumpVisitLog(log, edge) {
  if (log.entries.length === 0) return { log, id: null };
  const cursor = edge === 'first' ? 0 : log.entries.length - 1;
  const nextLog = { entries: log.entries, cursor };
  return { log: nextLog, id: nextLog.entries[cursor] };
}
