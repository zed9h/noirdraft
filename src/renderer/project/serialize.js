import { RESERVED_ROOTS } from './parse.js';
import { demoteVisibleHeadings, splitRootSeparator } from './projection.js';

function normalizedReplacements(replacements) {
  return replacements instanceof Map ? replacements : new Map(Object.entries(replacements ?? {}));
}

function appendRoot(output, name, visibleValue, lineEnding) {
  const visible = (name === 'STORY' || name === 'METADATA'
    ? demoteVisibleHeadings(String(visibleValue)).trim()
    : String(visibleValue).trim());
  if (output && !output.endsWith(lineEnding)) output += lineEnding;
  return `${output}${name}${lineEnding}${'='.repeat(name.length)}${lineEnding}${lineEnding}${visible}${lineEnding}`;
}

export function serializeProjectDocument(project, replacements = new Map()) {
  const changes = normalizedReplacements(replacements);
  if (changes.size === 0) return project.source;
  for (const name of changes.keys()) {
    if (!RESERVED_ROOTS.includes(name)) throw new TypeError(`Cannot replace unknown project root ${name}.`);
  }

  let output = '';
  const pending = RESERVED_ROOTS.filter((name) => changes.has(name) && !project.roots[name]);
  const writePendingBefore = (name) => {
    const position = RESERVED_ROOTS.indexOf(name);
    while (pending.length && RESERVED_ROOTS.indexOf(pending[0]) < position) {
      const pendingName = pending.shift();
      output = appendRoot(output, pendingName, changes.get(pendingName), project.lineEnding);
    }
  };
  for (let index = 0; index < project.segments.length; index += 1) {
    const segment = project.segments[index];
    if (segment.type === 'root' && segment.reserved) writePendingBefore(segment.name);
    if (segment.type !== 'root' || !segment.reserved || !changes.has(segment.name)) {
      output += segment.source;
      continue;
    }
    const visible = String(changes.get(segment.name));
    const { separator } = splitRootSeparator(segment.content, project.lineEnding);
    let stored = (segment.name === 'STORY' || segment.name === 'METADATA'
      ? demoteVisibleHeadings(visible).trim()
      : visible.trim());
    if (index < project.segments.length - 1 && stored && !stored.endsWith(project.lineEnding)) {
      stored += project.lineEnding;
    }
    output += segment.headingSource + (separator || project.lineEnding) + stored + (stored && index === project.segments.length - 1 ? project.lineEnding : '');
  }

  for (const name of pending) {
    output = appendRoot(output, name, changes.get(name), project.lineEnding);
  }
  return output;
}
