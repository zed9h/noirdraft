// Generic hold/step/release state machine shared by the structural
// (Ctrl+Alt+Arrow) and visit-time (Shift+Alt+Arrow) scrub navigators. Pure
// and DOM-free: it only tracks which revision id is currently focused during
// a hold, never touching the graph, the model, or `history.currentRevision`
// itself — the caller commits with a real checkout once the hold ends.
//
// A provider supplies the candidate ids for a given axis (graph structure or
// visit-time order) via `step(providerState, currentId, key)`, returning
// `{ id, providerState } | null` (null means "no candidate in that
// direction", e.g. already at a boundary).

export function startScrub({ originId, providerState }) {
  return { originId, currentId: originId, providerState, active: true };
}

export function stepScrub(session, provider, key) {
  const result = provider.step(session.providerState, session.currentId, key);
  if (!result || result.id == null) return session;
  return { ...session, currentId: result.id, providerState: result.providerState };
}

export function endScrub(session) {
  return { originId: session.originId, finalId: session.currentId };
}
