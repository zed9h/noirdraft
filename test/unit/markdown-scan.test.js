import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scanInline, scanMarkdownBlocks, validateBlockPartition } from '../../src/renderer/editor/markdown-scan.js';

test('block scanner recognizes initial formatting scope and partitions exact source', () => {
  const source = [
    '# Heading **bold**\n',
    '\n',
    'Paragraph with *italic*, ***both***, and `code`.\n',
    '> quote\n',
    '- item\n',
    '1. ordered\n',
    '---\n',
    '```markdown\n',
    '# literal heading\n',
    '**literal bold**\n',
    '```\n',
  ].join('');
  const blocks = scanMarkdownBlocks(source);

  assert.equal(validateBlockPartition(source, blocks), true);
  assert.deepEqual(blocks.map(({ type }) => type), [
    'heading', 'blank', 'paragraph', 'blockquote', 'unordered-list',
    'ordered-list', 'horizontal-rule', 'fenced-code',
  ]);
  assert.equal(blocks[0].level, 1);
  assert.deepEqual(blocks[0].spans.map(({ kind }) => kind), ['syntax', 'syntax', 'strong', 'syntax']);
  assert.deepEqual(blocks.at(-1).spans.map(({ kind }) => kind), ['code-fence', 'code-fence']);
});

test('H6 and unsupported Markdown remain literal paragraph source', () => {
  const source = '###### Unsupported H6\n| table | source |\n';
  const blocks = scanMarkdownBlocks(source);
  assert.equal(validateBlockPartition(source, blocks), true);
  assert.deepEqual(blocks.map(({ type }) => type), ['paragraph']);
  assert.equal(blocks[0].from, 0);
  assert.equal(blocks[0].to, source.length);
});

test('inline scanner keeps escaped and unclosed markers plain', () => {
  const source = String.raw`\*plain\* **open and \`code\``;
  const spans = scanInline(source);
  assert.deepEqual(spans, []);
});

test('inline spans use global UTF-16 source offsets', () => {
  const source = '😀 **bold**';
  const spans = scanInline(source, 100);
  assert.deepEqual(spans, [
    { from: 103, to: 105, kind: 'syntax' },
    { from: 105, to: 109, kind: 'strong' },
    { from: 109, to: 111, kind: 'syntax' },
  ]);
});

test('fenced code may contain fake formatting without producing blocks', () => {
  const source = '~~~md\n# fake\n- fake\n~~~\n# real\n';
  const blocks = scanMarkdownBlocks(source);
  assert.deepEqual(blocks.map(({ type }) => type), ['fenced-code', 'heading']);
  assert.equal(validateBlockPartition(source, blocks), true);
});

test('scanner handles empty source as a valid zero-width partition', () => {
  const blocks = scanMarkdownBlocks('');
  assert.equal(validateBlockPartition('', blocks), true);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'blank');
});
