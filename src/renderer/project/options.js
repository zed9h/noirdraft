import { readApplicationList, writeApplicationList } from './application.js';

// Project-level options stored as `- key: value` bullets under
// `# Application` → `## Options`; values are booleans or integers.
const definitions = {
  autoNotes: { type: 'boolean', fallback: false },
  saveTimestampedCopies: { type: 'boolean', fallback: true },
  saveOnEveryRevision: { type: 'boolean', fallback: false },
  chatHistoryMessages: { type: 'integer', fallback: 6, min: 0 },
  contextRows: { type: 'integer', fallback: 12, min: 1, max: 200 },
};

export const OPTION_DEFAULTS = Object.freeze(Object.fromEntries(
  Object.entries(definitions).map(([key, { fallback }]) => [key, fallback]),
));

/** Returns only the options the project explicitly stores. */
export function readOptions(metadata) {
  const stored = {};
  for (const item of readApplicationList(metadata, 'Options')) {
    const match = item.match(/^([A-Za-z]+):\s*(.+)$/);
    const definition = match && definitions[match[1]];
    if (!definition) continue;
    if (definition.type === 'boolean') {
      if (match[2] === 'true' || match[2] === 'false') stored[match[1]] = match[2] === 'true';
    } else if (/^\d+$/.test(match[2])) {
      const value = Number(match[2]);
      if (value >= definition.min && value <= (definition.max ?? Infinity)) stored[match[1]] = value;
    }
  }
  return stored;
}

export function writeOptions(metadata, patch) {
  const merged = { ...readOptions(metadata) };
  for (const [key, value] of Object.entries(patch)) if (key in definitions) merged[key] = value;
  return writeApplicationList(metadata, 'Options', Object.keys(definitions)
    .filter((key) => key in merged)
    .map((key) => `${key}: ${merged[key]}`));
}
