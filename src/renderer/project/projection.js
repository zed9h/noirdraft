function normalizeSetextHeadings(source) {
  const canonical = String(source).replace(/\r\n?/g, '\n');
  const output = [];
  let fence = null;
  const linePattern = /.*(?:\n|$)/g;
  for (const match of canonical.matchAll(linePattern)) {
    const line = match[0];
    if (line === '' && match.index === canonical.length) break;
    if (fence) {
      const closePattern = new RegExp(`^ {0,3}${fence.character === '`' ? '`' : '~'}{${fence.length},}[ \\t]*(?:\\n)?$`);
      if (closePattern.test(line)) fence = null;
      output.push(line);
      continue;
    }
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (opening) {
      fence = { character: opening[1][0], length: opening[1].length };
      output.push(line);
      continue;
    }
    if (/^ {0,3}(=+|-+)[ \t]*\n?$/.test(line) && output.length) {
      const previous = output.at(-1);
      if (previous.trim() && !previous.startsWith('    ')) {
        output[output.length - 1] = `${line.includes('=') ? '# ' : '## '}${previous.trim()}\n`;
        continue;
      }
    }
    output.push(line);
  }
  return output.join('');
}

export function promoteStoredHeadings(source) {
  return normalizeSetextHeadings(String(source));
}

export function demoteVisibleHeadings(source) {
  return normalizeSetextHeadings(String(source));
}

/** Canonical content used by editors, diffs, and revision hashes. */
export function normalizeVisibleRootText(source) {
  return promoteStoredHeadings(String(source).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')).trim();
}

export function splitRootSeparator(content, lineEnding = '\n') {
  if (content.startsWith(lineEnding)) return { separator: lineEnding, body: content.slice(lineEnding.length) };
  if (lineEnding === '\r\n' && content.startsWith('\n')) return { separator: '\n', body: content.slice(1) };
  return { separator: '', body: content };
}

export function projectRoot(project, name) {
  const root = project.roots[name];
  if (!root) return null;
  const { separator, body } = splitRootSeparator(root.content, project.lineEnding);
  return {
    name,
    text: name === 'STORY' || name === 'METADATA'
      ? normalizeVisibleRootText(body)
      : body.trim(),
    separator,
    sourceFrom: root.contentFrom + separator.length,
    sourceTo: root.contentTo,
  };
}
