import { childrenOf } from './graph.js';

function neighborIds(history, id, direction) {
  if (direction === 'ancestor') return history.revisions.get(id)?.parents ?? [];
  return childrenOf(history, id).map((revision) => revision.id);
}

function reachableHiddenCount(history, startId, included, direction) {
  const visited = new Set();
  const queue = [startId];
  while (queue.length > 0) {
    const id = queue.shift();
    if (visited.has(id) || included.has(id)) continue;
    visited.add(id);
    for (const neighborId of neighborIds(history, id, direction)) queue.push(neighborId);
  }
  return visited.size;
}

/**
 * Builds a current-node-centered bounded neighborhood of the revision graph
 * (PLAN.md §55): only immediate parents/children/siblings/branches within
 * `radius` hops of `centerId`, plus a jump edge for every direction that
 * leads to nodes outside that neighborhood, labelled with how many revisions
 * it hides. This never materializes a separate graph store — it is a pure
 * projection over `history.revisions`, recomputed on demand.
 */
export function buildLocalGraph(history, centerId, { radius = 2 } = {}) {
  const distances = new Map([[centerId, 0]]);
  const queue = [centerId];
  while (queue.length > 0) {
    const id = queue.shift();
    const distance = distances.get(id);
    if (distance >= radius) continue;
    const neighbors = [...neighborIds(history, id, 'ancestor'), ...neighborIds(history, id, 'descendant')];
    for (const neighborId of neighbors) {
      if (!distances.has(neighborId)) {
        distances.set(neighborId, distance + 1);
        queue.push(neighborId);
      }
    }
  }

  const included = distances;
  const nodes = [...included.keys()]
    .map((id) => history.revisions.get(id))
    .filter(Boolean)
    .map((revision) => ({
      id: revision.id,
      origin: revision.origin,
      timestamp: revision.timestamp,
      note: revision.note,
      parents: revision.parents,
      isCurrent: revision.id === history.currentRevision,
      distance: included.get(revision.id),
    }));

  const jumps = [];
  for (const id of included.keys()) {
    for (const direction of ['ancestor', 'descendant']) {
      for (const neighborId of neighborIds(history, id, direction)) {
        if (included.has(neighborId)) continue;
        jumps.push({
          from: id,
          direction,
          towardId: neighborId,
          hiddenCount: reachableHiddenCount(history, neighborId, included, direction),
        });
      }
    }
  }

  return { centerId, radius, nodes, jumps };
}

/**
 * Searches the full revision graph by ID, note, origin, or timestamp. This
 * is deliberately separate from the bounded local graph, since search can
 * legitimately reach revisions far outside the current neighborhood.
 */
export function searchRevisions(history, query) {
  const needle = String(query).trim().toLowerCase();
  if (needle === '') return [];
  return [...history.revisions.values()]
    .filter((revision) => (
      String(revision.id).includes(needle)
      || revision.origin.toLowerCase().includes(needle)
      || (revision.note ?? '').toLowerCase().includes(needle)
      || revision.timestamp.toLowerCase().includes(needle)
    ))
    .sort((left, right) => left.id - right.id);
}
