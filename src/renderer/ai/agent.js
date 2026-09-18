import { composeContext } from './context.js';
import { KoboldError } from './kobold.js';
import { commitRevision, reconstructRevision } from '../history/graph.js';

export class AgentError extends Error {
  constructor(message, { code, cause, rawText } = {}) {
    super(message, { cause });
    this.name = 'AgentError';
    this.code = code;
    this.rawText = rawText;
  }
}

/**
 * Streams a bounded rewrite of `range` in the exact base revision's STORY
 * text. This never mutates the checked-out STORY: on success the result is
 * materialized as an agent-origin sibling revision from the exact base
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
  request,
  metadataText = '',
  pins = [],
  references = [],
  agentProtocol,
  generationOptions = {},
  onToken,
  signal,
}) {
  const baseStory = await reconstructRevision(history, baseRevisionId);
  const [from, to] = range;
  const composed = composeContext({
    storyText: baseStory,
    metadataText,
    pins,
    references,
    before: baseStory.slice(0, from),
    target: baseStory.slice(from, to),
    after: baseStory.slice(to),
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

  const proposedStory = `${baseStory.slice(0, from)}${replacement}${baseStory.slice(to)}`;
  const revision = await commitRevision(history, baseStory, proposedStory, {
    origin: 'agent',
    parentId: baseRevisionId,
    setCurrent: false,
    note: null,
  });
  return { revision, generated: replacement, prompt: composed.prompt, unresolvedPins: composed.unresolvedPins };
}
