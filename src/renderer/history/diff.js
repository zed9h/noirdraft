export class PatchError extends Error {
  constructor(message, { code, line } = {}) {
    super(message);
    this.name = 'PatchError';
    this.code = code;
    this.line = line;
  }
}

function sourceLines(source) {
  const lines = [];
  let from = 0;
  while (from < source.length) {
    const newline = source.indexOf('\n', from);
    const to = newline === -1 ? source.length : newline + 1;
    lines.push(source.slice(from, to));
    from = to;
  }
  return lines;
}

function same(left, right) {
  return left === right;
}

function appendPatchLine(parts, prefix, line) {
  parts.push(prefix, line);
  if (!line.endsWith('\n')) parts.push('\n\\ No newline at end of file\n');
}

export function createUnifiedDiff(before, after, contextSize = 3) {
  const oldLines = sourceLines(String(before));
  const newLines = sourceLines(String(after));
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && same(oldLines[prefix], newLines[prefix])) prefix += 1;
  if (prefix === oldLines.length && prefix === newLines.length) return '';
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && same(oldLines[oldLines.length - 1 - suffix], newLines[newLines.length - 1 - suffix])
  ) suffix += 1;

  const oldFrom = Math.max(0, prefix - contextSize);
  const newFrom = Math.max(0, prefix - contextSize);
  const oldChangedTo = oldLines.length - suffix;
  const newChangedTo = newLines.length - suffix;
  const oldTo = Math.min(oldLines.length, oldChangedTo + contextSize);
  const newTo = Math.min(newLines.length, newChangedTo + contextSize);
  const oldCount = oldTo - oldFrom;
  const newCount = newTo - newFrom;
  const oldStart = oldCount === 0 ? 0 : oldFrom + 1;
  const newStart = newCount === 0 ? 0 : newFrom + 1;
  const parts = [`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n`];

  for (let index = oldFrom; index < prefix; index += 1) appendPatchLine(parts, ' ', oldLines[index]);
  for (let index = prefix; index < oldChangedTo; index += 1) appendPatchLine(parts, '-', oldLines[index]);
  for (let index = prefix; index < newChangedTo; index += 1) appendPatchLine(parts, '+', newLines[index]);
  for (let index = 0; index < Math.min(contextSize, suffix); index += 1) {
    appendPatchLine(parts, ' ', oldLines[oldChangedTo + index]);
  }
  return parts.join('');
}

function patchRecords(patch) {
  const records = [];
  let from = 0;
  while (from < patch.length) {
    const newline = patch.indexOf('\n', from);
    const to = newline === -1 ? patch.length : newline + 1;
    records.push(patch.slice(from, to));
    from = to;
  }
  return records;
}

function decodeEntry(records, index) {
  const record = records[index];
  const prefix = record[0];
  if (![' ', '+', '-'].includes(prefix)) return null;
  let value = record.slice(1);
  if (records[index + 1] === '\\ No newline at end of file\n') {
    if (value.endsWith('\n')) value = value.slice(0, -1);
    return { prefix, value, consumed: 2 };
  }
  return { prefix, value, consumed: 1 };
}

export function applyUnifiedDiff(before, patch) {
  if (patch === '') return String(before);
  const base = sourceLines(String(before));
  const records = patchRecords(String(patch));
  const header = records[0]?.match(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@\n$/);
  if (!header) throw new PatchError('Malformed unified diff header.', { code: 'MALFORMED_HEADER', line: 1 });
  const oldStart = Number(header[1]);
  const oldCount = Number(header[2]);
  const newCount = Number(header[4]);
  const startIndex = oldCount === 0 ? oldStart : oldStart - 1;
  if (startIndex < 0 || startIndex > base.length) throw new PatchError('Patch starts outside base.', { code: 'RANGE' });

  const output = base.slice(0, startIndex);
  let baseIndex = startIndex;
  let consumedOld = 0;
  let producedNew = 0;
  for (let index = 1; index < records.length;) {
    const entry = decodeEntry(records, index);
    if (!entry) throw new PatchError(`Malformed patch record at line ${index + 1}.`, { code: 'MALFORMED_RECORD', line: index + 1 });
    if (entry.prefix === ' ' || entry.prefix === '-') {
      if (base[baseIndex] !== entry.value) {
        throw new PatchError(`Patch base mismatch at source line ${baseIndex + 1}.`, {
          code: 'BASE_MISMATCH',
          line: baseIndex + 1,
        });
      }
      if (entry.prefix === ' ') output.push(entry.value);
      baseIndex += 1;
      consumedOld += 1;
    }
    if (entry.prefix === '+') output.push(entry.value);
    if (entry.prefix === ' ' || entry.prefix === '+') producedNew += 1;
    index += entry.consumed;
  }
  if (consumedOld !== oldCount || producedNew !== newCount) {
    throw new PatchError('Patch hunk counts do not match its header.', { code: 'COUNT_MISMATCH' });
  }
  output.push(...base.slice(baseIndex));
  return output.join('');
}
