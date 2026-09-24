import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readOptions, writeOptions } from '../../src/renderer/project/options.js';
import { readPins, writePins } from '../../src/renderer/project/pins.js';

test('options round-trip under # Application and coexist with pins', () => {
  let source = writePins('# Notes\nText.\n', ['METADATA/Notes']);
  source = writeOptions(source, { saveOnEveryRevision: true, contextRows: 20 });
  source = writeOptions(source, { autoNotes: true });
  assert.deepEqual(readOptions(source), { autoNotes: true, saveOnEveryRevision: true, contextRows: 20 });
  assert.deepEqual(readPins(source), ['METADATA/Notes']);
  assert.match(source, /## Options\n\n- autoNotes: true\n/);
});

test('invalid option values and unknown keys are ignored', () => {
  const source = '# Application\n\n## Options\n\n- contextRows: 9000\n- autoNotes: maybe\n- bogus: 1\n- saveTimestampedCopies: false\n';
  assert.deepEqual(readOptions(source), { saveTimestampedCopies: false });
});
