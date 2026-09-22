import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { normalizeProjectSource, parseProjectDocument, ProjectDocumentError } from '../renderer/project/parse.js';
import { writeBackup } from './backups.js';
import { timestampedSavePathFor } from './timestamped-save-path.js';

export class FilePersistenceError extends Error {
  constructor(message, { code, filePath, cause, currentFingerprint, currentContents } = {}) {
    super(message, { cause });
    this.name = 'FilePersistenceError';
    this.code = code;
    this.filePath = filePath;
    this.currentFingerprint = currentFingerprint;
    this.currentContents = currentContents;
  }
}

export function hashText(contents) {
  return createHash('sha256').update(normalizeProjectSource(contents), 'utf8').digest('hex');
}

async function fingerprint(filePath, contents = null) {
  const [metadata, source] = await Promise.all([
    stat(filePath),
    contents === null ? readFile(filePath, 'utf8').then(normalizeProjectSource) : normalizeProjectSource(contents),
  ]);
  return { size: metadata.size, mtimeMs: metadata.mtimeMs, hash: hashText(source) };
}

export async function readDocument(filePath) {
  const contents = normalizeProjectSource(await readFile(filePath, 'utf8'));
  return { filePath, contents, fingerprint: await fingerprint(filePath, contents) };
}

/**
 * The path a timestamped save should target: the preferred `base_yyyymmdd_HHMMSS.ext`
 * name, or a disambiguated sibling if two saves land on the same second.
 */
export async function uniqueTimestampedSavePath(filePath, now = new Date()) {
  const preferred = timestampedSavePathFor(filePath, now);
  const extension = path.extname(preferred);
  const stem = extension ? preferred.slice(0, -extension.length) : preferred;
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const candidate = attempt === 0 ? preferred : `${stem}_${attempt + 1}${extension}`;
    try {
      await stat(candidate);
    } catch (error) {
      if (error.code === 'ENOENT') return candidate;
      throw error;
    }
  }
  throw new Error(`Could not allocate a unique timestamped save name for ${filePath}.`);
}

export async function hasExternalChange(filePath, expectedFingerprint) {
  if (!expectedFingerprint) return false;
  try {
    const current = await fingerprint(filePath);
    return current.hash !== expectedFingerprint.hash;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}

export function validateProjectSource(contents) {
  let project;
  try {
    project = parseProjectDocument(contents);
  } catch (error) {
    if (error instanceof ProjectDocumentError) {
      throw new FilePersistenceError(error.message, { code: 'INVALID_PROJECT_STRUCTURE', cause: error });
    }
    throw error;
  }
  if (!project.roots.STORY) {
    throw new FilePersistenceError('A NoirDraft document must contain exactly one STORY root.', {
      code: 'MISSING_STORY_ROOT',
    });
  }
  return project;
}

async function writeAndFlush(filePath, contents) {
  const handle = await open(filePath, 'wx');
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function replaceFile(temporaryPath, filePath) {
  await rename(temporaryPath, filePath);
}

export async function safeSaveDocument({
  filePath,
  contents,
  expectedFingerprint = null,
  backupDirectory = null,
  now = new Date(),
  operations = {},
}) {
  const source = normalizeProjectSource(contents);
  validateProjectSource(source);
  const writeTemporary = operations.writeTemporary ?? writeAndFlush;
  const replace = operations.replace ?? replaceFile;
  const makeBackup = operations.writeBackup ?? writeBackup;

  let previous = null;
  try {
    previous = await readDocument(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  if (previous && expectedFingerprint && previous.fingerprint.hash !== expectedFingerprint.hash) {
    throw new FilePersistenceError('The document changed on disk after it was opened.', {
      code: 'EXTERNAL_CHANGE',
      filePath,
      currentFingerprint: previous.fingerprint,
      currentContents: previous.contents,
    });
  }

  let backupPath = null;
  if (previous) {
    backupPath = await makeBackup(filePath, previous.contents, { backupDirectory, now });
  }

  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  let temporaryExists = false;
  try {
    await writeTemporary(temporaryPath, source);
    temporaryExists = true;
    await replace(temporaryPath, filePath);
    temporaryExists = false;
    const saved = await readDocument(filePath);
    if (saved.fingerprint.hash !== hashText(source)) {
      throw new FilePersistenceError('Saved document verification failed.', {
        code: 'VERIFY_FAILED',
        filePath,
      });
    }
    return { ...saved, backupPath };
  } catch (error) {
    if (error instanceof FilePersistenceError) throw error;
    throw new FilePersistenceError(`Could not safely save ${filePath}.`, {
      code: 'SAVE_FAILED',
      filePath,
      cause: error,
    });
  } finally {
    if (temporaryExists) await unlink(temporaryPath).catch(() => {});
  }
}
