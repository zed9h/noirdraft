import { applyUnifiedDiff, createUnifiedDiff } from './diff.js';
import { hashStory } from './hash.js';

export class HistoryError extends Error {
  constructor(message, { code, revisionId, cause } = {}) {
    super(message, { cause });
    this.name = 'HistoryError';
    this.code = code;
    this.revisionId = revisionId;
  }
}

export async function createHistory(initialStory, options = {}) {
  const story = String(initialStory);
  const resultHash = await hashStory(story);
  const revision = {
    id: 0,
    parents: [],
    origin: options.origin ?? 'import',
    timestamp: options.timestamp ?? new Date().toISOString(),
    baseHash: resultHash,
    resultHash,
    note: options.note ?? 'Imported initial STORY state.',
    payloadType: 'checkpoint',
    payload: story,
  };
  return {
    currentRevision: 0,
    checkpointInterval: options.checkpointInterval ?? 50,
    revisions: new Map([[0, revision]]),
  };
}

export function nextRevisionId(history) {
  return Math.max(-1, ...history.revisions.keys()) + 1;
}

export function childrenOf(history, revisionId) {
  return [...history.revisions.values()]
    .filter(({ parents }) => parents.includes(revisionId))
    .sort((left, right) => left.id - right.id);
}

export async function reconstructRevision(history, revisionId, cache = new Map(), visiting = new Set()) {
  if (cache.has(revisionId)) return cache.get(revisionId);
  if (visiting.has(revisionId)) {
    throw new HistoryError(`Revision cycle detected at ${revisionId}.`, { code: 'REVISION_CYCLE', revisionId });
  }
  const revision = history.revisions.get(revisionId);
  if (!revision) throw new HistoryError(`Missing revision ${revisionId}.`, { code: 'MISSING_REVISION', revisionId });
  visiting.add(revisionId);
  let story;
  if (revision.payloadType === 'checkpoint') {
    if (revision.parents.length > 1) {
      throw new HistoryError(`Checkpoint revision ${revisionId} has too many parents.`, {
        code: 'INVALID_PARENT_COUNT', revisionId,
      });
    }
    if (revision.parents.length === 1) {
      const parentStory = await reconstructRevision(history, revision.parents[0], cache, visiting);
      if (await hashStory(parentStory) !== revision.baseHash) {
        throw new HistoryError(`Base hash mismatch for checkpoint ${revisionId}.`, {
          code: 'BASE_HASH_MISMATCH', revisionId,
        });
      }
    }
    story = revision.payload;
  } else {
    if (revision.parents.length !== 1) {
      throw new HistoryError(`Patch revision ${revisionId} must have exactly one parent.`, {
        code: 'INVALID_PARENT_COUNT', revisionId,
      });
    }
    const parentStory = await reconstructRevision(history, revision.parents[0], cache, visiting);
    const parentHash = await hashStory(parentStory);
    if (parentHash !== revision.baseHash) {
      throw new HistoryError(`Base hash mismatch for revision ${revisionId}.`, { code: 'BASE_HASH_MISMATCH', revisionId });
    }
    try {
      story = applyUnifiedDiff(parentStory, revision.payload);
    } catch (cause) {
      throw new HistoryError(`Patch application failed for revision ${revisionId}.`, {
        code: 'PATCH_FAILED', revisionId, cause,
      });
    }
  }
  const resultHash = await hashStory(story);
  if (resultHash !== revision.resultHash) {
    throw new HistoryError(`Result hash mismatch for revision ${revisionId}.`, { code: 'RESULT_HASH_MISMATCH', revisionId });
  }
  visiting.delete(revisionId);
  cache.set(revisionId, story);
  return story;
}

export async function commitRevision(history, baseStory, resultStory, options = {}) {
  const before = String(baseStory);
  const after = String(resultStory);
  if (before === after) return null;
  const parentId = options.parentId ?? history.currentRevision;
  const parentStory = await reconstructRevision(history, parentId);
  if (parentStory !== before) {
    throw new HistoryError('Commit base does not equal its parent STORY state.', {
      code: 'COMMIT_BASE_MISMATCH', revisionId: parentId,
    });
  }
  const id = nextRevisionId(history);
  const checkpoint = options.checkpoint ?? (id % history.checkpointInterval === 0);
  const revision = {
    id,
    parents: [parentId],
    origin: options.origin ?? 'user',
    timestamp: options.timestamp ?? new Date().toISOString(),
    baseHash: await hashStory(before),
    resultHash: await hashStory(after),
    note: options.note ?? null,
    payloadType: checkpoint ? 'checkpoint' : 'patch',
    payload: checkpoint ? after : createUnifiedDiff(before, after),
  };
  history.revisions.set(id, revision);
  history.currentRevision = id;
  return revision;
}

export async function verifyCurrentStory(history, story) {
  const recorded = await reconstructRevision(history, history.currentRevision);
  const actualHash = await hashStory(String(story));
  const expectedHash = history.revisions.get(history.currentRevision).resultHash;
  return {
    matches: actualHash === expectedHash && recorded === String(story),
    expectedHash,
    actualHash,
    recordedStory: recorded,
    externalStory: String(story),
  };
}

export async function recordExternalEdit(history, externalStory, options = {}) {
  const recordedStory = await reconstructRevision(history, history.currentRevision);
  if (recordedStory === String(externalStory)) return null;
  return commitRevision(history, recordedStory, String(externalStory), {
    origin: options.origin ?? 'recovery',
    timestamp: options.timestamp,
    note: options.note ?? 'Recorded externally edited STORY.',
  });
}
