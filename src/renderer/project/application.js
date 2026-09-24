import { extractHeadings } from './headings.js';

const applicationPath = 'METADATA/Application';

function lineEndingOf(source) {
  return source.match(/\r\n|\n/)?.[0] ?? '\n';
}

/** Bullet items under `# Application` → `## <section>` in METADATA. */
export function readApplicationList(metadata, section) {
  const path = `${applicationPath}/${section}`;
  const heading = extractHeadings(metadata, 'METADATA').find((candidate) => candidate.path === path);
  if (!heading) return [];
  return metadata.slice(heading.headingTo, heading.to).split(/\r?\n/)
    .map((line) => line.match(/^\s*[-*+]\s+(.+?)\s*$/)?.[1] ?? null)
    .filter(Boolean);
}

/**
 * Replaces the bullet list of `## <section>`, creating the section (and
 * `# Application`) when missing. A blank line always separates the heading
 * from the list, even if an earlier edit trimmed it away.
 */
export function writeApplicationList(metadata, section, items) {
  const source = String(metadata);
  const eol = lineEndingOf(source);
  const list = items.map((item) => `- ${item}${eol}`).join('');
  const headings = extractHeadings(source, 'METADATA');
  const existing = headings.find(({ path }) => path === `${applicationPath}/${section}`);
  if (existing) {
    let head = source.slice(0, existing.headingTo);
    if (!head.endsWith(eol)) head += eol;
    if (list && !head.endsWith(eol + eol)) head += eol;
    return head + list + source.slice(existing.to);
  }

  const application = headings.find(({ path }) => path === applicationPath);
  if (application) {
    let head = source.slice(0, application.to);
    if (head.endsWith(eol) === false) head += eol;
    if (!head.endsWith(eol + eol)) head += eol;
    return `${head}## ${section}${eol}${eol}${list}${source.slice(application.to)}`;
  }

  const separator = source === '' || source.endsWith(eol + eol)
    ? ''
    : source.endsWith(eol) ? eol : eol + eol;
  return `${source}${separator}# Application${eol}${eol}## ${section}${eol}${eol}${list}`;
}
