import { resolveHeadingPath } from '../project/headings.js';

export class ContextBudgetError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'ContextBudgetError';
    this.code = code;
  }
}

function cdata(value) {
  return String(value).replaceAll(']]>', ']]]]><![CDATA[>');
}

function xmlElement(name, value, attributes = '') {
  return `<${name}${attributes}><![CDATA[${cdata(value)}]]></${name}>`;
}

export function sliceContextRows(source, from, to, rows = 12) {
  const text = String(source);
  const count = Math.max(1, Math.floor(Number(rows) || 1));
  const before = text.slice(0, from).split(/\r?\n/).slice(-count).join('\n');
  const after = text.slice(to).split(/\r?\n/).slice(0, count).join('\n');
  return { before, target: text.slice(from, to), after };
}

/**
 * Composes the explicit, clearly delimited context packet described in
 * PLAN.md §19: resolved references, story context around the target, the
 * target itself, the author's request, and the agent protocol. Nothing here
 * is implicit — unresolved pins are reported rather than silently dropped or
 * retargeted, and chat history / rejected variants are never pulled in
 * automatically; a caller must pass them explicitly as `references`.
 */
export function composeContext({
  storyText,
  metadataText = '',
  pins = [],
  references = [],
  before = '',
  target = '',
  after = '',
  request = '',
  agentProtocol = '',
  chatHistory = [],
}) {
  const documents = { STORY: storyText, METADATA: metadataText };
  const resolvedPins = [];
  const unresolvedPins = [];
  for (const path of pins) {
    const result = resolveHeadingPath(documents, path);
    if (result.status === 'resolved') resolvedPins.push(result);
    else unresolvedPins.push(result);
  }

  // Keep the cacheable instruction and project reference prefix stable. The
  // volatile editing packet is a single JSON tool result, built below.
  const components = [
    { id: 'protocol', label: 'AGENT PROTOCOL', text: agentProtocol },
    ...resolvedPins.map((pin) => ({ id: `pin:${pin.path}`, label: `REFERENCE ${pin.path}`, text: pin.text })),
    ...references.map((reference, index) => ({
      id: reference.id ?? `reference:${index}`,
      label: `REFERENCE ${reference.label ?? reference.id ?? `#${index + 1}`}`,
      text: reference.text,
    })),
    { id: 'before', label: 'CONTEXT BEFORE CURSOR', text: before },
    { id: 'cursor', label: 'CURSOR', text: target },
    { id: 'after', label: 'CONTEXT AFTER CURSOR', text: after },
    { id: 'request', label: 'REQUEST', text: request },
  ].filter((component) => component.text !== '' && component.text != null);

  const staticReferences = components
    .filter((component) => component.id.startsWith('pin:') || component.id.startsWith('reference:'))
    .map((component) => xmlElement('reference', component.text, ` label="${component.label.replaceAll('"', '&quot;')}"`))
    .join('\n');
  const staticPrompt = [
    '<noirdraft_static>',
    xmlElement('instructions', agentProtocol),
    staticReferences ? `<pinned_context>\n${staticReferences}\n</pinned_context>` : '',
    '</noirdraft_static>',
  ].filter(Boolean).join('\n');
  const history = chatHistory.length
    ? `<noirdraft_chat_history>\n${chatHistory.map((turn, index) => [
      `<turn index="${index + 1}">`,
      xmlElement('request', turn.request),
      xmlElement('reply', turn.reply),
      '</turn>',
    ].join('\n')).join('\n')}\n</noirdraft_chat_history>`
    : '';
  const turnPrompt = [
    history,
    '<noirdraft_turn>',
    '<document_context>',
    xmlElement('before', before),
    xmlElement(target ? 'selection' : 'cursor', target),
    xmlElement('after', after),
    '</document_context>',
    xmlElement('request', request),
    '</noirdraft_turn>',
  ].filter(Boolean).join('\n');
  return { components, staticPrompt, turnPrompt, prompt: `${staticPrompt}\n\n${turnPrompt}`, unresolvedPins };
}

/**
 * Allocates the server-reported context window across composed components,
 * reserving space for generation. `countTokens` may be async (e.g. the real
 * KoboldCpp token-count endpoint) or a synchronous deterministic estimator
 * for tests; this never guesses a tokenizer itself.
 */
export async function allocateContextBudget(components, { contextLength, reservedGeneration = 0, countTokens }) {
  if (!Number.isFinite(contextLength)) {
    throw new ContextBudgetError('A context length is required to allocate a budget.', { code: 'MISSING_CONTEXT_LENGTH' });
  }
  const available = contextLength - reservedGeneration;
  const usage = [];
  let total = 0;
  for (const component of components) {
    const tokens = await countTokens(component.text);
    usage.push({ id: component.id, label: component.label, tokens });
    total += tokens;
  }
  return {
    usage,
    total,
    available,
    reservedGeneration,
    contextLength,
    fits: total <= available,
    overBy: Math.max(0, total - available),
  };
}
