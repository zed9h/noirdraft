export const RESERVED_ROOTS = Object.freeze(['STORY', 'VERSIONS', 'CHAT', 'METADATA']);

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

/** The sole on-disk text representation: UTF-8 decoded, BOM-free, LF-delimited. */
export function normalizeProjectSource(source) {
  return String(source).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
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

export function findTopLevelHeadings(source) {
  const text = normalizeProjectSource(source);
  const headings = [];
  let fence = null;
  const lines = lineRecords(text);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (fence) {
      if (closesFence(line.text, fence)) fence = null;
      continue;
    }
    const opening = fenceStart(line.text);
    if (opening) {
      fence = opening;
      continue;
    }
    const underline = lines[index + 1];
    if (!underline || !/^ {0,3}=+[ \t]*\n?$/.test(underline.text)) continue;
    const name = line.text.replace(/\n$/, '').trim();
    if (!name) continue;
    headings.push({ name, from: line.from, to: underline.to, source: text.slice(line.from, underline.to) });
    index += 1;
  }
  return headings;
}

export function parseProjectDocument(source) {
  const text = normalizeProjectSource(source);
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
    lineEnding: '\n',
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
