/**
 * Adopts a phrase/hunk/paragraph from a compared revision into a composite
 * draft, tracking lightweight provenance (PLAN.md §36.1): which source
 * revision and range supplied the resulting span. Provenance is metadata
 * about text origin only — it is deliberately unrelated to graph ancestry
 * (§27, §36.1): adopting from several revisions must never turn into
 * several parents. Earlier provenance entries are shifted or dropped exactly
 * like offset mapping elsewhere in the app: entries entirely before the edit
 * are untouched, entries entirely after are shifted by the length delta, and
 * entries overlapping the edited span are superseded by the new entry.
 */
export function adoptIntoComposite(compositeText, provenance, { from, to, replacement, sourceRevisionId, sourceRange }) {
  const delta = replacement.length - (to - from);
  const carried = provenance
    .map((entry) => {
      if (entry.resultRange[1] <= from) return entry;
      if (entry.resultRange[0] >= to) return { ...entry, resultRange: [entry.resultRange[0] + delta, entry.resultRange[1] + delta] };
      return null;
    })
    .filter((entry) => entry !== null);

  const resultRange = [from, from + replacement.length];
  const text = `${compositeText.slice(0, from)}${replacement}${compositeText.slice(to)}`;
  return {
    text,
    provenance: [...carried, { sourceRevisionId, sourceRange, resultRange }],
  };
}
