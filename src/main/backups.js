import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';

function timestamp(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

export function backupPathFor(filePath, date = new Date(), backupDirectory = null) {
  const extension = path.extname(filePath);
  const stem = path.basename(filePath, extension);
  const directory = backupDirectory ?? path.join(path.dirname(filePath), 'backup');
  return path.join(directory, `${stem}.${timestamp(date)}${extension}`);
}

export async function writeBackup(filePath, contents, options = {}) {
  const preferred = backupPathFor(filePath, options.now ?? new Date(), options.backupDirectory);
  await mkdir(path.dirname(preferred), { recursive: true });
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const extension = path.extname(preferred);
    const stem = extension ? preferred.slice(0, -extension.length) : preferred;
    const destination = attempt === 0
      ? preferred
      : `${stem}.${attempt}${extension}`;
    let handle;
    try {
      handle = await open(destination, 'wx');
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      throw error;
    }
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    return destination;
  }
  throw new Error(`Could not allocate a unique backup name for ${filePath}.`);
}
