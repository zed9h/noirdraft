// Per-section caret/scroll memory and a browser-tab-style back/forward stack
// over recently visited manuscript sections (Alt+Arrow). This never touches
// revision history — it is pure editor navigation state, scoped to the
// current session only.

export function createSectionNav() {
  return { stack: [], cursor: -1, positions: new Map() };
}

export function savePosition(nav, headingPath, position) {
  if (!headingPath) return;
  nav.positions.set(headingPath, position);
}

export function recallPosition(nav, headingPath) {
  return nav.positions.get(headingPath) ?? null;
}

// Pushes headingPath as the most recently visited section, truncating any
// forward entries — the same "new navigation discards the redo branch"
// convention a browser's own back/forward list uses.
export function visitSection(nav, headingPath) {
  if (!headingPath) return;
  if (nav.stack[nav.cursor] === headingPath) return;
  nav.stack = nav.stack.slice(0, nav.cursor + 1);
  nav.stack.push(headingPath);
  nav.cursor = nav.stack.length - 1;
}

export function stepSectionNav(nav, direction) {
  const next = nav.cursor + direction;
  if (next < 0 || next >= nav.stack.length) return null;
  nav.cursor = next;
  return nav.stack[next];
}
