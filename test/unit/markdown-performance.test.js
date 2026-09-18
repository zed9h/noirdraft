import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { scanMarkdownBlocks, validateBlockPartition } from '../../src/renderer/editor/markdown-scan.js';

function manuscript(size) {
  const chapter = '# Chapter\n\nParagraph with **bold**, *italic*, `code`, and Unicode 😀.\n\n> A quotation.\n\n- An item.\n\n';
  return chapter.repeat(Math.ceil(size / chapter.length)).slice(0, size);
}

for (const size of [100_000, 500_000, 1_000_000]) {
  test(`scans and partitions a ${size / 1_000} KB manuscript without pathological latency`, () => {
    const source = manuscript(size);
    const started = performance.now();
    const blocks = scanMarkdownBlocks(source);
    const elapsed = performance.now() - started;
    assert.equal(validateBlockPartition(source, blocks), true);
    assert.ok(elapsed < 2_000, `scan took ${elapsed.toFixed(1)} ms`);
  });
}
