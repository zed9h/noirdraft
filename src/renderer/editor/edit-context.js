import { createCommandHandler } from './commands.js';
import { OffsetMapping } from './mapping.js';
import { MarkdownRenderer } from './render.js';
import { readDOMSelection, writeDOMSelection } from './selection.js';

function asDOMRect(rect) {
  return new DOMRect(rect.x, rect.y, rect.width, rect.height);
}

export class EditContextEditor {
  #composing = false;
  #ignoreDOMSelection = false;
  #selectionWrite = 0;
  #unsubscribe;

  constructor(element, model) {
    if (!globalThis.EditContext) throw new Error('This Chromium runtime does not expose EditContext.');
    this.element = element;
    this.model = model;
    this.renderer = new MarkdownRenderer(element);
    this.mapping = new OffsetMapping(element);
    this.highlights = [];
    this.context = new EditContext(model.snapshot());
    this.renderer.render(model.text);
    this.mapping.refresh();
    element.editContext = this.context;

    this.#unsubscribe = model.subscribe((snapshot, change) => this.#modelChanged(snapshot, change));
    this.#listen();
    this.#syncDOMSelection();
    this.updateBounds();
  }

  destroy() {
    this.#unsubscribe?.();
    this.element.editContext = null;
  }

  replace(from, to, text, origin = 'command') {
    const change = this.model.replace(from, to, text, { origin });
    if (origin !== 'edit-context') {
      this.context.updateText(change.from, change.to, change.inserted);
      this.context.updateSelection(this.model.selectionStart, this.model.selectionEnd);
    }
  }

  setSelection(start, end = start, origin = 'command') {
    if (!this.model.setSelection(start, end, origin)) return;
    if (origin !== 'edit-context') this.context.updateSelection(this.model.selectionStart, this.model.selectionEnd);
  }

  updateBounds() {
    this.context.updateControlBounds(asDOMRect(this.element.getBoundingClientRect()));
    const { selectionStart, selectionEnd } = this.model;
    const rect = this.mapping.rangeRect(selectionStart, selectionEnd);
    this.context.updateSelectionBounds(asDOMRect(rect));
    this.#updateVisualCaret(rect, selectionStart === selectionEnd);
  }

  /** Transient, non-document decorations expressed in canonical UTF-16 offsets. */
  setHighlights(ranges = []) {
    this.highlights = ranges
      .filter(({ from, to }) => Number.isSafeInteger(from) && Number.isSafeInteger(to) && from < to)
      .map(({ from, to, color = 0 }) => ({ from, to, color }));
    this.#applyHighlights();
  }

