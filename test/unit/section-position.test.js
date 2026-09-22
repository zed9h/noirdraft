import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createSectionNav, recallPosition, savePosition, stepSectionNav, visitSection,
} from '../../src/renderer/editor/section-position.js';

test('savePosition and recallPosition round-trip independently per heading path', () => {
  const nav = createSectionNav();
  savePosition(nav, 'STORY/Chapter One', { offset: 42, scrollTop: 100 });
  savePosition(nav, 'STORY/Chapter Two', { offset: 7, scrollTop: 0 });
  assert.deepEqual(recallPosition(nav, 'STORY/Chapter One'), { offset: 42, scrollTop: 100 });
  assert.deepEqual(recallPosition(nav, 'STORY/Chapter Two'), { offset: 7, scrollTop: 0 });
  assert.equal(recallPosition(nav, 'STORY/Chapter Three'), null);
});

test('visitSection pushes onto the stack and truncates any forward entries', () => {
  const nav = createSectionNav();
  visitSection(nav, 'A');
  visitSection(nav, 'B');
  visitSection(nav, 'C');
  assert.deepEqual(nav.stack, ['A', 'B', 'C']);
  stepSectionNav(nav, -1); // back to B
  stepSectionNav(nav, -1); // back to A
  visitSection(nav, 'D'); // branches from A — discards B, C
  assert.deepEqual(nav.stack, ['A', 'D']);
  assert.equal(nav.cursor, 1);
});

test('visitSection is a no-op when re-visiting the section already at the cursor', () => {
  const nav = createSectionNav();
  visitSection(nav, 'A');
  visitSection(nav, 'A');
  assert.deepEqual(nav.stack, ['A']);
});

test('stepSectionNav walks back/forward and returns null at either boundary', () => {
  const nav = createSectionNav();
  visitSection(nav, 'A');
  visitSection(nav, 'B');
  assert.equal(stepSectionNav(nav, -1), 'A');
  assert.equal(stepSectionNav(nav, -1), null);
  assert.equal(stepSectionNav(nav, 1), 'B');
  assert.equal(stepSectionNav(nav, 1), null);
});
