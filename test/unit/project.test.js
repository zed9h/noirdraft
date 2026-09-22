import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ProjectDocumentError,
  findTopLevelHeadings,
  parseProjectDocument,
} from '../../src/renderer/project/parse.js';
import {
  demoteVisibleHeadings,
  projectRoot,
  promoteStoredHeadings,
} from '../../src/renderer/project/projection.js';
import { serializeProjectDocument } from '../../src/renderer/project/serialize.js';

test('project parser finds reserved roots outside fences in physical order', () => {
  const source = [
    'Preamble.\n\n',
    'METADATA\n========\n\n# Style\nQuiet.\n\n',
    'NOTES-FOR-PUBLISHER\n===================\nKeep this.\n\n',
    'STORY\n=====\n\n# Chapter\nText.\n\n',
    'CHAT\n====\n\n```markdown\n# VERSIONS\n```\n',
    'VERSIONS\n========\n',
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
  const source = '```md\nSTORY\n=====\n```\n~~~\nCHAT\n====\n~~~\nMETADATA\n========\n';
  assert.deepEqual(findTopLevelHeadings(source).map(({ name }) => name), ['METADATA']);
});

test('duplicate reserved roots produce a recoverable error with partial project', () => {
  const source = 'STORY\n=====\nOne.\nSTORY\n=====\nTwo.\n';
  assert.throws(
    () => parseProjectDocument(source),
    (error) => {
      assert.ok(error instanceof ProjectDocumentError);
      assert.equal(error.code, 'DUPLICATE_RESERVED_ROOT');
      assert.equal(error.root, 'STORY');
      assert.deepEqual(error.offsets, [0, 17]);
      assert.equal(error.project.segments.length, 2);
      return true;
    },
  );
});

test('STORY projection normalizes LF, boundary whitespace, and Setext headings', () => {
  const source = '\uFEFFSTORY\r\n=====\r\n\r\nChapter\r\n-------\r\n```md\r\n## literal\r\n```\r\n\\## escaped\r\n\r\n';
  const project = parseProjectDocument(source);
  const story = projectRoot(project, 'STORY');
  assert.equal(story.separator, '\n');
  assert.equal(story.text, '## Chapter\n```md\n## literal\n```\n\\## escaped');
});

test('heading projection keeps ATX levels H1-H6 and normalizes Setext input', () => {
  const visible = '# One\n## Two\n### Three\n#### Four\n##### Five\n###### Six\n```md\n# literal\n```\n\\# escaped\n';
  assert.equal(promoteStoredHeadings(demoteVisibleHeadings(visible)), visible);
});

test('serializer replaces projections while preserving unknown roots and order', () => {
  const source = 'METADATA\n========\n\n# Old\n\nUNKNOWN\n=======\nKeep exactly.\n\nSTORY\n=====\n\n# Old chapter\n';
  const project = parseProjectDocument(source);
  const serialized = serializeProjectDocument(project, {
    STORY: '# New chapter\nText.',
    METADATA: '# Style\nSparse.\n',
  });
  assert.equal(serialized, 'METADATA\n========\n\n# Style\nSparse.\nUNKNOWN\n=======\nKeep exactly.\n\nSTORY\n=====\n\n# New chapter\nText.\n');
});

test('serializer creates missing optional roots using the existing line ending', () => {
  const project = parseProjectDocument('STORY\n=====\n\n# Chapter\n');
  const serialized = serializeProjectDocument(project, { CHAT: '# Session\n' });
  assert.equal(serialized, 'STORY\n=====\n\n# Chapter\nCHAT\n====\n\n# Session\n');
});

test('serializer places newly created reserved roots in preferred order', () => {
  const project = parseProjectDocument([
    'STORY\n=====\n\n# Chapter\n',
    'AUTHOR-NOTES\n============\nKeep this section in place.\n',
    'VERSIONS\n========\n\nVersion data\n',
  ].join(''));
  const serialized = serializeProjectDocument(project, new Map([
    ['CHAT', '## Session\n'],
    ['METADATA', '# Notes\n'],
  ]));
  assert.equal(serialized, [
    'STORY\n=====\n\n# Chapter\n',
    'AUTHOR-NOTES\n============\nKeep this section in place.\n',
    'VERSIONS\n========\n\nVersion data\n',
    'CHAT\n====\n\n## Session\n',
    'METADATA\n========\n\n# Notes\n',
  ].join(''));
});

test('unknown-only and rootless documents remain canonical when untouched', () => {
  for (const source of ['free text\n', 'UNKNOWN\n=======\nvalue\n']) {
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
    const eol = '\n';
    const lines = [];
    for (let index = 0; index < 20; index += 1) {
      const level = 1 + Math.floor(random() * 6);
      lines.push(`${'#'.repeat(level)} Heading ${sample}-${index}${eol}`);
      if (random() < 0.15) lines.push(`\`\`\`md${eol}# literal${eol}\`\`\`${eol}`);
      if (random() < 0.2) lines.push(`\\# escaped ${index}${eol}`);
    }
    const visible = lines.join('');
    assert.equal(promoteStoredHeadings(demoteVisibleHeadings(visible)), visible);
  }
});