  #listen() {
    this.context.addEventListener('textupdate', (event) => {
      this.model.replace(event.updateRangeStart, event.updateRangeEnd, event.text, {
        selectionStart: event.selectionStart,
        selectionEnd: event.selectionEnd,
        origin: 'edit-context',
      });
    });
    this.context.addEventListener('compositionstart', () => {
      this.#composing = true;
      this.element.classList.add('is-composing');
    });
    this.context.addEventListener('compositionend', () => {
      this.#composing = false;
      this.element.classList.remove('is-composing');
    });
    this.context.addEventListener('textformatupdate', () => {
      this.element.classList.toggle('has-ime-format', this.#composing);
    });
    this.context.addEventListener('characterboundsupdate', (event) => {
      const start = event.rangeStart;
      const end = Math.min(event.rangeEnd, this.model.text.length);
      this.context.updateCharacterBounds(start, this.mapping.characterRects(start, end));
    });

    this.element.addEventListener('keydown', createCommandHandler({
      model: this.model,
      replace: (from, to, text) => this.replace(from, to, text),
      setSelection: (start, end) => this.setSelection(start, end),
      moveVertically: (direction, extend) => this.#moveVertically(direction, extend),
    }));
    this.element.addEventListener('copy', (event) => this.#copy(event, false));
    this.element.addEventListener('cut', (event) => this.#copy(event, true));
    this.element.addEventListener('paste', (event) => {
      const text = event.clipboardData?.getData('text/plain');
      if (text === undefined) return;
      event.preventDefault();
      this.replace(this.model.selectionStart, this.model.selectionEnd, text, 'paste');
    });
    this.element.addEventListener('focus', () => {
      this.#syncDOMSelection();
      this.updateBounds();
    });
    this.element.addEventListener('blur', () => this.#updateVisualCaret(null, false));
    document.addEventListener('selectionchange', () => this.#domSelectionChanged());
    new ResizeObserver(() => this.updateBounds()).observe(this.element);
    this.element.addEventListener('scroll', () => this.updateBounds(), { passive: true });
  }

  #copy(event, cut) {
    const { text, selectionStart: start, selectionEnd: end } = this.model;
    if (start === end || !event.clipboardData) return;
    event.preventDefault();
    event.clipboardData.setData('text/plain', text.slice(start, end));
    if (cut) this.replace(start, end, '', 'cut');
  }

  #modelChanged(snapshot, change) {
    if (change.type === 'replace') {
      this.renderer.render(snapshot.text, change);
      this.#applyHighlights();
      this.mapping.refresh();
    }
    if (change.origin !== 'dom') this.#syncDOMSelection();
    this.updateBounds();
    this.element.dispatchEvent(new CustomEvent('editorstatechange', { detail: snapshot }));
  }

  #syncDOMSelection() {
    // A document Selection belongs to the active native text control. Updating
    // an offscreen editor while the chat composer (or another input) is being
    // used must not replace that control's caret with an editor selection.
    const activeElement = this.element.ownerDocument.activeElement;
    if (activeElement !== this.element && activeElement?.matches?.('input, textarea, [contenteditable="true"]')) return;
    const write = ++this.#selectionWrite;
    this.#ignoreDOMSelection = true;
    writeDOMSelection(this.element, this.mapping, this.model.selectionStart, this.model.selectionEnd);
    this.#scrollSelectionIntoView();
    requestAnimationFrame(() => {
      if (write === this.#selectionWrite) this.#ignoreDOMSelection = false;
    });
  }

  #scrollSelectionIntoView() {
    const caret = this.mapping.rangeRect(this.model.selectionEnd);
    const viewport = this.element.getBoundingClientRect();
    const padding = 24;
    if (caret.bottom > viewport.bottom - padding) {
      this.element.scrollTop += caret.bottom - viewport.bottom + padding;
    } else if (caret.top < viewport.top + padding) {
      this.element.scrollTop -= viewport.top - caret.top + padding;
    }
  }

  #domSelectionChanged() {
    if (this.#ignoreDOMSelection) return;
    const selection = readDOMSelection(this.element, this.mapping);
    if (!selection) return;
    this.setSelection(selection.start, selection.end, 'dom');
  }

  #moveVertically(direction, extend) {
    const offset = direction < 0 ? this.model.selectionStart : this.model.selectionEnd;
    const rect = this.mapping.rangeRect(offset);
    const lineHeight = Number.parseFloat(getComputedStyle(this.element).lineHeight) || 24;
    const position = document.caretPositionFromPoint(rect.x, rect.y + direction * lineHeight);
    const target = position ? this.mapping.fromDOM(position.offsetNode, position.offset) : null;
    if (target === null) return;
    if (extend) this.setSelection(Math.min(this.model.selectionStart, target), Math.max(this.model.selectionEnd, target));
    else this.setSelection(target, target);
  }

  #updateVisualCaret(rect, collapsed) {
    const visible = collapsed && document.activeElement === this.element;
    this.element.classList.toggle('has-visual-caret', visible);
    if (!visible || !rect) return;
    const control = this.element.getBoundingClientRect();
    const fontSize = Number.parseFloat(getComputedStyle(this.element).fontSize) || 16;
    // Keep the cursor glyph independent from the line box. Empty terminal
    // rows need a full-height hit/IME rectangle, but painting that rectangle
    // as a caret makes it visibly taller than the cursor in ordinary text.
    const height = fontSize;
    const top = rect.top + Math.max(0, (rect.height - height) / 2);
    this.element.style.setProperty('--caret-x', `${rect.left - control.left + this.element.scrollLeft}px`);
    this.element.style.setProperty('--caret-y', `${top - control.top + this.element.scrollTop}px`);
    this.element.style.setProperty('--caret-height', `${height}px`);
  }

  #applyHighlights() {
    for (const run of this.element.querySelectorAll('.source-run')) {
      const from = Number(run.dataset.from);
      const to = Number(run.dataset.to);
      const highlight = this.highlights.find((range) => range.from < to && range.to > from);
      run.classList.remove('agent-target-highlight-0', 'agent-target-highlight-1', 'agent-target-highlight-2', 'agent-target-highlight-3');
      if (highlight) run.classList.add(`agent-target-highlight-${highlight.color % 4}`);
    }
  }
}
