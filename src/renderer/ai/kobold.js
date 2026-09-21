export class KoboldError extends Error {
  constructor(message, { code, cause, rawText = null } = {}) {
    super(message, { cause });
    this.name = 'KoboldError';
    this.code = code;
    this.rawText = rawText;
  }
}

function parseStreamRecord(record) {
  const dataLines = record
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((line) => line.length > 0);
  if (dataLines.length === 0) return null;
  try {
    const payload = JSON.parse(dataLines.join(''));
    return typeof payload.token === 'string' ? payload.token : null;
  } catch {
    // A malformed SSE record must never crash generation; it is skipped.
    return null;
  }
}

/**
 * A thin client for the native KoboldCpp HTTP API. KoboldCpp is always an
 * optional external process: every method here fails softly (returns an
 * "unavailable"/empty result or throws a typed KoboldError) so a disconnected
 * or misbehaving server can never affect the editor itself.
 */
export class KoboldClient {
  constructor(baseUrl, { fetch: fetchImpl = globalThis.fetch.bind(globalThis) } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.fetch = fetchImpl;
  }

  async checkAvailability() {
    try {
      const response = await this.fetch(`${this.baseUrl}/api/v1/model`);
      if (!response.ok) return { available: false };
      const body = await response.json();
      return { available: true, model: typeof body.result === 'string' ? body.result : null };
    } catch {
      return { available: false };
    }
  }

  async fetchContextLength() {
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}/api/v1/config/max_context_length`);
    } catch (cause) {
      throw new KoboldError('Could not reach KoboldCpp to query the context length.', { code: 'UNAVAILABLE', cause });
    }
    if (!response.ok) throw new KoboldError('KoboldCpp rejected the context-length query.', { code: 'CONTEXT_LENGTH_FAILED' });
    const body = await this.#readJSON(response);
    const value = Number(body.value);
    if (!Number.isFinite(value)) throw new KoboldError('KoboldCpp returned a malformed context length.', { code: 'MALFORMED_RESPONSE' });
    return value;
  }

  async countTokens(prompt) {
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}/api/extra/tokencount`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: String(prompt) }),
      });
    } catch (cause) {
      throw new KoboldError('Could not reach KoboldCpp to count tokens.', { code: 'UNAVAILABLE', cause });
    }
    if (!response.ok) throw new KoboldError('KoboldCpp rejected the token-count request.', { code: 'TOKEN_COUNT_FAILED' });
    const body = await this.#readJSON(response);
    const value = Number(body.value);
    if (!Number.isFinite(value)) throw new KoboldError('KoboldCpp returned a malformed token count.', { code: 'MALFORMED_RESPONSE' });
    return value;
  }

  /**
   * Streams generated text as an async generator of string tokens. Pass an
   * AbortSignal to cancel; malformed individual SSE records are skipped
   * rather than aborting the whole stream.
   */
  async *generateStream(request, { signal } = {}) {
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}/api/extra/generate/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal,
      });
    } catch (cause) {
      if (cause?.name === 'AbortError') throw cause;
      throw new KoboldError('Could not reach KoboldCpp to start generation.', { code: 'UNAVAILABLE', cause });
    }
    if (!response.ok || !response.body) {
      throw new KoboldError('KoboldCpp rejected the generation request.', { code: 'GENERATE_FAILED' });
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const record = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const token = parseStreamRecord(record);
          if (token !== null) yield token;
          boundary = buffer.indexOf('\n\n');
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  async abort(genKey) {
    try {
      await this.fetch(`${this.baseUrl}/api/extra/abort`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ genkey: genKey ?? '' }),
      });
    } catch {
      // Best-effort: if the server is unreachable there is nothing left to abort.
    }
  }

  /** OpenAI-compatible chat completion. When tools are supplied, KoboldCpp
   * applies the loaded model's native tool template and returns tool_calls. */
  async chatCompletion({ messages, tools = [], toolChoice = 'auto', maxTokens = 200, temperature = 0, signal }) {
    let response;
    try {
      const payload = { model: 'koboldcpp', messages, max_tokens: maxTokens, temperature };
      if (tools.length > 0) {
        payload.tools = tools;
        payload.tool_choice = toolChoice;
      }
      response = await this.fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal,
      });
    } catch (cause) {
      if (cause?.name === 'AbortError') throw cause;
      throw new KoboldError('Could not reach KoboldCpp chat completions.', { code: 'UNAVAILABLE', cause });
    }
    let raw;
    try {
      raw = await response.text();
    } catch (cause) {
      throw new KoboldError('KoboldCpp returned an unreadable chat response.', { code: 'MALFORMED_RESPONSE', cause });
    }
    if (!response.ok) throw new KoboldError('KoboldCpp rejected the chat completion.', { code: 'CHAT_COMPLETION_FAILED', rawText: raw });
    let body;
    try {
      body = JSON.parse(raw);
    } catch (cause) {
      throw new KoboldError('KoboldCpp returned a malformed chat response.', { code: 'MALFORMED_RESPONSE', cause, rawText: raw });
    }
    const choice = body?.choices?.[0];
    const message = choice?.message;
    if (!message || !Array.isArray(message.tool_calls ?? [])) throw new KoboldError('KoboldCpp returned a malformed chat response.', { code: 'MALFORMED_RESPONSE', rawText: raw });
    return { message, finishReason: choice.finish_reason ?? null, raw };
  }

  async #readJSON(response) {
    try {
      return await response.json();
    } catch (cause) {
      throw new KoboldError('KoboldCpp returned a malformed response.', { code: 'MALFORMED_RESPONSE', cause });
    }
  }
}
