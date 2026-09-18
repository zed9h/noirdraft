export class ProjectionError extends Error {
  constructor(message, { code, offset } = {}) {
    super(message);
    this.name = 'ProjectionError';
    this.code = code;
    this.offset = offset;
  }
}

function mapHeadingLevels(source, direction) {
  const output = [];
  let offset = 0;
  let fence = null;
  const linePattern = /.*(?:\r\n|\n|$)/g;
  for (const match of source.matchAll(linePattern)) {
    const line = match[0];
    if (line === '' && offset === source.length) break;
    if (fence) {
      const closePattern = new RegExp(`^ {0,3}${fence.character === '`' ? '`' : '~'}{${fence.length},}[ \\t]*(?:\\r?\\n)?$`);
      if (closePattern.test(line)) fence = null;
      output.push(line);
      offset += line.length;
      continue;
    }
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (opening) {
      fence = { character: opening[1][0], length: opening[1].length };
      output.push(line);
      offset += line.length;
      continue;
    }
    const heading = line.match(/^( {0,3})(#{1,6})(?=[ \t]|\r?$)/);
    if (!heading) {
      output.push(line);
      offset += line.length;
      continue;
    }
    const level = heading[2].length;
    if (direction === 'demote' && level === 6) {
      throw new ProjectionError('Visible H6 cannot be stored beneath a reserved H1 root.', {
        code: 'UNSUPPORTED_VISIBLE_H6',
        offset: offset + heading[1].length,
      });
    }
    if (direction === 'promote' && level === 1) {
      output.push(line);
      offset += line.length;
      continue;
    }
    const hashes = direction === 'promote' ? '#'.repeat(level - 1) : '#'.repeat(level + 1);
    output.push(heading[1] + hashes + line.slice(heading[0].length));
    offset += line.length;
  }
  return output.join('');
}

export function promoteStoredHeadings(source) {
  return mapHeadingLevels(String(source), 'promote');
}

export function demoteVisibleHeadings(source) {
  return mapHeadingLevels(String(source), 'demote');
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
    text: promoteStoredHeadings(body),
    separator,
    sourceFrom: root.contentFrom + separator.length,
    sourceTo: root.contentTo,
  };
}
