import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_PREFERENCES = Object.freeze({
  koboldUrl: 'http://localhost:5001',
  autoNotes: false,
  chatHistoryMessages: 6,
  contextRows: 12,
  generationDefaults: Object.freeze({
    max_length: 200,
    temperature: 0.7,
  }),
});

function mergePreferences(base, patch) {
  return {
    ...base,
    ...patch,
    generationDefaults: {
      ...base.generationDefaults,
      ...(patch?.generationDefaults ?? {}),
    },
  };
}

/**
 * Machine-global application preferences (server URL, generation defaults,
 * and similar host/window settings) live outside the manuscript, in the
 * Electron user-data directory rather than in project METADATA.
 */
export async function readPreferences(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8');
    return mergePreferences(DEFAULT_PREFERENCES, JSON.parse(raw));
  } catch (error) {
    if (error.code === 'ENOENT') return { ...DEFAULT_PREFERENCES };
    return { ...DEFAULT_PREFERENCES };
  }
}

export async function writePreferences(filePath, patch) {
  const current = await readPreferences(filePath);
  const next = mergePreferences(current, patch);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(next, null, 2), 'utf8');
  return next;
}
