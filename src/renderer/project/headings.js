import { scanMarkdownBlocks } from '../editor/markdown-scan.js';

function titleFromBlock(source, block) {
  const line = source.slice(block.from, block.to).replace(/\r?\n$/, '');
  const withoutPrefix = line.replace(/^ {0,3}#{1,5}[ \t]+/, '');
  return withoutPrefix.replace(/[ \t]+#+[ \t]*$/, '').trim();
}

export function extractHeadings(source, rootName) {
  const headings = scanMarkdownBlocks(source)
    .filter((block) => block.type === 'heading')
    .map((block) => ({
      level: block.level,
      title: titleFromBlock(source, block),
      from: block.from,
      headingTo: block.to,
      to: source.length,
      path: '',
      children: [],
    }));

  const stack = [];
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    while (stack.length && stack.at(-1).level >= heading.level) stack.pop();
    const parent = stack.at(-1) ?? null;
    heading.path = [rootName, ...stack.map(({ title }) => title), heading.title].join('/');
    if (parent) parent.children.push(heading);
    stack.push(heading);

    for (let previous = index - 1; previous >= 0; previous -= 1) {
      if (headings[previous].to !== source.length) continue;
      if (headings[previous].level >= heading.level) headings[previous].to = heading.from;
    }
  }
  return headings;
}

export function headingTree(source, rootName) {
  return extractHeadings(source, rootName).filter((heading) => {
    const parentPath = heading.path.slice(0, heading.path.lastIndexOf('/'));
    return parentPath === rootName;
  });
}

export function resolveHeadingPath(documents, path) {
  const [rootName] = String(path).split('/');
  const source = documents[rootName];
  if (typeof source !== 'string') return { status: 'unresolved', path };
  const matches = extractHeadings(source, rootName).filter((heading) => heading.path === path);
  if (matches.length === 0) return { status: 'unresolved', path };
  if (matches.length > 1) return { status: 'ambiguous', path, matches };
  const heading = matches[0];
  return {
    status: 'resolved',
    path,
    heading,
    text: source.slice(heading.from, heading.to),
  };
}
