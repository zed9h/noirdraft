import { createUnifiedDiff } from '../history/diff.js';

export class NoteError extends Error {
  constructor(message, { code, cause } = {}) {
    super(message, { cause });
    this.name = 'NoteError';
    this.code = code;
  }
}

const DEFAULT_NOTE_PROTOCOL = 'Write one concise, neutral sentence describing this change. Describe it; do not judge its quality. Reply with only that sentence.';

/**
 * Generates a short, neutral commit note from only the change itself: origin,
 * the relevant unified diff, and optionally affected heading paths. This is
 * deliberately narrow (PLAN.md §32) — never the whole manuscript — and is
 * always called after a revision already exists durably; it must never gate
 * or delay the commit itself.
 */
export async function generateNote({ client, origin, parentText, resultText, affectedPaths = [], agentProtocol = DEFAULT_NOTE_PROTOCOL, signal }) {
  const diff = createUnifiedDiff(String(parentText), String(resultText));
  if (diff === '') throw new NoteError('There is no change to describe.', { code: 'NO_CHANGE' });

  const prompt = [
    `ORIGIN: ${origin}`,
    affectedPaths.length ? `AFFECTED: ${affectedPaths.join(', ')}` : null,
    'DIFF:',
    diff,
    '',
    agentProtocol,
    '',
    'NOTE:',
  ].filter((line) => line !== null).join('\n');

  let text = '';
  try {
    for await (const token of client.generateStream({ prompt, max_length: 60 }, { signal })) text += token;
  } catch (cause) {
    if (cause?.name === 'AbortError') throw cause;
    throw new NoteError('KoboldCpp note generation failed.', { code: cause?.code ?? 'GENERATE_FAILED', cause });
  }

  const note = text.trim().split('\n')[0].trim();
  if (note === '') throw new NoteError('KoboldCpp returned an empty note.', { code: 'EMPTY_NOTE' });
  return note;
}
