/**
 * Pure left-to-right layout of the full revision graph. Time flows along x
 * (depth = longest parent chain, so every parent, primary or secondary, sits
 * left of its child). Rows come from a tidy tree over primary parents: leaves
 * take consecutive rows and every parent is centred over its children, which
 * keeps siblings balanced and primary edges from crossing. Secondary parents
 * only add edges. Iterative, so very long histories cannot overflow the stack.
 */
export function layoutRevisionGraph(history, { xStep = 96, yStep = 60 } = {}) {
  const ids = [...history.revisions.keys()].sort((left, right) => left - right);
  const depth = new Map();
  const children = new Map(ids.map((id) => [id, []]));
  const roots = [];
  for (const id of ids) {
    const { parents } = history.revisions.get(id);
    const known = parents.filter((parent) => history.revisions.has(parent));
    depth.set(id, known.length === 0 ? 0 : 1 + Math.max(...known.map((parent) => depth.get(parent) ?? 0)));
    if (known.length === 0) roots.push(id);
    else children.get(known[0]).push(id);
  }

  const row = new Map();
  let nextRow = 0;
  for (const root of roots) {
    const stack = [{ id: root, next: 0 }];
    while (stack.length > 0) {
      const frame = stack.at(-1);
      const kids = children.get(frame.id);
      if (frame.next < kids.length) {
        stack.push({ id: kids[frame.next], next: 0 });
        frame.next += 1;
        continue;
      }
      stack.pop();
      row.set(frame.id, kids.length === 0 ? nextRow++ : (row.get(kids[0]) + row.get(kids.at(-1))) / 2);
    }
  }

  const positions = new Map(ids.map((id) => [id, { x: depth.get(id) * xStep, y: row.get(id) * yStep }]));
  const edges = [];
  for (const id of ids) {
    history.revisions.get(id).parents.forEach((parent, index) => {
      if (positions.has(parent)) edges.push({ from: parent, to: id, secondary: index > 0 });
    });
  }
  const xs = [...positions.values()].map(({ x }) => x);
  const ys = [...positions.values()].map(({ y }) => y);
  const bounds = ids.length === 0
    ? { minX: 0, minY: 0, maxX: 0, maxY: 0 }
    : { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  return { ids, positions, edges, bounds };
}

/** Horizontal-tangent cubic Bézier between two node centres. */
export function edgePath(from, to) {
  const middle = (from.x + to.x) / 2;
  return `M${from.x} ${from.y}C${middle} ${from.y} ${middle} ${to.y} ${to.x} ${to.y}`;
}

/**
 * Secondary-parent edge: leaves the supplier at 45 degrees, forward and up or
 * down toward the receiver's row, and reaches the receiver from behind at the
 * same slope (from above when the supplier is above, from below when it is
 * below). It never shares a path with the solid edges, and its direction shows
 * who supplied the change and who received it.
 */
export function secondaryEdgePath(from, to, radius = 16) {
  const slope = to.y < from.y ? -1 : 1;
  const k = radius * Math.SQRT1_2;
  const start = { x: from.x + k, y: from.y + slope * k };
  const end = { x: to.x - k, y: to.y - slope * k };
  const reach = Math.max(20, Math.hypot(end.x - start.x, end.y - start.y) * 0.35);
  const r = (n) => Math.round(n * 100) / 100;
  return `M${r(start.x)} ${r(start.y)}C${r(start.x + reach)} ${r(start.y + slope * reach)} ${r(end.x - reach)} ${r(end.y - slope * reach)} ${r(end.x)} ${r(end.y)}`;
}
