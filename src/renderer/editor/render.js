import { scanMarkdownBlocks, validateBlockPartition } from './markdown-scan.js';

function createRun(text, from, to, kinds) {
  const run = document.createElement('span');
  run.className = ['source-run', ...kinds.map((kind) => `token-${kind}`)].join(' ');
  run.dataset.from = String(from);
  run.dataset.to = String(to);
  run.textContent = text.slice(from, to);
  return run;
}

function renderBlock(text, block) {
  const element = document.createElement('div');
  element.className = `markdown-block block-${block.type}`;
  element.dataset.from = String(block.from);
  element.dataset.to = String(block.to);
  if (block.level) element.dataset.level = String(block.level);

  const boundaries = new Set([block.from, block.to]);
  for (const span of block.spans) {
    boundaries.add(span.from);
    boundaries.add(span.to);
  }
  const points = [...boundaries].sort((left, right) => left - right);
  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index];
    const to = points[index + 1];
    if (to === from) continue;
    const kinds = block.spans
      .filter((span) => span.from <= from && span.to >= to)
      .map((span) => span.kind);
    element.append(createRun(text, from, to, kinds));
  }
  if (block.from === block.to) element.append(createRun(text, block.from, block.to, []));
  return element;
}

function affectedBlockIndex(blocks, offset) {
  const index = blocks.findIndex((block) => block.to >= offset);
  return index === -1 ? Math.max(0, blocks.length - 1) : index;
}

function shiftBlock(block, delta) {
  return {
    ...block,
    from: block.from + delta,
    to: block.to + delta,
    spans: block.spans.map((span) => ({ ...span, from: span.from + delta, to: span.to + delta })),
  };
}

function shiftElement(element, delta) {
  for (const node of [element, ...element.querySelectorAll('[data-from][data-to]')]) {
    node.dataset.from = String(Number(node.dataset.from) + delta);
    node.dataset.to = String(Number(node.dataset.to) + delta);
  }
}

function canRescanOneBlock(block, change) {
  return block
    && block.type !== 'fenced-code'
    && change.from >= block.from
    && change.to <= block.to
    && !/[\r\n`~]/.test(change.inserted + change.removed);
}

export class MarkdownRenderer {
  constructor(container) {
    this.container = container;
    this.blocks = [];
    this.text = '';
  }

  render(text, change = null) {
    if (!change || this.blocks.length === 0) {
      this.blocks = scanMarkdownBlocks(text);
      if (!validateBlockPartition(text, this.blocks)) throw new Error('Markdown scanner did not partition source.');
      this.container.replaceChildren(...this.blocks.map((block) => renderBlock(text, block)));
      this.text = text;
      return { fromBlock: 0, replacedBlocks: this.blocks.length };
    }

    const affected = affectedBlockIndex(this.blocks, change.from);
    const affectedBlock = this.blocks[affected];
    if (canRescanOneBlock(affectedBlock, change)) {
      const delta = change.inserted.length - change.removed.length;
      const replacementTo = affectedBlock.to + delta;
      const replacementBlocks = scanMarkdownBlocks(text.slice(affectedBlock.from, replacementTo), affectedBlock.from);
      const suffix = this.blocks.slice(affected + 1).map((block) => shiftBlock(block, delta));
      const nextBlocks = [
        ...this.blocks.slice(0, affected),
        ...replacementBlocks,
        ...suffix,
      ];
      if (!validateBlockPartition(text, nextBlocks)) throw new Error('Local Markdown scan did not partition source.');

      const oldElement = this.container.children[affected];
      oldElement.replaceWith(...replacementBlocks.map((block) => renderBlock(text, block)));
      if (delta !== 0) {
        const suffixStart = affected + replacementBlocks.length;
        for (let index = suffixStart; index < this.container.children.length; index += 1) {
          shiftElement(this.container.children[index], delta);
        }
      }
      this.blocks = nextBlocks;
      this.text = text;
      return { fromBlock: affected, replacedBlocks: replacementBlocks.length, local: true };
    }

    const fromBlock = Math.max(0, affected - 1);
    const scanFrom = this.blocks[fromBlock]?.from ?? 0;
    const prefix = this.blocks.slice(0, fromBlock);
    const suffix = scanMarkdownBlocks(text.slice(scanFrom), scanFrom);
    const nextBlocks = [...prefix, ...suffix];
    if (!validateBlockPartition(text, nextBlocks)) throw new Error('Incremental Markdown scan did not partition source.');

    const firstNode = this.container.children[fromBlock] ?? null;
    while (this.container.children.length > fromBlock) this.container.lastElementChild.remove();
    this.container.append(...suffix.map((block) => renderBlock(text, block)));
    this.blocks = nextBlocks;
    this.text = text;
    return { fromBlock, replacedBlocks: suffix.length, firstNode };
  }
}
