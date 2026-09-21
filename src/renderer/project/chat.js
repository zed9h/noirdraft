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

/** Exact source ranges for the compact INPUT/OUTPUT turns, used only for an
 * explicit author-confirmed deletion. Surrounding free-form CHAT Markdown is
 * left byte-for-byte alone. */
export function findChatTurnRanges(chat) {
  const source = String(chat);
  const matcher = /\{\{\[INPUT\]\}\}\s*\r?\n([\s\S]*?)\r?\n?\{\{\[OUTPUT\]\}\}\s*\r?\n([\s\S]*?)(?=\r?\n?\{\{\[INPUT\]\}\}|$)/g;
  const ranges = [];
  let match;
  while ((match = matcher.exec(source))) ranges.push({ from: match.index, to: match.index + match[0].length });
  return ranges;
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

/** The stored INPUT is the complete model packet; CHAT shows only the author’s
 * current request when it was composed by NoirDraft. Old handwritten turns
 * remain untouched and display as-is. */
export function displayChatInput(input) {
  const value = String(input);
  try {
    const packet = JSON.parse(value);
    return typeof packet.request === 'string' ? packet.request.trim() : value;
  } catch {
    const request = value.match(/<noirdraft_turn>[\s\S]*?<request><!\[CDATA\[([\s\S]*?)\]\]><\/request>[\s\S]*?<\/noirdraft_turn>/)?.[1];
    return request ? request.replaceAll(']]]]><![CDATA[>', ']]>').trim() : value;
  }
}

/** Structured agent output keeps tool calls out of the reading transcript;
 * the unmodified stored OUTPUT remains available from the AGENT header. */
export function displayChatOutput(output) {
  const value = String(output);
  const records = value.split('\n').map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  const native = records.at(-1)?.choices?.[0]?.message?.content;
  if (typeof native === 'string') return native;
  return value;
}
