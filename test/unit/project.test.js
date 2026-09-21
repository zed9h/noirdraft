import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ProjectDocumentError,
  findTopLevelHeadings,
  parseProjectDocument,
} from '../../src/renderer/project/parse.js';
import {
  ProjectionError,
  demoteVisibleHeadings,
  projectRoot,
  promoteStoredHeadings,
} from '../../src/renderer/project/projection.js';
import { serializeProjectDocument } from '../../src/renderer/project/serialize.js';

test('project parser finds reserved roots outside fences in physical order', () => {
  const source = [
    'Preamble.\n\n',
    '# METADATA\n\n## Style\nQuiet.\n\n',
    '# NOTES-FOR-PUBLISHER\nKeep this.\n\n',
    '# STORY\n\n## Chapter\nText.\n\n',
    '# CHAT\n\n```markdown\n# VERSIONS\n```\n',
    '# VERSIONS\n',
  ].join('');
  const project = parseProjectDocument(source);
  assert.deepEqual(project.segments.map((segment) => segment.name ?? segment.type), [
    'preamble', 'METADATA', 'NOTES-FOR-PUBLISHER', 'STORY', 'CHAT', 'VERSIONS',
  ]);
  assert.equal(project.roots.STORY.name, 'STORY');
  assert.deepEqual(project.unknownRoots.map(({ name }) => name), ['NOTES-FOR-PUBLISHER']);
  assert.equal(serializeProjectDocument(project), source);
});

test('fake roots in backtick and tilde fences are ignored', () => {
  const source = '```md\n# STORY\n```\n~~~\n# CHAT\n~~~\n# METADATA\n';
  assert.deepEqual(findTopLevelHeadings(source).map(({ name }) => name), ['METADATA']);
});

test('duplicate reserved roots produce a recoverable error with partial project', () => {
  const source = '# STORY\nOne.\n# STORY\nTwo.\n';
  assert.throws(
    () => parseProjectDocument(source),
    (error) => {
      assert.ok(error instanceof ProjectDocumentError);
      assert.equal(error.code, 'DUPLICATE_RESERVED_ROOT');
      assert.equal(error.root, 'STORY');
      assert.deepEqual(error.offsets, [0, 13]);
      assert.equal(error.project.segments.length, 2);
      return true;
    },
  );
});

test('STORY projection hides its root separator and promotes only real headings', () => {
  const source = '# STORY\r\n\r\n## Chapter\r\n### Scene\r\n```md\r\n## literal\r\n```\r\n\\## escaped\r\n';
  const project = parseProjectDocument(source);
  const story = projectRoot(project, 'STORY');
  assert.equal(story.separator, '\r\n');
  assert.equal(story.text, '# Chapter\r\n## Scene\r\n```md\r\n## literal\r\n```\r\n\\## escaped\r\n');
});

test('heading projection round-trips H1-H5 with fences, escapes, and CRLF', () => {
  const visible = '# One\r\n## Two\r\n### Three\r\n#### Four\r\n##### Five\r\n```md\r\n# literal\r\n```\r\n\\# escaped\r\n';
  assert.equal(promoteStoredHeadings(demoteVisibleHeadings(visible)), visible);
});

test('visible H6 is explicitly rejected rather than serialized as H7', () => {
  assert.throws(
    () => demoteVisibleHeadings('###### Unsupported\n'),
    (error) => error instanceof ProjectionError && error.code === 'UNSUPPORTED_VISIBLE_H6',
  );
});

test('serializer replaces projections while preserving unknown roots and order', () => {
  const source = '# METADATA\n\n## Old\n\n# UNKNOWN\nKeep exactly.\n\n# STORY\n\n## Old chapter\n';
  const project = parseProjectDocument(source);
  const serialized = serializeProjectDocument(project, {
    STORY: '# New chapter\nText.',
    METADATA: '# Style\nSparse.\n',
  });
  assert.equal(serialized, '# METADATA\n\n## Style\nSparse.\n# UNKNOWN\nKeep exactly.\n\n# STORY\n\n## New chapter\nText.');
});

test('serializer creates missing optional roots using the existing line ending', () => {
  const project = parseProjectDocument('# STORY\r\n\r\n## Chapter\r\n');
  const serialized = serializeProjectDocument(project, { CHAT: '# Session\r\n' });
  assert.equal(serialized, '# STORY\r\n\r\n## Chapter\r\n# CHAT\r\n\r\n## Session\r\n');
});

test('serializer places newly created reserved roots in preferred order', () => {
  const project = parseProjectDocument([
    '# STORY\n\n## Chapter\n',
    '# AUTHOR-NOTES\nKeep this section in place.\n',
    '# VERSIONS\n\nVersion data\n',
  ].join(''));
  const serialized = serializeProjectDocument(project, new Map([
    ['CHAT', '## Session\n'],
    ['METADATA', '# Notes\n'],
  ]));
  assert.equal(serialized, [
    '# STORY\n\n## Chapter\n',
    '# AUTHOR-NOTES\nKeep this section in place.\n',
    '# VERSIONS\n\nVersion data\n',
    '# CHAT\n\n### Session\n',
    '# METADATA\n\n## Notes\n',
  ].join(''));
});

test('unknown-only and rootless documents remain byte-identical when untouched', () => {
  for (const source of ['free text\n', '# UNKNOWN\nvalue\n']) {
    assert.equal(serializeProjectDocument(parseProjectDocument(source)), source);
  }
});

test('heading projection round-trips randomized supported story structures', () => {
  let seed = 0xc0ffee;
  const random = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed / 0x1_0000_0000;
  };
  for (let sample = 0; sample < 500; sample += 1) {
    const eol = random() > 0.5 ? '\n' : '\r\n';
    const lines = [];
    for (let index = 0; index < 20; index += 1) {
      const level = 1 + Math.floor(random() * 5);
      lines.push(`${'#'.repeat(level)} Heading ${sample}-${index}${eol}`);
      if (random() < 0.15) lines.push(`\`\`\`md${eol}# literal${eol}\`\`\`${eol}`);
      if (random() < 0.2) lines.push(`\\# escaped ${index}${eol}`);
    }
    const visible = lines.join('');
    assert.equal(promoteStoredHeadings(demoteVisibleHeadings(visible)), visible);
  }
});
