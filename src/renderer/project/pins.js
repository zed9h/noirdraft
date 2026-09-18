import { extractHeadings, resolveHeadingPath } from './headings.js';

const applicationPath = 'METADATA/Application';
const contextPath = 'METADATA/Application/Context';

function lineEndingOf(source) {
  return source.match(/\r\n|\n/)?.[0] ?? '\n';
}

export function readPins(metadata) {
  const context = extractHeadings(metadata, 'METADATA').find(({ path }) => path === contextPath);
  if (!context) return [];
  const body = metadata.slice(context.headingTo, context.to);
  return body.split(/\r?\n/)
    .map((line) => line.match(/^\s*[-*+]\s+(.+?)\s*$/)?.[1] ?? null)
    .filter(Boolean);
}

export function writePins(metadata, pins) {
  const source = String(metadata);
  const eol = lineEndingOf(source);
  const unique = [...new Set(pins.map(String))];
  const list = unique.map((path) => `- ${path}${eol}`).join('');
  const headings = extractHeadings(source, 'METADATA');
  const context = headings.find(({ path }) => path === contextPath);
  if (context) return source.slice(0, context.headingTo) + list + source.slice(context.to);

  const application = headings.find(({ path }) => path === applicationPath);
  if (application) {
    const insertion = `${eol}## Context${eol}${eol}${list}`;
    return source.slice(0, application.to) + insertion + source.slice(application.to);
  }

  const separator = source === '' || source.endsWith(eol + eol)
    ? ''
    : source.endsWith(eol) ? eol : eol + eol;
  return `${source}${separator}# Application${eol}${eol}## Context${eol}${eol}${list}`;
}

export function resolvePins(metadata, documents) {
  return readPins(metadata).map((path) => resolveHeadingPath(documents, path));
}
