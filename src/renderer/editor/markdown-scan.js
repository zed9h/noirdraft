const fencePattern = /^( {0,3})(`{3,}|~{3,})([^\r\n]*)(?:\r?\n|$)/;
const headingPattern = /^( {0,3})(#{1,6})(?:[ \t]+|(?=\r?$))/;
const blockquotePattern = /^( {0,3})(>)(?:[ \t]?)/;
const unorderedListPattern = /^(\s{0,3})([-+*])([ \t]+)/;
const orderedListPattern = /^(\s{0,3})(\d{1,9}[.)])([ \t]+)/;
const horizontalRulePattern = /^ {0,3}((?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})(?:\r?\n|$)/;

function linesOf(text, baseOffset = 0) {
  const lines = [];
  let from = 0;
  while (from < text.length) {
    const newline = text.indexOf('\n', from);
    const to = newline === -1 ? text.length : newline + 1;
    lines.push({ text: text.slice(from, to), from: baseOffset + from, to: baseOffset + to });
    from = to;
  }
  if (text.length === 0) lines.push({ text: '', from: baseOffset, to: baseOffset });
  return lines;
}

function prefixFor(line) {
  const heading = line.match(headingPattern);
  if (heading && heading[2].length <= 5) {
    return { type: 'heading', level: heading[2].length, length: heading[0].length };
  }
  const quote = line.match(blockquotePattern);
  if (quote) return { type: 'blockquote', length: quote[0].length };
  const unordered = line.match(unorderedListPattern);
  if (unordered) return { type: 'unordered-list', length: unordered[0].length };
  const ordered = line.match(orderedListPattern);
  if (ordered) return { type: 'ordered-list', length: ordered[0].length };
  return null;
}

function isBlank(line) {
  return /^[\t ]*(?:\r?\n)?$/.test(line);
}

function isBlockStart(line) {
  return fencePattern.test(line)
    || (headingPattern.test(line) && line.match(headingPattern)[2].length <= 5)
    || horizontalRulePattern.test(line)
    || blockquotePattern.test(line)
    || unorderedListPattern.test(line)
    || orderedListPattern.test(line);
}

function syntaxSpan(from, to, kind = 'syntax') {
  return { from, to, kind };
}

function findClosing(text, marker, from) {
  let position = from;
  while ((position = text.indexOf(marker, position)) !== -1) {
    let slashes = 0;
    for (let index = position - 1; index >= 0 && text[index] === '\\'; index -= 1) slashes += 1;
    if (slashes % 2 === 0) return position;
    position += marker.length;
  }
  return -1;
}

export function scanInline(text, baseOffset = 0, excludedPrefix = 0) {
  const spans = [];
  let cursor = excludedPrefix;
  const limit = text.replace(/\r?\n$/, '').length;
  while (cursor < limit) {
    if (text[cursor] === '\\') {
      cursor += Math.min(2, limit - cursor);
      continue;
    }

    let marker = null;
    let contentKind = null;
    if (text.startsWith('`', cursor)) {
      let count = 1;
      while (text[cursor + count] === '`') count += 1;
      marker = '`'.repeat(count);
      contentKind = 'inline-code';
    } else if (text.startsWith('***', cursor) || text.startsWith('___', cursor)) {
      marker = text.slice(cursor, cursor + 3);
      contentKind = 'strong-emphasis';
    } else if (text.startsWith('**', cursor) || text.startsWith('__', cursor)) {
      marker = text.slice(cursor, cursor + 2);
      contentKind = 'strong';
    } else if (text[cursor] === '*' || text[cursor] === '_') {
      marker = text[cursor];
      contentKind = 'emphasis';
    }

    if (!marker) {
      cursor += 1;
      continue;
    }
    const close = findClosing(text, marker, cursor + marker.length);
    if (close === -1 || close > limit || close === cursor + marker.length) {
      cursor += marker.length;
      continue;
    }
    spans.push(syntaxSpan(baseOffset + cursor, baseOffset + cursor + marker.length));
    spans.push({ from: baseOffset + cursor + marker.length, to: baseOffset + close, kind: contentKind });
    spans.push(syntaxSpan(baseOffset + close, baseOffset + close + marker.length));
    cursor = close + marker.length;
  }
  return spans;
}

function makeBlock(type, lines, extra = {}) {
  const from = lines[0].from;
  const to = lines.at(-1).to;
  const text = lines.map((line) => line.text).join('');
  const prefix = extra.prefixLength ?? 0;
  const spans = type === 'fenced-code' || type === 'blank'
    ? []
    : scanInline(text, from, prefix);
  if (prefix > 0) spans.unshift(syntaxSpan(from, from + prefix));
  return { type, from, to, spans, ...extra };
}

export function scanMarkdownBlocks(text, baseOffset = 0) {
  const lines = linesOf(text, baseOffset);
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const fence = line.text.match(fencePattern);
    if (fence) {
      const markerCharacter = fence[2][0];
      const markerLength = fence[2].length;
      const collected = [line];
      index += 1;
      while (index < lines.length) {
        const candidate = lines[index];
        collected.push(candidate);
        index += 1;
        const close = candidate.text.match(new RegExp(`^ {0,3}${markerCharacter === '`' ? '`' : '~'}{${markerLength},}[ \\t]*(?:\\r?\\n|$)`));
        if (close) break;
      }
      blocks.push(makeBlock('fenced-code', collected, {
        fence: fence[2],
        spans: [
          syntaxSpan(collected[0].from, collected[0].to, 'code-fence'),
          ...(collected.length > 1 ? [syntaxSpan(collected.at(-1).from, collected.at(-1).to, 'code-fence')] : []),
        ],
      }));
      continue;
    }

    if (isBlank(line.text)) {
      const collected = [line];
      index += 1;
      while (index < lines.length && isBlank(lines[index].text)) collected.push(lines[index++]);
      blocks.push(makeBlock('blank', collected));
      continue;
    }

    const heading = line.text.match(headingPattern);
    if (heading && heading[2].length <= 5) {
      blocks.push(makeBlock('heading', [line], { level: heading[2].length, prefixLength: heading[0].length }));
      index += 1;
      continue;
    }
    if (horizontalRulePattern.test(line.text)) {
      blocks.push(makeBlock('horizontal-rule', [line], { prefixLength: line.text.replace(/\r?\n$/, '').length }));
      index += 1;
      continue;
    }
    const prefix = prefixFor(line.text);
    if (prefix) {
      blocks.push(makeBlock(prefix.type, [line], { prefixLength: prefix.length }));
      index += 1;
      continue;
    }

    const collected = [line];
    index += 1;
    while (index < lines.length && !isBlank(lines[index].text) && !isBlockStart(lines[index].text)) {
      collected.push(lines[index++]);
    }
    blocks.push(makeBlock('paragraph', collected));
  }
  return blocks;
}

export function validateBlockPartition(text, blocks, baseOffset = 0) {
  let cursor = baseOffset;
  for (const block of blocks) {
    if (block.from !== cursor || block.to < block.from) return false;
    cursor = block.to;
  }
  return cursor === baseOffset + text.length;
}
