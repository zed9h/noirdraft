function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export class StoryModel {
  #listeners = new Set();

  constructor(text = '', selectionStart = 0, selectionEnd = selectionStart) {
    this.text = String(text);
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.setSelection(selectionStart, selectionEnd, 'initial');
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  replace(from, to, replacement, options = {}) {
    const start = clamp(Math.trunc(from), 0, this.text.length);
    const end = clamp(Math.trunc(to), start, this.text.length);
    const inserted = String(replacement);
    const previousText = this.text;
    const previousSelection = [this.selectionStart, this.selectionEnd];
    this.text = previousText.slice(0, start) + inserted + previousText.slice(end);

    const nextStart = options.selectionStart ?? start + inserted.length;
    const nextEnd = options.selectionEnd ?? nextStart;
    this.selectionStart = clamp(Math.trunc(nextStart), 0, this.text.length);
    this.selectionEnd = clamp(Math.trunc(nextEnd), this.selectionStart, this.text.length);

    const change = {
      type: 'replace',
      from: start,
      to: end,
      inserted,
      removed: previousText.slice(start, end),
      previousText,
      previousSelection,
      origin: options.origin ?? 'application',
    };
    this.#emit(change);
    return change;
  }

  setSelection(start, end = start, origin = 'application') {
    const nextStart = clamp(Math.trunc(start), 0, this.text.length);
    const nextEnd = clamp(Math.trunc(end), nextStart, this.text.length);
    if (nextStart === this.selectionStart && nextEnd === this.selectionEnd) return false;
    const previousSelection = [this.selectionStart, this.selectionEnd];
    this.selectionStart = nextStart;
    this.selectionEnd = nextEnd;
    this.#emit({ type: 'selection', previousSelection, origin });
    return true;
  }

  snapshot() {
    return Object.freeze({
      text: this.text,
      selectionStart: this.selectionStart,
      selectionEnd: this.selectionEnd,
    });
  }

  #emit(change) {
    for (const listener of this.#listeners) listener(this.snapshot(), change);
  }
}
