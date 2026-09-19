function lineEndingOf(source) {
  return String(source).match(/\r\n|\n/)?.[0] ?? '\n';
}

function appendSeparated(source, addition, eol) {
  if (!source) return addition;
  if (source.endsWith(eol + eol)) return source + addition;
  if (source.endsWith(eol)) return source + eol + addition;
  return source + eol + eol + addition;
}

export function appendConversation(chat, title) {
  const source = String(chat);
  const eol = lineEndingOf(source);
  return appendSeparated(source, `# ${String(title).trim()}${eol}`, eol);
}

export function appendChatMessage(chat, role, message) {
  if (!['User', 'Agent'].includes(role)) throw new TypeError(`Unsupported chat participant ${role}.`);
  const source = String(chat);
  const eol = lineEndingOf(source);
  const addition = `## ${role}${eol}${eol}${String(message)}${String(message).endsWith(eol) ? '' : eol}`;
  return appendSeparated(source, addition, eol);
}

/**
 * The compact chat format understood by KoboldCpp and easy to repair in any
 * text editor.  We deliberately keep parsing permissive: surrounding notes
 * remain in the file, while only complete INPUT/OUTPUT blocks become turns.
 */
export function parseChatTurns(chat) {
  const source = String(chat).replaceAll('\r\n', '\n');
  const matcher = /\{\{\[INPUT\]\}\}\s*\n([\s\S]*?)\n?\{\{\[OUTPUT\]\}\}\s*\n([\s\S]*?)(?=\n?\{\{\[INPUT\]\}\}|$)/g;
  const turns = [];
  let match;
  while ((match = matcher.exec(source))) {
    turns.push({ input: match[1].replace(/\n+$/, ''), output: match[2].replace(/\n+$/, '') });
  }
  return turns;
}

export function appendChatTurn(chat, input, output) {
  const source = String(chat);
  const eol = lineEndingOf(source);
  const addition = [
    '{{[INPUT]}}',
    String(input).trim(),
    '{{[OUTPUT]}}',
    String(output).trim(),
  ].join(eol);
  return appendSeparated(source, addition, eol);
}
