import { composeContext } from './context.js';
import { KoboldError } from './kobold.js';
import { commitRevision, reconstructRevision } from '../history/graph.js';
import { hashStory } from '../history/hash.js';

export class AgentError extends Error {
  constructor(message, { code, cause, rawText } = {}) {
    super(message, { cause });
    this.name = 'AgentError';
    this.code = code;
    this.rawText = rawText;
  }
}

/**
 * Streams a bounded rewrite of `range` in an exact root revision. This never
 * mutates the checked-out root: on success the result is materialized as an
 * agent-origin sibling revision from the exact base
 * (`setCurrent: false`), so multiple proposals from one base survive as
 * preserved branches even when none of them is ever checked out. On failure,
 * the raw generated text is preserved on the thrown AgentError and no
 * revision is created at all.
 */
export async function requestRewrite({
  client,
  history,
  baseRevisionId,
  range,
  root = 'STORY',
  contextStoryText,
  request,
  metadataText = '',
  pins = [],
  references = [],
  agentProtocol,
  generationOptions = {},
  onToken,
  signal,
}) {
  const baseText = await reconstructRevision(history, baseRevisionId);
  const [from, to] = range;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to > baseText.length) {
    throw new AgentError('The selected range is invalid for its base revision.', { code: 'INVALID_RANGE' });
  }
  const target = baseText.slice(from, to);
  const composed = composeContext({
    storyText: contextStoryText ?? (root === 'STORY' ? baseText : ''),
    metadataText,
    pins,
    references,
    before: baseText.slice(0, from),
    target,
    after: baseText.slice(to),
    request,
    agentProtocol,
  });

  let generated = '';
  try {
    for await (const token of client.generateStream({ prompt: composed.prompt, ...generationOptions }, { signal })) {
      generated += token;
      onToken?.(generated);
    }
  } catch (cause) {
    if (cause?.name === 'AbortError') {
      throw new AgentError('Generation was cancelled.', { code: 'ABORTED', cause, rawText: generated });
    }
    throw new AgentError('KoboldCpp generation failed.', {
      code: cause instanceof KoboldError ? cause.code : 'GENERATE_FAILED',
      cause,
      rawText: generated,
    });
  }

  const replacement = generated.trim();
  if (replacement === '') {
    throw new AgentError('KoboldCpp returned an empty proposal.', { code: 'EMPTY_RESPONSE', rawText: generated });
  }

  const proposedText = `${baseText.slice(0, from)}${replacement}${baseText.slice(to)}`;
  const revision = await commitRevision(history, baseText, proposedText, {
    origin: 'agent',
    parentId: baseRevisionId,
    setCurrent: false,
    note: null,
  });
  return {
    revision,
    generated: replacement,
    prompt: composed.prompt,
    unresolvedPins: composed.unresolvedPins,
    anchor: { root, baseRevisionId, range: [from, to], targetHash: await hashStory(target), before: baseText.slice(Math.max(0, from - 400), from), after: baseText.slice(to, to + 400) },
  };
}
