export class OffsetMapping {
  constructor(container) {
    this.container = container;
    this.runs = [];
    this.anchors = [];
  }

  refresh() {
    this.runs = [...this.container.querySelectorAll('.source-run')]
      .map((element) => ({
        element,
        node: element.firstChild ?? element.appendChild(document.createTextNode('')),
        from: Number(element.dataset.from),
        to: Number(element.dataset.to),
      }));
    this.anchors = [...this.container.querySelectorAll('.layout-caret-anchor')]
      .map((element) => ({ element, offset: Number(element.dataset.offset) }));
  }

  toDOM(offset) {
    if (this.runs.length === 0) return { node: this.container, offset: 0 };
    const clamped = Math.max(0, offset);
    const anchor = this.anchors.find((candidate) => candidate.offset === clamped);
    // A source-final newline has a real empty visual row; map its end boundary
    // to that row's explicit layout anchor.
    if (anchor) return { node: anchor.element, offset: 0 };
    const run = this.runs.find((candidate) => clamped >= candidate.from && clamped < candidate.to)
      ?? this.runs.find((candidate) => clamped === candidate.to)
      ?? this.runs.at(-1);
    return { node: run.node, offset: Math.min(run.node.length, Math.max(0, clamped - run.from)) };
  }

  fromDOM(node, offset) {
    const anchor = node.nodeType === Node.ELEMENT_NODE
      ? node.closest?.('.layout-caret-anchor')
      : node.parentElement?.closest('.layout-caret-anchor');
    if (anchor) return Number(anchor.dataset.offset);
    const direct = this.runs.find((run) => run.node === node);
    if (direct) return direct.from + Math.min(direct.node.length, Math.max(0, offset));
    if (node === this.container) {
      return offset <= 0 ? 0 : (this.runs.at(-1)?.to ?? 0);
    }
    if (!this.container.contains(node)) return null;
    const runElement = node.nodeType === Node.ELEMENT_NODE
      ? node.closest?.('.source-run')
      : node.parentElement?.closest('.source-run');
    if (runElement) {
      const run = this.runs.find((candidate) => candidate.element === runElement);
      if (run) {
        const range = document.createRange();
        range.setStart(run.element, 0);
        try {
          range.setEnd(node, offset);
        } catch {
          return null;
        }
        return run.from + range.toString().length;
      }
    }
    const range = document.createRange();
    range.setStart(this.container, 0);
    try {
      range.setEnd(node, offset);
    } catch {
      return null;
    }
    const length = range.toString().length;
    return Math.min(this.runs.at(-1)?.to ?? 0, length);
  }

  rangeRect(from, to = from) {
    const start = this.toDOM(from);
    const end = this.toDOM(to);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    const rectangles = [...range.getClientRects()];
    if (rectangles.length > 0) return rectangles.at(-1);
    // A collapsed caret positioned on a lone line-break character (e.g. a
    // blank line, whose entire text content is just "\n") commonly reports
    // zero client rects, and getBoundingClientRect() of that same collapsed
    // range then degenerates to {0,0,0,0} in Chromium. There is no adjacent
    // character on that same visual row to measure instead (probing the "\n"
    // itself only reports the *previous* line, since that is where the
    // break character's own glyph sits). The source run still participates in
    // the correct visual row, so use its line fragment as the fallback.
    return this.#elementRect(start) ?? range.getBoundingClientRect();
  }

  #elementRect({ node, offset }) {
    const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    if (!element || !this.container.contains(element)) return null;
    // getBoundingClientRect() would return the union of every wrapped
    // fragment (e.g. both the row before and the row after an internal hard
    // break), which is too tall. getClientRects() gives one box per visual
    // line instead; pick the first fragment for a leading offset and the
    // last for a trailing one, matching which row the collapsed caret is on.
    const rects = [...element.getClientRects()];
    const rect = offset === 0 ? rects[0] : rects.at(-1);
    if (!rect || (rect.width === 0 && rect.height === 0)) return null;
    return new DOMRect(rect.left, rect.top, 0, rect.height);
  }

  characterRects(from, to) {
    const rectangles = [];
    for (let offset = from; offset < to; offset += 1) {
      const rect = this.rangeRect(offset, offset + 1);
      rectangles.push(new DOMRect(rect.x, rect.y, Math.max(1, rect.width), rect.height));
    }
    return rectangles;
  }
}
