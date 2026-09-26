import { wordDiff } from './word-diff.js';

/**
 * Classifies a stored unified-diff patch for display: hunk headers, context,
 * deleted and added rows. Within a run of deleted rows followed by added rows,
 * rows are paired in order and only the words that differ are marked
 * `changed`; unpaired rows are entirely changed. Presentation only, never
 * stored. Each row keeps its patch `prefix` (`+`, `-`, space) so the shown text
 * reads as the valid patch it is.
 */
export function classifyPatch(payload) {
  const rows = [];
  for (const line of String(payload).split('\n')) {
    if (line === '') continue;
    if (line.startsWith('@@')) rows.push({ kind: 'hunk', prefix: '', segments: [{ text: line, changed: false }] });
    else if (line.startsWith('\\')) rows.push({ kind: 'meta', prefix: '', segments: [{ text: line, changed: false }] });
    else if (line[0] === '+') rows.push({ kind: 'add', prefix: '+', segments: [{ text: line.slice(1), changed: true }] });
    else if (line[0] === '-') rows.push({ kind: 'del', prefix: '-', segments: [{ text: line.slice(1), changed: true }] });
    else rows.push({ kind: 'context', prefix: ' ', segments: [{ text: line.slice(1), changed: false }] });
  }
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index].kind !== 'del') continue;
    let delEnd = index;
    while (rows[delEnd]?.kind === 'del') delEnd += 1;
    let addEnd = delEnd;
    while (rows[addEnd]?.kind === 'add') addEnd += 1;
    for (let offset = 0; delEnd + offset < addEnd && index + offset < delEnd; offset += 1) {
      const removed = rows[index + offset];
      const added = rows[delEnd + offset];
      const ops = wordDiff(removed.segments[0].text, added.segments[0].text);
      removed.segments = ops.filter((op) => op.type !== 'insert').map((op) => ({ text: op.text, changed: op.type === 'delete' }));
      added.segments = ops.filter((op) => op.type !== 'delete').map((op) => ({ text: op.text, changed: op.type === 'insert' }));
    }
    index = addEnd - 1;
  }
  return rows;
}
