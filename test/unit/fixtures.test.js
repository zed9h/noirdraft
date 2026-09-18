import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import path from 'node:path';

const fixtures = path.resolve('test/fixtures');

test('awkward Markdown fixture retains fake roots and Unicode', async () => {
  const source = await readFile(path.join(fixtures, 'awkward.md'), 'utf8');
  assert.match(source, /```markdown\n# STORY\n```/);
  assert.match(source, /Café 🚪/);
  assert.match(source, /^# NOTES-FOR-PUBLISHER$/m);
});

test('line-ending fixtures exercise LF and CRLF input', async () => {
  const lf = await readFile(path.join(fixtures, 'line-endings-lf.md'), 'utf8');
  const crlf = await readFile(path.join(fixtures, 'line-endings-crlf.md'), 'utf8');
  assert.equal(lf.includes('\r\n'), false);
  assert.equal(crlf.includes('\r\n'), true);
});
