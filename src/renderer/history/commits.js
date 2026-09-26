import { childrenOf, commitRevision, reconstructRevision } from './graph.js';
import { normalizeVisibleRootText } from '../project/projection.js';

const ignoredOrigins = new Set(['open', 'checkout', 'agent', 'history', 'normalize', 'scrub-preview']);

export class CommitController {
  #idleHandle = null;
  #unsubscribe;

  constructor({
    history,
    model,
    idleDelay = 45_000,
    structuralThreshold = 1_000,
    timers = globalThis,
    onError = () => {},
    onChange = () => {},
    onCommit = () => {},
    beforeCommit = () => {},
    secondaryParents = () => [],
  }) {
    this.history = history;
    this.model = model;
    this.idleDelay = idleDelay;
    this.structuralThreshold = structuralThreshold;
    this.timers = timers;
    this.onError = onError;
    this.onChange = onChange;
    this.onCommit = onCommit;
    this.beforeCommit = beforeCommit;
    this.secondaryParents = secondaryParents;
    this.pending = false;
    this.pendingBase = null;
    this.commitInFlight = Promise.resolve(null);
    this.#unsubscribe = model.subscribe((snapshot, change) => this.#modelChanged(snapshot, change));
  }

  destroy() {
    this.#cancelIdle();
    this.#unsubscribe?.();
  }

  #modelChanged(snapshot, change) {
    if (change.type !== 'replace' || ignoredOrigins.has(change.origin)) return;
    if (!this.pending) {
      this.pending = true;
      this.pendingBase = change.previousText;
    }
    this.#scheduleIdle();
    this.onChange(this.history);
    if (Math.max(change.removed.length, change.inserted.length) >= this.structuralThreshold) {
      void this.commitPending({ note: 'Large structural edit.' }).catch(this.onError);
    }
  }

  #scheduleIdle() {
    this.#cancelIdle();
    this.#idleHandle = this.timers.setTimeout(() => {
      this.#idleHandle = null;
      return this.commitPending().catch(this.onError);
    }, this.idleDelay);
  }

  #cancelIdle() {
    if (this.#idleHandle !== null) this.timers.clearTimeout(this.#idleHandle);
    this.#idleHandle = null;
  }

  // Brings the model to its canonical text with the smallest edit, so a
  // selection or caret elsewhere in the text is kept (only offsets inside the
  // changed span are clamped, and later ones shift by the length change).
  #applyNormalized(result) {
    const text = this.model.text;
    if (result === text) return;
    const limit = Math.min(text.length, result.length);
    let prefix = 0;
    while (prefix < limit && text[prefix] === result[prefix]) prefix += 1;
    let suffix = 0;
    while (suffix < limit - prefix && text[text.length - 1 - suffix] === result[result.length - 1 - suffix]) suffix += 1;
    const oldEnd = text.length - suffix;
    const inserted = result.slice(prefix, result.length - suffix);
    const delta = result.length - text.length;
    const map = (offset) => (offset <= prefix ? offset : offset >= oldEnd ? offset + delta : Math.min(prefix + inserted.length, offset));
    this.model.replace(prefix, oldEnd, inserted, { origin: 'normalize', selectionStart: map(this.model.selectionStart), selectionEnd: map(this.model.selectionEnd) });
  }

  async commitPending({ origin = 'user', note = null } = {}) {
    this.#cancelIdle();
    // this.pending only means "nothing new since the last flush" — a prior
    // commitPending (the idle timer, or the structural-edit threshold in
    // #modelChanged) may have already flipped it false while its own
    // commitRevision + onCommit are still resolving on commitInFlight. A
    // caller here (e.g. beforeAgentRequest, right before reading
    // history.currentRevision) must still wait for that to land, or it can
    // observe model text ahead of the revision that's supposed to record it.
    if (!this.pending) return this.commitInFlight;
    this.beforeCommit();
    const base = normalizeVisibleRootText(this.pendingBase);
    const result = normalizeVisibleRootText(this.model.text);
    this.#applyNormalized(result);
    this.pending = false;
    this.pendingBase = null;
    const secondary = base === result ? [] : this.secondaryParents(base, result);
    const commit = this.commitInFlight
      .then(() => commitRevision(this.history, base, result, { origin, note, secondaryParents: secondary }))
      .then((revision) => {
        if (revision) this.onChange(this.history);
        return revision;
      })
      .then(async (revision) => {
        if (revision) await this.onCommit(revision, this.history);
        return revision;
      });
    this.commitInFlight = commit.catch((error) => {
      this.onError(error);
      return null;
    });
    return commit;
  }

  async beforeAgentRequest() {
    return this.commitPending({ origin: 'user' });
  }

  async applyAgentStory(story, options = {}) {
    await this.beforeAgentRequest();
    const base = normalizeVisibleRootText(this.model.text);
    const result = normalizeVisibleRootText(story);
    if (base === result) return null;
    this.model.replace(0, base.length, result, { origin: 'agent' });
    const revision = await commitRevision(this.history, base, result, {
      origin: 'agent',
      note: options.note ?? null,
      timestamp: options.timestamp,
    });
    this.onChange(this.history);
    await this.onCommit(revision, this.history);
    return revision;
  }

  async explicitSave(note = null) {
    return this.commitPending({ origin: 'user', note });
  }

  async closeOrSwitch() {
    return this.commitPending({ origin: 'user' });
  }

  async checkout(revisionId) {
    await this.commitPending();
    const story = await reconstructRevision(this.history, revisionId);
    this.history.currentRevision = revisionId;
    this.model.replace(0, this.model.text.length, story, { origin: 'checkout' });
    this.onChange(this.history);
    return story;
  }

  async undo() {
    await this.commitPending();
    const current = this.history.revisions.get(this.history.currentRevision);
    if (!current || current.parents.length === 0) return { type: 'none' };
    const revisionId = current.parents[0];
    await this.checkout(revisionId);
    return { type: 'history', revisionId };
  }

  async redo(revisionId = null) {
    await this.commitPending();
    const children = childrenOf(this.history, this.history.currentRevision);
    if (children.length === 0) return { type: 'none' };
    if (revisionId === null && children.length > 1) return { type: 'choose', choices: children };
    const target = revisionId === null ? children[0] : children.find(({ id }) => id === revisionId);
    if (!target) return { type: 'invalid-choice', choices: children };
    await this.checkout(target.id);
    return { type: 'history', revisionId: target.id };
  }
}
