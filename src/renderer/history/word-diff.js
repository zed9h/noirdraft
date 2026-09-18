/**
 * Prose-oriented word/whitespace diff for comparing two passages side by
 * side. This is deliberately separate from the whole-STORY unified-diff
 * patches in diff.js: those are the canonical stored history, while this is
 * only a presentation aid for the comparison workbench and is never stored.
 */

function tokenize(text) {
  return text.match(/\s+|[^\s]+/g) ?? [];
}

/**
 * Returns a sequence of { type: 'equal' | 'delete' | 'insert', text }
 * tokens describing how to turn `before` into `after`, diffing at word
 * granularity via a longest-common-subsequence over tokens.
 */
export function wordDiff(before, after) {
  const a = tokenize(String(before));
  const b = tokenize(String(after));
  const lengths = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lengths[i][j] = a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ type: 'equal', text: a[i] });
      i += 1;
      j += 1;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      ops.push({ type: 'delete', text: a[i] });
      i += 1;
    } else {
      ops.push({ type: 'insert', text: b[j] });
      j += 1;
    }
  }
  while (i < a.length) { ops.push({ type: 'delete', text: a[i] }); i += 1; }
  while (j < b.length) { ops.push({ type: 'insert', text: b[j] }); j += 1; }

  const merged = [];
  for (const op of ops) {
    const last = merged.at(-1);
    if (last && last.type === op.type) last.text += op.text;
    else merged.push({ ...op });
  }
  return merged;
}
