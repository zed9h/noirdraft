import path from 'node:path';

const TIMESTAMP_SUFFIX = /_\d{8}_\d{6}$/;

function pad(value, length = 2) {
  return String(value).padStart(length, '0');
}

export function formatSaveTimestamp(date) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * The stem a new timestamped save name is based on, with any prior
 * `_yyyymmdd_HHMMSS` suffix stripped. The opened (or previously saved) file
 * name only supplies this base; it never stacks suffixes across saves.
 */
export function baseStemFor(filePath) {
  const extension = path.extname(filePath);
  const stem = path.basename(filePath, extension);
  return stem.replace(TIMESTAMP_SUFFIX, '');
}

export function timestampedSavePathFor(filePath, date = new Date()) {
  const extension = path.extname(filePath);
  const directory = path.dirname(filePath);
  const stem = baseStemFor(filePath);
  return path.join(directory, `${stem}_${formatSaveTimestamp(date)}${extension}`);
}
