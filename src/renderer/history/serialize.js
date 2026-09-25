import { HistoryError } from './graph.js';

const origins = new Set(['user', 'agent', 'import', 'recovery', 'system']);

function fenceFor(payload) {
  const longest = Math.max(0, ...([...payload.matchAll(/`+/g)].map((match) => match[0].length)));
  return '`'.repeat(Math.max(3, longest + 1));
}

function serializeRevision(revision, headingPrefix = '#') {
  const fence = fenceFor(revision.payload);
  const language = revision.payloadType === 'checkpoint' ? 'markdown' : 'diff';
  const parents = revision.parents.length ? revision.parents.join(', ') : 'none';
  const note = revision.note === null ? 'null' : JSON.stringify(revision.note);
  const payloadSeparator = revision.payload.endsWith('\n') ? '' : '\n';
  return [
    `${headingPrefix} Revision ${revision.id}\n\n`,
    `Parents: ${parents}\n`,
    `Origin: ${revision.origin}\n`,
    `Time: ${revision.timestamp}\n`,
    `Base-Hash: ${revision.baseHash}\n`,
    `Result-Hash: ${revision.resultHash}\n`,
    `Note: ${note}\n`,
    `Payload-Length: ${revision.payload.length}\n\n`,
    `${fence}${language}\n`,
    revision.payload,
    payloadSeparator,
    `${fence}\n`,
  ].join('');
}

export function serializeHistory(history, { revisionHeadingLevel = 1 } = {}) {
  if (!Number.isInteger(revisionHeadingLevel) || revisionHeadingLevel < 1 || revisionHeadingLevel > 6) {
    throw new TypeError('revisionHeadingLevel must be an integer between 1 and 6.');
  }
  const revisions = [...history.revisions.values()].sort((left, right) => left.id - right.id);
  return [
    `Current-Revision: ${history.currentRevision}\n`,
    `Checkpoint-Interval: ${history.checkpointInterval}\n\n`,
    revisions.map((revision) => serializeRevision(revision, '#'.repeat(revisionHeadingLevel))).join('\n'),
  ].join('');
}

function findHeadingsAtLevel(source, level) {
  const pattern = new RegExp(`^( {0,3})#{${level}}(?!#)[ \\t]+(.*?)(?:\\r?\\n|$)`, 'gm');
  const headings = [];
  let fence = null;
  let lineStart = 0;
  for (const lineMatch of String(source).matchAll(/.*(?:\r\n|\n|$)/g)) {
    const line = lineMatch[0];
    if (line === '' && lineStart === source.length) break;
    if (fence) {
      if (new RegExp(`^ {0,3}${fence.char}{${fence.length},}[ \\t]*(?:\\r?\\n)?$`).test(line)) fence = null;
    } else {
      const opening = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (opening) fence = { char: opening[1][0], length: opening[1].length };
      else {
        pattern.lastIndex = 0;
        const match = pattern.exec(line);
        if (match) headings.push({ name: match[2].trim(), from: lineStart, to: lineStart + line.length });
      }
    }
    lineStart += line.length;
  }
  return headings;
}

function requiredField(metadata, name, revisionId) {
  const match = metadata.match(new RegExp(`^${name}: (.+)$`, 'm'));
  if (!match) throw new HistoryError(`Revision ${revisionId} is missing ${name}.`, { code: 'MALFORMED_HISTORY', revisionId });
  return match[1];
}

function parsePayload(section, revisionId, length) {
  const opening = section.match(/^(`{3,})(markdown|diff)\r?$/m);
  if (!opening) throw new HistoryError(`Revision ${revisionId} has no fenced payload.`, { code: 'MALFORMED_HISTORY', revisionId });
  const fence = opening[1];
  const payloadType = opening[2] === 'markdown' ? 'checkpoint' : 'patch';
  const start = opening.index + opening[0].length + (section[opening.index + opening[0].length] === '\r' ? 2 : 1);
  const rest = section.slice(start);
  const closeMatch = rest.match(new RegExp(`^${fence}[ \\t]*(?:\\r?\\n|$)`, 'm'));
  if (!closeMatch || closeMatch.index < length) {
    throw new HistoryError(`Revision ${revisionId} has a malformed payload fence.`, { code: 'MALFORMED_HISTORY', revisionId });
  }
  return { payloadType, payload: rest.slice(0, length), metadata: section.slice(0, opening.index) };
}

export function parseHistory(source, { revisionHeadingLevel = 1 } = {}) {
  const text = String(source);
  const currentMatch = text.match(/^Current-Revision: (\d+)$/m);
  const intervalMatch = text.match(/^Checkpoint-Interval: (\d+)$/m);
  if (!currentMatch || !intervalMatch || Number(intervalMatch[1]) < 1) {
    throw new HistoryError('VERSIONS header is missing or malformed.', { code: 'MALFORMED_HISTORY' });
  }
  const headings = findHeadingsAtLevel(text, revisionHeadingLevel)
    .map((heading) => ({ ...heading, match: heading.name.match(/^Revision (\d+)$/) }))
    .filter(({ match }) => match);
  const revisions = new Map();
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const id = Number(heading.match[1]);
    if (revisions.has(id)) throw new HistoryError(`Duplicate revision ${id}.`, { code: 'DUPLICATE_REVISION', revisionId: id });
    const end = headings[index + 1]?.from ?? text.length;
    const section = text.slice(heading.to, end);
    const lengthText = requiredField(section, 'Payload-Length', id);
    const length = Number(lengthText);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new HistoryError(`Revision ${id} has invalid Payload-Length.`, { code: 'MALFORMED_HISTORY', revisionId: id });
    }
    const parsedPayload = parsePayload(section, id, length);
    const parentsText = requiredField(parsedPayload.metadata, 'Parents', id);
    const parents = parentsText === 'none'
      ? []
      : parentsText.split(',').map((value) => Number(value.trim()));
    if (parents.some((parent) => !Number.isSafeInteger(parent) || parent < 0)) {
      throw new HistoryError(`Revision ${id} has malformed parents.`, { code: 'MALFORMED_HISTORY', revisionId: id });
    }
    const origin = requiredField(parsedPayload.metadata, 'Origin', id);
    if (!origins.has(origin)) throw new HistoryError(`Revision ${id} has unknown origin.`, { code: 'MALFORMED_HISTORY', revisionId: id });
    const timestamp = requiredField(parsedPayload.metadata, 'Time', id);
    if (Number.isNaN(Date.parse(timestamp))) throw new HistoryError(`Revision ${id} has invalid time.`, { code: 'MALFORMED_HISTORY', revisionId: id });
    const baseHash = requiredField(parsedPayload.metadata, 'Base-Hash', id);
    const resultHash = requiredField(parsedPayload.metadata, 'Result-Hash', id);
    if (!/^[a-f0-9]{64}$/.test(baseHash) || !/^[a-f0-9]{64}$/.test(resultHash)) {
      throw new HistoryError(`Revision ${id} has malformed hashes.`, { code: 'MALFORMED_HISTORY', revisionId: id });
    }
    let note;
    try {
      note = JSON.parse(requiredField(parsedPayload.metadata, 'Note', id));
    } catch (cause) {
      throw new HistoryError(`Revision ${id} has malformed note JSON.`, { code: 'MALFORMED_HISTORY', revisionId: id, cause });
    }
    if (note !== null && typeof note !== 'string') {
      throw new HistoryError(`Revision ${id} note must be a string or null.`, { code: 'MALFORMED_HISTORY', revisionId: id });
    }
    revisions.set(id, {
      id, parents, origin, timestamp, baseHash, resultHash, note,
      payloadType: parsedPayload.payloadType,
      payload: parsedPayload.payload,
    });
  }
  const currentRevision = Number(currentMatch[1]);
  if (!revisions.has(currentRevision)) {
    throw new HistoryError(`Current revision ${currentRevision} is missing.`, {
      code: 'MISSING_CURRENT_REVISION', revisionId: currentRevision,
    });
  }
  for (const revision of revisions.values()) {
    for (const parent of revision.parents) {
      if (!revisions.has(parent)) throw new HistoryError(`Revision ${revision.id} has missing parent ${parent}.`, { code: 'MISSING_PARENT', revisionId: revision.id });
    }
  }
  return {
    currentRevision,
    checkpointInterval: Number(intervalMatch[1]),
    revisions,
  };
}

const ROOTS = Object.freeze(['STORY', 'METADATA']);

/**
 * Serializes the two independently recoverable document graphs in the one
 * canonical visible VERSIONS format.
 */
export function serializeHistories(histories) {
  const groups = ROOTS.filter((root) => histories?.[root]);
  if (groups.length === 0) throw new TypeError('At least one root history is required.');
  return groups.map((root) => `${root}:REV\n${'-'.repeat(root.length + 4)}\n\n${serializeHistory(histories[root], { revisionHeadingLevel: 2 })}`).join('\n');
}

export function parseHistories(source) {
  const text = String(source);
  const lines = [...text.matchAll(/.*(?:\n|$)/g)];
  const groups = [];
  let offset = 0;
  for (let index = 0; index < lines.length - 1; index += 1) {
    const title = lines[index][0];
    const underline = lines[index + 1][0];
    const match = title.replace(/\n$/, '').trim().match(/^(STORY|METADATA):REV$/);
    if (match && /^ {0,3}-+[ \t]*\n?$/.test(underline)) {
      groups.push({ root: match[1], from: offset, to: offset + title.length + underline.length });
      index += 1;
      offset += title.length + underline.length;
      continue;
    }
    offset += title.length;
  }
  const histories = { STORY: null, METADATA: null, legacy: false };
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    if (histories[group.root]) throw new HistoryError(`Duplicate ${group.root}:REV group.`, { code: 'DUPLICATE_HISTORY_ROOT' });
    const end = groups[index + 1]?.from ?? text.length;
    histories[group.root] = parseHistory(text.slice(group.to, end), { revisionHeadingLevel: 2 });
  }
  if (!histories.STORY || !histories.METADATA) throw new HistoryError('VERSIONS must contain STORY:REV and METADATA:REV.', { code: 'MISSING_HISTORY_ROOT' });
  return histories;
}
