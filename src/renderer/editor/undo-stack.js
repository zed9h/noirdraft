// Editor-level undo/redo of the author's own edits. It is independent of the
// revision graph: commits, idle saves and history never touch it. Any change
// that did not come from the author's typing (checkout, agent, open, pins…)
// invalidates the recorded offsets, so it empties the stack.
const RECORDED_ORIGINS = new Set(['edit-context', 'command', 'paste', 'cut']);
// 'normalize' is the commit's canonical whitespace tidy-up, not an outside edit.
const OWN_ORIGINS = new Set(['local-undo', 'local-redo', 'normalize']);

export class UndoStack {
  #unsubscribe;

  constructor(model) {
    this.model = model;
    this.undoOperations = [];
    this.redoOperations = [];
    this.#unsubscribe = model.subscribe((snapshot, change) => this.#modelChanged(snapshot, change));
  }

  destroy() {
    this.#unsubscribe?.();
  }

  clear() {
    this.undoOperations = [];
    this.redoOperations = [];
  }

  #modelChanged(snapshot, change) {
    if (change.type !== 'replace' || OWN_ORIGINS.has(change.origin)) return;
    if (!RECORDED_ORIGINS.has(change.origin)) {
      this.clear();
      return;
    }
    this.undoOperations.push({
      from: change.from,
      removed: change.removed,
      inserted: change.inserted,
      beforeSelection: change.previousSelection,
      afterSelection: [snapshot.selectionStart, snapshot.selectionEnd],
    });
    this.redoOperations = [];
  }

  undo() {
    const operation = this.undoOperations.pop();
    if (!operation) return false;
    this.model.replace(operation.from, operation.from + operation.inserted.length, operation.removed, {
      selectionStart: operation.beforeSelection[0],
      selectionEnd: operation.beforeSelection[1],
      origin: 'local-undo',
    });
    this.redoOperations.push(operation);
    return true;
  }

  redo() {
    const operation = this.redoOperations.pop();
    if (!operation) return false;
    this.model.replace(operation.from, operation.from + operation.removed.length, operation.inserted, {
      selectionStart: operation.afterSelection[0],
      selectionEnd: operation.afterSelection[1],
      origin: 'local-redo',
    });
    this.undoOperations.push(operation);
    return true;
  }
}
