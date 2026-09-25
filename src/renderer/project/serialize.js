import { RESERVED_ROOTS } from './parse.js';
import { demoteVisibleHeadings, endWithEmptyRow, splitRootSeparator } from './projection.js';

function normalizedReplacements(replacements) {
  return replacements instanceof Map ? replacements : new Map(Object.entries(replacements ?? {}));
}

function appendRoot(output, name, visibleValue, lineEnding) {
  const rowRoot = name === 'STORY' || name === 'METADATA';
  const visible = rowRoot ? endWithEmptyRow(demoteVisibleHeadings(String(visibleValue))) : String(visibleValue).trim();
  if (output && !output.endsWith(lineEnding)) output += lineEnding;
  return `${output}${name}${lineEnding}${'='.repeat(name.length)}${lineEnding}${lineEnding}${visible}${rowRoot && visible ? '' : lineEnding}`;
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
    const rowRoot = segment.name === 'STORY' || segment.name === 'METADATA';
    const last = index === project.segments.length - 1;
    let stored = rowRoot ? endWithEmptyRow(demoteVisibleHeadings(visible)) : visible.trim();
    // STORY and METADATA already end with their empty row; the others end with one line break.
    // A blank line separates a root from the heading that follows it.
    if (stored && !rowRoot) stored += project.lineEnding;
    else if (stored && !last) stored += project.lineEnding;
    output += segment.headingSource + (separator || project.lineEnding) + stored;
  }

  for (const name of pending) {
    output = appendRoot(output, name, changes.get(name), project.lineEnding);
  }
  return output;
}
