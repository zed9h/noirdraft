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
  // The end that keyboard/mouse gestures move (focus) and the end that stays
  // put while a selection is extended (anchor). The model only tracks the
  // ordered [selectionStart, selectionEnd] pair, since most consumers only
  // care about the range; direction is interaction state, kept here.
  #anchor = 0;
  #focus = 0;

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
    this.#anchor = model.selectionStart;
    this.#focus = model.selectionEnd;

    this.#unsubscribe = model.subscribe((snapshot, change) => this.#modelChanged(snapshot, change));
    this.#listen();
    this.#syncDOMSelection();
    this.updateBounds();
  }

  /** The moving end of the selection (where the caret visually sits). */
  get focus() {
    return this.#focus;
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

  /** Sets an ordered range. Direction is assumed forward: anchor at `start`. */
  setSelection(start, end = start, origin = 'command') {
    this.#applySelection(start, end, origin);
  }

  /** Moves the focus end to `offset`, collapsing the anchor onto it too. */
  collapseTo(offset, origin = 'command') {
    this.#applySelection(offset, offset, origin);
  }

  /** Moves the focus end to `offset`, keeping the current anchor fixed. */
  extendTo(offset, origin = 'command') {
    this.#applySelection(this.#anchor, offset, origin);
  }

  #applySelection(anchor, focus, origin) {
    const clamp = (offset) => Math.min(this.model.text.length, Math.max(0, Math.trunc(offset)));
    this.#anchor = clamp(anchor);
    this.#focus = clamp(focus);
    const start = Math.min(this.#anchor, this.#focus);
    const end = Math.max(this.#anchor, this.#focus);
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

  /** Scrolls an offset into view without moving the selection or focus. */
  revealOffset(offset) {
    this.mapping.refresh();
    const rect = this.mapping.rangeRect(offset);
    const viewport = this.element.getBoundingClientRect();
    const padding = 24;
    this.element.scrollTop += rect.top - viewport.top - padding;
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
      collapseTo: (offset) => this.collapseTo(offset),
      extendTo: (offset) => this.extendTo(offset),
      getFocus: () => this.#focus,
      moveVertically: (direction, extend) => this.#moveVertically(direction, extend),
    }));
    this.element.addEventListener('mousedown', (event) => this.#mouseDown(event));
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

  // A single click-and-drag is driven from here with caretPositionFromPoint
  // (character-precise, the same primitive #moveVertically already relies
  // on) instead of the browser's own native drag-selection. The native
  // algorithm extends the DOM Selection by hit-testing elements under the
  // pointer, and this editor's content is one continuous white-space:
  // pre-wrap flow with zero-width anchor spans marking blank rows — a
  // pointer positioned in the sliver between two rows, or past the last
  // glyph on a short line, often isn't over any element with real
  // width/height there, so that hit-test falls back to the editor's root
  // container with a coarse child-index offset. caretPositionFromPoint
  // instead always resolves to the nearest actual character, so it doesn't
  // hit that dead zone in the first place. Double/triple-click (word/line
  // select) are left to the browser: only a plain single click takes this
  // over.
  #mouseDown(event) {
    if (event.button !== 0 || event.detail > 1) return;
    const start = this.#offsetFromPoint(event.clientX, event.clientY);
    if (start === null) return;
    event.preventDefault();
    this.element.focus();
    if (event.shiftKey) this.extendTo(start); else this.collapseTo(start);
    // A real mouse fires mousemove far faster than a synthetic/scripted
    // drag — every listener call here does a full extendTo (selection
    // change -> DOM sync -> auto-scroll -> layout/bounds recompute), and
    // running that whole cascade once per native event rather than once per
    // frame is exactly the kind of thing that produces a visibly janky,
    // stale-then-catch-up paint during a fast drag. Coalesce to the latest
    // point once per animation frame instead.
    let pendingPoint = null;
    let frame = null;
    const flush = () => {
      frame = null;
      if (!pendingPoint) return;
      const target = this.#offsetFromPoint(pendingPoint.x, pendingPoint.y);
      pendingPoint = null;
      if (target !== null) this.extendTo(target);
    };
    const onMove = (moveEvent) => {
      pendingPoint = { x: moveEvent.clientX, y: moveEvent.clientY };
      if (frame === null) frame = requestAnimationFrame(flush);
    };
    const onUp = () => {
      this.element.ownerDocument.removeEventListener('mousemove', onMove);
      this.element.ownerDocument.removeEventListener('mouseup', onUp);
      if (frame !== null) cancelAnimationFrame(frame);
      flush();
    };
    this.element.ownerDocument.addEventListener('mousemove', onMove);
    this.element.ownerDocument.addEventListener('mouseup', onUp);
  }

  #offsetFromPoint(x, y) {
    const position = document.caretPositionFromPoint(x, y);
    if (!position) return null;
    const offset = this.mapping.fromDOM(position.offsetNode, position.offset);
    if (offset === null) return null;
    const rect = this.mapping.rangeRect(offset);
    const tolerance = Math.max(48, rect.height * 3);
    const withinRow = Math.abs(rect.top - y) <= tolerance || Math.abs(rect.bottom - y) <= tolerance;
    if (withinRow) return offset;
    // Confirmed with live captures, not just theorized: in this scrolled
    // (position: relative; overflow: auto) container, caretPositionFromPoint
    // sometimes resolves to a position whose rendered row is off by almost
    // exactly the current scrollTop (e.g. query y=249 with scrollTop=784
    // resolved to a row at y=1029.8 — 249+784=1033) — the browser's own
    // hit-test appears to double-count the scroll offset for a point inside
    // a scrolled container, landing on content nowhere near the cursor. That
    // is what made the caret/selection jump to an unrelated place while
    // dragging (dragging the auto-scroll along with it, since it follows the
    // new, wrong focus). A point below the last line (or above the first) of
    // a document shorter than the viewport legitimately has its nearest
    // text far away in y — that's ordinary "clicked past the content"
    // behavior, not this bug — so only reject when real nearby text existed
    // inside the document's own extent and this wasn't it.
    const first = this.mapping.rangeRect(0);
    const last = this.mapping.rangeRect(this.model.text.length);
    if (y <= first.top || y >= last.bottom) return offset;
    return null;
  }

  #modelChanged(snapshot, change) {
    if (change.type === 'replace') {
      this.renderer.render(snapshot.text, change);
      this.#applyHighlights();
      this.mapping.refresh();
      // Every edit (typing, IME commit, paste, undo, …) lands on a fresh,
      // direction-less caret/range: resync here, synchronously, before the
      // DOM sync below reads #anchor/#focus — model.replace() emits this
      // change from inside itself, so a caller-side resync placed *after*
      // its call runs too late and writes the stale pre-edit position.
      this.#anchor = snapshot.selectionStart;
      this.#focus = snapshot.selectionEnd;
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
    writeDOMSelection(this.element, this.mapping, this.#anchor, this.#focus);
    this.#scrollSelectionIntoView();
    requestAnimationFrame(() => {
      if (write === this.#selectionWrite) this.#ignoreDOMSelection = false;
    });
  }

  #scrollSelectionIntoView() {
    // Follow the moving end of the selection (the focus), not always
    // selectionEnd: a backward selection's focus is selectionStart, and
    // scrolling to the wrong end strands the caret off-screen while it moves.
    const caret = this.mapping.rangeRect(this.#focus);
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
    // Preserve the true drag direction (mouse-down point vs. current
    // pointer position), not just the ordered range, so scrolling and
    // further shift-extension continue from the right end.
    this.#applySelection(selection.anchor, selection.focus, 'dom');
  }

  #moveVertically(direction, extend) {
    const offset = extend ? this.#focus : (direction < 0 ? this.model.selectionStart : this.model.selectionEnd);
    const rect = this.mapping.rangeRect(offset);
    // A collapsed range's own client rect is sized to the glyph, not the
    // full CSS line box (leading above/below is uncounted), so a single
    // fixed-offset probe undershoots on tall rows — most visibly headings,
    // which render far larger than body text (see .block-heading in
    // styles.css). Step in small increments instead, until the probe lands
    // on a genuinely different, correctly-ordered offset: that's robust to
    // any row's actual rendered height without having to compute it.
    //
    // The probe must start from the edge of the glyph box facing the
    // direction of travel (top when going up, bottom when going down), not
    // always the top: starting from the top when moving down forces every
    // step to first walk down through the current glyph's own height before
    // it can ever reach the row below, and at a soft-wrap boundary that
    // extra distance can carry the probe past the immediately following row
    // into the one after it (the wrapped-line-skip bug). Starting from the
    // near edge keeps up/down symmetric.
    const base = direction < 0 ? rect.top : rect.bottom;
    const step = 4;
    const maxDistance = 400;
    let target = null;
    for (let distance = step; distance <= maxDistance && target === null; distance += step) {
      const position = document.caretPositionFromPoint(rect.x, base + direction * distance);
      const candidate = position ? this.mapping.fromDOM(position.offsetNode, position.offset) : null;
      if (candidate === null) continue;
      if (direction < 0 ? candidate < offset : candidate > offset) target = candidate;
    }
    if (target === null) return;
    if (extend) this.extendTo(target); else this.collapseTo(target);
  }

  #updateVisualCaret(rect, collapsed) {
    const visible = collapsed && document.activeElement === this.element;
    if (visible) {
      // Restart the blink cycle on every move/edit (a forced reflow between
      // removing and re-adding the class) so the caret is always solid right
      // after a change instead of possibly re-appearing mid-blink.
      this.element.classList.remove('has-visual-caret');
      void this.element.offsetWidth;
      this.element.classList.add('has-visual-caret');
    } else {
      this.element.classList.remove('has-visual-caret');
    }
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
