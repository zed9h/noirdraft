import { reconstructRevision } from './graph.js';

function sourceLines(text) {
  const lines = [];
  let from = 0;
  while (from < text.length) {
    const newline = text.indexOf('\n', from);
    const to = newline === -1 ? text.length : newline + 1;
    lines.push(text.slice(from, to));
    from = to;
  }
  return lines;
}

/**
 * Maps a character range in `fromText` into the coordinate space of `toText`.
 * Uses the same common-prefix/common-suffix line trimming as the unified-diff
 * writer, so a range entirely inside the untouched prefix or suffix maps
 * exactly; a range overlapping the single changed block is reported as
 * `uncertain` with the whole corresponding block in `toText` as a hint, never
 * as a false exact position.
 */
export function mapRange(fromText, toText, range) {
  const [from, to] = range;
  if (fromText === toText) return { status: 'unchanged', range: [from, to] };
  const fromLines = sourceLines(fromText);
  const toLines = sourceLines(toText);
  let prefix = 0;
  const maxPrefix = Math.min(fromLines.length, toLines.length);
  while (prefix < maxPrefix && fromLines[prefix] === toLines[prefix]) prefix += 1;
  let suffix = 0;
  const maxSuffix = Math.min(fromLines.length - prefix, toLines.length - prefix);
  while (
    suffix < maxSuffix
    && fromLines[fromLines.length - 1 - suffix] === toLines[toLines.length - 1 - suffix]
  ) suffix += 1;

  const prefixCharLength = fromLines.slice(0, prefix).join('').length;
  const fromSuffixCharLength = fromLines.slice(fromLines.length - suffix).join('').length;
  const toSuffixCharLength = toLines.slice(toLines.length - suffix).join('').length;
  const fromChangedFrom = prefixCharLength;
  const fromChangedTo = fromText.length - fromSuffixCharLength;
  const toChangedFrom = prefixCharLength;
  const toChangedTo = toText.length - toSuffixCharLength;

  if (to <= fromChangedFrom) return { status: 'unchanged', range: [from, to] };
  if (from >= fromChangedTo) {
    const delta = toText.length - fromText.length;
    return { status: delta === 0 ? 'unchanged' : 'shifted', range: [from + delta, to + delta] };
  }
  return { status: 'uncertain', range: [toChangedFrom, toChangedTo] };
}

/**
 * Walks a selected STORY range backward through ancestor revisions, mapping
 * it through each parent transition. Only hops whose single changed block
 * overlaps the (possibly widened) tracked range are reported, since those are
 * the revisions that plausibly touched the passage. Once a hop is uncertain,
 * every later entry is also flagged `approximate` because the tracked range
 * it is compared against is itself a hint rather than an exact position.
 * This never invents stable paragraph identity; it only replays exact patches.
 */
export async function passageHistory(history, revisionId, range, options = {}) {
  const maxHops = options.maxHops ?? 500;
  const cache = new Map();
  const entries = [];
  let currentId = revisionId;
  let currentRange = [range[0], range[1]];
  let currentText = await reconstructRevision(history, currentId, cache);
  let approximate = false;
  let stoppedReason = 'max-hops';
  for (let hop = 0; hop < maxHops; hop += 1) {
    const revision = history.revisions.get(currentId);
    if (!revision || revision.parents.length === 0) { stoppedReason = 'root'; break; }
    if (revision.parents.length > 1) { stoppedReason = 'merge'; break; }
    const parentId = revision.parents[0];
    const parentText = await reconstructRevision(history, parentId, cache);
    const mapped = mapRange(currentText, parentText, currentRange);
    if (mapped.status === 'uncertain') {
      approximate = true;
      entries.push({
        revisionId: currentId,
        origin: revision.origin,
        timestamp: revision.timestamp,
        note: revision.note,
        rangeInResult: currentRange,
        rangeInParent: mapped.range,
        approximate,
      });
    }
    currentId = parentId;
    currentRange = mapped.range;
    currentText = parentText;
  }
  return { entries, approximate, stoppedReason };
}
