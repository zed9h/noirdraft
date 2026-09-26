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
 * Traces a selected STORY range through the whole revision graph, across every
 * branch: from the revision it was selected in, the range is mapped to each
 * parent and child in turn (primary-parent edges only, since those are the
 * diff bases). An edge whose single changed block overlaps the tracked range
 * marks its child revision as one that changed the passage; the tracked range
 * is then the whole corresponding block, so entries are hints, never exact
 * positions. A branch stops where the passage stops existing (inserted or
 * deleted), since nothing beyond that point is about this text. `roots` lists
 * the root revisions the passage traces back to, for a passage never changed. This never
 * invents stable paragraph identity; it only replays exact patches.
 * `rangeInResult` is expressed in the entry revision's own coordinates.
 */
export async function passageHistory(history, revisionId, range, options = {}) {
  const maxHops = options.maxHops ?? 500;
  const cache = new Map();
  const childrenByParent = new Map();
  for (const revision of history.revisions.values()) {
    const [primary] = revision.parents;
    if (primary === undefined) continue;
    if (!childrenByParent.has(primary)) childrenByParent.set(primary, []);
    childrenByParent.get(primary).push(revision.id);
  }
  const entries = new Map();
  const record = (revision, resultRange) => {
    if (entries.has(revision.id)) return;
    entries.set(revision.id, {
      revisionId: revision.id,
      origin: revision.origin,
      timestamp: revision.timestamp,
      note: revision.note,
      rangeInResult: resultRange,
      approximate: true,
    });
  };

  const tracked = new Map([[revisionId, [range[0], range[1]]]]);
  const queue = [revisionId];
  let stoppedReason = 'root';
  for (let hop = 0; queue.length > 0; hop += 1) {
    if (hop >= maxHops) { stoppedReason = 'max-hops'; break; }
    const id = queue.shift();
    const currentRange = tracked.get(id);
    const currentText = await reconstructRevision(history, id, cache);
    const neighbors = [];
    const parentId = history.revisions.get(id)?.parents[0];
    if (parentId !== undefined && history.revisions.has(parentId)) neighbors.push({ id: parentId, entryId: id });
    for (const childId of childrenByParent.get(id) ?? []) neighbors.push({ id: childId, entryId: childId });
    for (const neighbor of neighbors) {
      if (tracked.has(neighbor.id) && entries.has(neighbor.entryId)) continue;
      const neighborText = await reconstructRevision(history, neighbor.id, cache);
      const mapped = mapRange(currentText, neighborText, currentRange);
      const uncertain = mapped.status === 'uncertain';
      if (uncertain) {
        const owner = history.revisions.get(neighbor.entryId);
        record(owner, neighbor.entryId === id ? currentRange : mapped.range);
      }
      const gone = uncertain && mapped.range[0] === mapped.range[1];
      if (!tracked.has(neighbor.id) && !gone) {
        tracked.set(neighbor.id, mapped.range);
        queue.push(neighbor.id);
      }
    }
  }
  // Where nothing ever changed the passage, its origin is the root it traces to.
  const roots = [...tracked].filter(([id]) => history.revisions.get(id)?.parents.length === 0).map(([id, rangeInResult]) => {
    const revision = history.revisions.get(id);
    return { revisionId: id, origin: revision.origin, timestamp: revision.timestamp, note: revision.note, rangeInResult, approximate: false };
  });
  const ordered = [...entries.values()].sort((left, right) => right.revisionId - left.revisionId);
  return { entries: ordered, roots, approximate: ordered.length > 0, stoppedReason };
}
