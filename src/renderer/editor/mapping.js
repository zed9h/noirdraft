export class OffsetMapping {
  constructor(container) {
    this.container = container;
    this.runs = [];
  }

  refresh() {
    this.runs = [...this.container.querySelectorAll('.source-run')]
      .map((element) => ({
        element,
        node: element.firstChild ?? element.appendChild(document.createTextNode('')),
        from: Number(element.dataset.from),
        to: Number(element.dataset.to),
      }));
  }

  toDOM(offset) {
    if (this.runs.length === 0) return { node: this.container, offset: 0 };
    const clamped = Math.max(0, offset);
    const run = this.runs.find((candidate) => clamped >= candidate.from && clamped <= candidate.to)
      ?? this.runs.at(-1);
    return { node: run.node, offset: Math.min(run.node.length, Math.max(0, clamped - run.from)) };
  }

  fromDOM(node, offset) {
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
    return rectangles.at(-1) ?? range.getBoundingClientRect();
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
