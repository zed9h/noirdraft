import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractHeadings, headingTree, resolveHeadingPath } from '../../src/renderer/project/headings.js';
import { readPins, resolvePins, writePins } from '../../src/renderer/project/pins.js';

const story = '# Chapter One\nIntro.\n\n## Arrival\nText.\n\n## Door\nMore.\n\n# Chapter Two\nEnd.\n';
const metadata = '# Argument\nA premise.\n\n# Characters\n\n## Maria\nDetails.\n\n## Elias\nDetails.\n';

test('heading extraction derives hierarchy, paths, and section ranges', () => {
  const headings = extractHeadings(story, 'STORY');
  assert.deepEqual(headings.map(({ path }) => path), [
    'STORY/Chapter One',
    'STORY/Chapter One/Arrival',
    'STORY/Chapter One/Door',
    'STORY/Chapter Two',
  ]);
  assert.equal(headings[0].to, story.indexOf('# Chapter Two'));
  assert.equal(headings[1].to, story.indexOf('## Door'));
  assert.equal(headings[3].to, story.length);
  assert.deepEqual(headingTree(story, 'STORY').map(({ title }) => title), ['Chapter One', 'Chapter Two']);
});

test('fenced fake headings never enter navigation', () => {
  const source = '# Real\n```md\n## Fake\n```\n## Child\n';
  assert.deepEqual(extractHeadings(source, 'STORY').map(({ title }) => title), ['Real', 'Child']);
});

test('path resolver returns exact section content and never silently retargets', () => {
  const documents = { STORY: story, METADATA: metadata };
  const resolved = resolveHeadingPath(documents, 'METADATA/Characters/Maria');
  assert.equal(resolved.status, 'resolved');
  assert.match(resolved.text, /^## Maria/);
  assert.equal(resolved.text.includes('## Elias'), false);
  assert.deepEqual(resolveHeadingPath(documents, 'METADATA/Characters/Marie'), {
    status: 'unresolved',
    path: 'METADATA/Characters/Marie',
  });
});

test('duplicate heading paths are reported as ambiguous', () => {
  const duplicate = '# Characters\n## Maria\nOne.\n## Maria\nTwo.\n';
  const result = resolveHeadingPath({ METADATA: duplicate }, 'METADATA/Characters/Maria');
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.matches.length, 2);
});

test('pins use ordinary Markdown under Application/Context', () => {
  const pinned = writePins(metadata, [
    'METADATA/Argument',
    'METADATA/Characters/Maria',
    'METADATA/Argument',
  ]);
  assert.match(pinned, /# Application\n\n## Context\n\n- METADATA\/Argument\n- METADATA\/Characters\/Maria\n$/);
  assert.deepEqual(readPins(pinned), ['METADATA/Argument', 'METADATA/Characters/Maria']);

  const updated = writePins(pinned, ['STORY/Chapter One/Arrival']);
  assert.deepEqual(readPins(updated), ['STORY/Chapter One/Arrival']);
  assert.equal((updated.match(/## Context/g) ?? []).length, 1);
});

test('pin resolution retains unresolved paths explicitly', () => {
  const withPins = writePins(metadata, ['METADATA/Characters/Maria', 'METADATA/Characters/Renamed']);
  const resolved = resolvePins(withPins, { STORY: story, METADATA: withPins });
  assert.deepEqual(resolved.map(({ status, path }) => ({ status, path })), [
    { status: 'resolved', path: 'METADATA/Characters/Maria' },
    { status: 'unresolved', path: 'METADATA/Characters/Renamed' },
  ]);
});

test('pin storage preserves CRLF convention', () => {
  const source = '# Argument\r\nText.\r\n';
  const pinned = writePins(source, ['METADATA/Argument']);
  assert.equal(/(^|[^\r])\n/.test(pinned), false);
  assert.deepEqual(readPins(pinned), ['METADATA/Argument']);
});

test('pin then unpin then pin never glues an entry onto the Context heading', () => {
  let source = '# Notes\nText.\n';
  for (let round = 0; round < 3; round += 1) {
    source = writePins(source, ['METADATA/Notes']);
    assert.deepEqual(readPins(source), ['METADATA/Notes']);
    source = writePins(source, []);
    assert.deepEqual(readPins(source), []);
  }
  // A heading whose blank line was trimmed away by an earlier edit is repaired.
  assert.equal(writePins('# Application\n\n## Context', ['A']), '# Application\n\n## Context\n\n- A\n');
  assert.equal(writePins('# Application\n\n## Context\n', ['A']), '# Application\n\n## Context\n\n- A\n');
});
