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
