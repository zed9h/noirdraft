import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import {
  baseStemFor,
  formatSaveTimestamp,
  timestampedSavePathFor,
} from '../../src/main/timestamped-save-path.js';

test('formatSaveTimestamp renders yyyymmdd_HHMMSS from local time fields', () => {
  const date = new Date(2026, 8, 22, 6, 7, 8);
  assert.equal(formatSaveTimestamp(date), '20260922_060708');
});

test('baseStemFor strips an existing timestamp suffix', () => {
  assert.equal(baseStemFor(path.join('project', 'story.md')), 'story');
  assert.equal(baseStemFor(path.join('project', 'story_20260101_120000.md')), 'story');
  assert.equal(baseStemFor('story_20260101_120000_20260202_130000.md'), 'story_20260101_120000');
  assert.equal(baseStemFor('story_2026010_120000.md'), 'story_2026010_120000');
});

test('timestampedSavePathFor bases the new name on the opened file, once', () => {
  const date = new Date(2026, 8, 22, 6, 7, 8);
  const first = timestampedSavePathFor(path.join('project', 'story.md'), date);
  assert.equal(first, path.join('project', 'story_20260922_060708.md'));
});

test('a later save from an already timestamped path re-derives the base and does not stack', () => {
  const firstSave = new Date(2026, 8, 22, 6, 7, 8);
  const secondSave = new Date(2026, 8, 22, 9, 0, 0);
  const first = timestampedSavePathFor(path.join('project', 'story.md'), firstSave);
  const second = timestampedSavePathFor(first, secondSave);
  assert.equal(second, path.join('project', 'story_20260922_090000.md'));
});
