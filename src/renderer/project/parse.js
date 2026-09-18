export const RESERVED_ROOTS = Object.freeze(['STORY', 'METADATA', 'CHAT', 'VERSIONS']);

export class ProjectDocumentError extends Error {
  constructor(message, { code, root, offsets = [], project = null } = {}) {
    super(message);
    this.name = 'ProjectDocumentError';
    this.code = code;
    this.root = root;
    this.offsets = offsets;
    this.project = project;
  }
}

function lineRecords(source) {
  const records = [];
  let from = 0;
  while (from < source.length) {
    const newline = source.indexOf('\n', from);
    const to = newline === -1 ? source.length : newline + 1;
    records.push({ from, to, text: source.slice(from, to) });
    from = to;
  }
  return records;
}

function fenceStart(line) {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})/);
  return match ? { character: match[1][0], length: match[1].length } : null;
}

function closesFence(line, fence) {
  const marker = fence.character === '`' ? '`' : '~';
  return new RegExp(`^ {0,3}${marker}{${fence.length},}[ \\t]*(?:\\r?\\n)?$`).test(line);
}

function h1Name(line) {
  const match = line.match(/^ {0,3}#(?:[ \t]+)(.*?)(?:\r?\n)?$/);
  if (!match) return null;
  const withoutClosing = match[1].replace(/[ \t]+#+[ \t]*$/, '');
  return withoutClosing.trim();
}

export function findTopLevelHeadings(source) {
  const headings = [];
  let fence = null;
  for (const line of lineRecords(source)) {
    if (fence) {
      if (closesFence(line.text, fence)) fence = null;
      continue;
    }
    const opening = fenceStart(line.text);
    if (opening) {
      fence = opening;
      continue;
    }
    const name = h1Name(line.text);
    if (name !== null) headings.push({ name, from: line.from, to: line.to, source: line.text });
  }
  return headings;
}

function detectLineEnding(source) {
  const match = source.match(/\r\n|\n/);
  return match?.[0] ?? '\n';
}

export function parseProjectDocument(source) {
  const text = String(source);
  const headings = findTopLevelHeadings(text);
  const segments = [];
  if (headings.length === 0) {
    segments.push({ type: 'preamble', from: 0, to: text.length, source: text });
  } else {
    if (headings[0].from > 0) {
      segments.push({ type: 'preamble', from: 0, to: headings[0].from, source: text.slice(0, headings[0].from) });
    }
    for (let index = 0; index < headings.length; index += 1) {
      const heading = headings[index];
      const to = headings[index + 1]?.from ?? text.length;
      segments.push({
        type: 'root',
        name: heading.name,
        reserved: RESERVED_ROOTS.includes(heading.name),
        from: heading.from,
        to,
        headingFrom: heading.from,
        headingTo: heading.to,
        contentFrom: heading.to,
        contentTo: to,
        headingSource: heading.source,
        content: text.slice(heading.to, to),
        source: text.slice(heading.from, to),
      });
    }
  }

  const roots = Object.fromEntries(RESERVED_ROOTS.map((name) => [name, null]));
  const duplicates = new Map();
  for (const segment of segments) {
    if (segment.type !== 'root' || !segment.reserved) continue;
    if (roots[segment.name]) {
      const occurrences = duplicates.get(segment.name) ?? [roots[segment.name]];
      occurrences.push(segment);
      duplicates.set(segment.name, occurrences);
    } else {
      roots[segment.name] = segment;
    }
  }

  const project = {
    source: text,
    lineEnding: detectLineEnding(text),
    segments,
    roots,
    unknownRoots: segments.filter((segment) => segment.type === 'root' && !segment.reserved),
  };
  if (duplicates.size > 0) {
    const [root, occurrences] = duplicates.entries().next().value;
    throw new ProjectDocumentError(
      `Duplicate reserved root # ${root} at source offsets ${occurrences.map(({ from }) => from).join(', ')}.`,
      { code: 'DUPLICATE_RESERVED_ROOT', root, offsets: occurrences.map(({ from }) => from), project },
    );
  }
  return project;
}
