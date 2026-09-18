import { findTopLevelHeadings } from '../project/parse.js';
import { HistoryError } from './graph.js';

const origins = new Set(['user', 'agent', 'import', 'recovery', 'system']);

function fenceFor(payload) {
  const longest = Math.max(0, ...([...payload.matchAll(/`+/g)].map((match) => match[0].length)));
  return '`'.repeat(Math.max(3, longest + 1));
}

function serializeRevision(revision) {
  const fence = fenceFor(revision.payload);
  const language = revision.payloadType === 'checkpoint' ? 'markdown' : 'diff';
  const parents = revision.parents.length ? revision.parents.join(', ') : 'none';
  const note = revision.note === null ? 'null' : JSON.stringify(revision.note);
  const payloadSeparator = revision.payload.endsWith('\n') ? '' : '\n';
  return [
    `# Revision ${revision.id}\n\n`,
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

export function serializeHistory(history) {
  const revisions = [...history.revisions.values()].sort((left, right) => left.id - right.id);
  return [
    `Current-Revision: ${history.currentRevision}\n`,
    `Checkpoint-Interval: ${history.checkpointInterval}\n\n`,
    revisions.map(serializeRevision).join('\n'),
  ].join('');
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

export function parseHistory(source) {
  const text = String(source);
  const currentMatch = text.match(/^Current-Revision: (\d+)$/m);
  const intervalMatch = text.match(/^Checkpoint-Interval: (\d+)$/m);
  if (!currentMatch || !intervalMatch || Number(intervalMatch[1]) < 1) {
    throw new HistoryError('VERSIONS header is missing or malformed.', { code: 'MALFORMED_HISTORY' });
  }
  const headings = findTopLevelHeadings(text)
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
