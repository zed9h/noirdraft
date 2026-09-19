import { RESERVED_ROOTS } from './parse.js';
import { demoteVisibleHeadings, splitRootSeparator } from './projection.js';

function normalizedReplacements(replacements) {
  return replacements instanceof Map ? replacements : new Map(Object.entries(replacements ?? {}));
}

export function serializeProjectDocument(project, replacements = new Map()) {
  const changes = normalizedReplacements(replacements);
  if (changes.size === 0) return project.source;
  for (const name of changes.keys()) {
    if (!RESERVED_ROOTS.includes(name)) throw new TypeError(`Cannot replace unknown project root ${name}.`);
  }

  let output = '';
  const written = new Set();
  for (let index = 0; index < project.segments.length; index += 1) {
    const segment = project.segments[index];
    if (segment.type !== 'root' || !segment.reserved || !changes.has(segment.name)) {
      output += segment.source;
      continue;
    }
    const visible = String(changes.get(segment.name));
    const { separator } = splitRootSeparator(segment.content, project.lineEnding);
    let stored = demoteVisibleHeadings(visible);
    if (index < project.segments.length - 1 && stored && !stored.endsWith(project.lineEnding)) {
      stored += project.lineEnding;
    }
    output += segment.headingSource + (separator || project.lineEnding) + stored;
    written.add(segment.name);
  }

  for (const [name, visibleValue] of changes) {
    if (written.has(name)) continue;
    const visible = String(visibleValue);
    if (output && !output.endsWith(project.lineEnding)) output += project.lineEnding;
    output += `# ${name}${project.lineEnding}${project.lineEnding}${demoteVisibleHeadings(visible)}`;
  }
  return output;
}
