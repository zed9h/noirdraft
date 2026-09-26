import { wordDiff } from './word-diff.js';

const MAX_TOKEN_PRODUCT = 4_000_000;
// Punctuation is its own token, so a selection ending before a period still maps cleanly.
const TOKENS = /\s+|[\p{L}\p{N}_'’]+|[^\s\p{L}\p{N}_'’]/gu;
const tokenCount = (text) => (text.match(TOKENS) ?? []).length;

/**
 * Finds what `range` of `currentText` reads as in `historicalText`: exactly
 * the words that correspond to the selection, not the surrounding lines. The
 * shared prefix and suffix map one-to-one and only the differing middle is
 * word-diffed. A replaced word run counts as inside the selection when the
 * selection covers what it replaced; a word the historical text merely added
 * right after the selection is left out. A selection that reaches into a
 * replaced run takes the whole replacement. Returns null when the texts differ
 * too much to diff cheaply.
 */
export function mapSelectionToRevision(currentText, historicalText, range) {
  const [from, to] = range;
  const limit = Math.min(currentText.length, historicalText.length);
  let prefix = 0;
  while (prefix < limit && currentText[prefix] === historicalText[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < limit - prefix && currentText[currentText.length - 1 - suffix] === historicalText[historicalText.length - 1 - suffix]) suffix += 1;
  const middleCurrent = currentText.slice(prefix, currentText.length - suffix);
  const middleHistorical = historicalText.slice(prefix, historicalText.length - suffix);
  if (tokenCount(middleCurrent) * tokenCount(middleHistorical) > MAX_TOKEN_PRODUCT) return null;
  const ops = wordDiff(middleCurrent, middleHistorical, TOKENS);

  const mapPoint = (point, side) => {
    if (point <= prefix) return point;
    if (point >= currentText.length - suffix) return historicalText.length - (currentText.length - point);
    let c = prefix;
    let h = prefix;
    let previous = null;
    for (const op of ops) {
      if (c === point) {
        if (side === 'start') return h;
        if (!(op.type === 'insert' && previous === 'delete')) return h;
      }
      if (op.type === 'insert') h += op.text.length;
      else if (op.type === 'delete') {
        if (point < c + op.text.length) {
          // Inside a replaced run: a selection reaching into it takes the whole replacement.
          const next = ops[ops.indexOf(op) + 1];
          return side === 'end' && next?.type === 'insert' ? h + next.text.length : h;
        }
        c += op.text.length;
      } else {
        if (point < c + op.text.length) return h + (point - c);
        c += op.text.length;
        h += op.text.length;
      }
      previous = op.type;
    }
    return h;
  };

  const mappedFrom = mapPoint(from, 'start');
  const mappedTo = Math.max(mappedFrom, mapPoint(to, 'end'));
  return [mappedFrom, mappedTo];
}
