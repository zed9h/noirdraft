// Decides which drafting flow fits where the author's selection or cursor sits.
// 'block': whole paragraphs, or a blank line — the notebook flow.
// 'short': anything else, including a cursor at a line's start or end — the inline alternatives flow.

const atParagraphStart = (text, index) => index <= 0 || /(^|\n)[ \t]*\n$/.test(text.slice(0, index));
const atParagraphEnd = (text, index) => index >= text.length || /^[ \t]*(?:\n[ \t]*)*$/.test(text.slice(index)) || /^[ \t]*\n[ \t]*\n/.test(text.slice(index));

export function classifyPlacement(source, from, to) {
  const text = String(source);
  const selected = text.slice(from, to);
  if (selected.trim()) {
    const start = from + (selected.length - selected.trimStart().length);
    const end = to - (selected.length - selected.trimEnd().length);
    return atParagraphStart(text, start) && atParagraphEnd(text, end) ? 'block' : 'short';
  }
  const lineStart = text.lastIndexOf('\n', from - 1) + 1;
  const lineEnd = text.indexOf('\n', from) < 0 ? text.length : text.indexOf('\n', from);
  if (!text.slice(lineStart, lineEnd).trim()) return 'block';
  return 'short';
}

/** Marks a replacement inside its surrounding text so the model can judge how it joins. */
export function renderInline({ before = '', text = '', after = '', width = 240 }) {
  const head = String(before).slice(-width);
  const tail = String(after).slice(0, width);
  return `${String(before).length > width ? '…' : ''}${head}⟦${text}⟧${tail}${String(after).length > width ? '…' : ''}`;
}
