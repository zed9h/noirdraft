export class KoboldError extends Error {
  constructor(message, { code, cause, rawText = null, status = null } = {}) {
    super(message, { cause });
    this.status = status;
    this.name = 'KoboldError';
    this.code = code;
    this.rawText = rawText;
  }
}

const STATUS_HINTS = new Map([
  [400, 'the server rejected the request as invalid'],
  [401, 'the API key was missing or rejected; set it under More → OpenAI API…'],
  [403, 'access was denied; check that the API key is allowed to use this model'],
  [404, 'the endpoint or model was not found; check the API address and selected model'],
  [408, 'the server timed out'],
  [413, 'the request was too large for the server'],
  [429, 'the server is rate limiting or busy; retry shortly'],
]);

function serverDetail(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  try {
    const body = JSON.parse(text);
    const found = body?.error?.message ?? body?.error ?? body?.detail ?? body?.message;
    if (typeof found === 'string') return found.trim();
    if (found !== undefined) return JSON.stringify(found);
  } catch {
    // Not JSON: fall through to the literal text.
  }
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/** A failed HTTP response, worded by cause (authorization, missing model, server fault…). */
function httpFailure(what, response, raw, code) {
  const hint = STATUS_HINTS.get(response.status) ?? (response.status >= 500 ? 'the server reported an internal error' : 'the server refused the request');
  const detail = serverDetail(raw);
  return new KoboldError(`${what} failed (HTTP ${response.status}): ${hint}.${detail ? ` Server said: ${detail}` : ''}`, { code, rawText: raw, status: response.status });
}

/** The server could not be contacted at all: wrong address, server down, or network. */
function unreachable(what, baseUrl, cause) {
  const reason = cause?.cause?.code ?? cause?.cause?.message ?? cause?.message;
  return new KoboldError(`${what} failed: could not connect to the AI server at ${baseUrl}${reason ? ` (${reason})` : ''}. Check that it is running and the address is right.`, { code: 'UNAVAILABLE', cause });
}

const SUPPORTED_MODEL = /gemma|gemini/i;

/** OpenAI-compatible `usage` (prompt_tokens/completion_tokens), when a server reports it; undefined otherwise. */
function readUsage(body) {
  const usage = body?.usage;
  return Number.isFinite(usage?.prompt_tokens) ? { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens ?? null } : undefined;
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
  constructor(baseUrl, { fetch: fetchImpl = globalThis.fetch.bind(globalThis), apiKey = '', model = '' } = {}) {
    this.model = String(model ?? '').trim() || 'koboldcpp';
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.fetch = fetchImpl;
    this.apiKey = String(apiKey ?? '').trim();
  }

  #headers() {
    return this.apiKey
      ? { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` }
      : { 'Content-Type': 'application/json' };
  }

  async checkAvailability() {
    try {
      // Only this cheap probe has a timeout: generation calls may legitimately
      // spend minutes processing a large prompt before the first byte.
      const response = await this.fetch(`${this.baseUrl}/api/v1/model`, { headers: this.#headers(), signal: AbortSignal.timeout(4000) });
      if (!response.ok) return { available: false };
      const body = await response.json();
      return { available: true, model: typeof body.result === 'string' ? body.result : null };
    } catch {
      return { available: false };
    }
  }

  /** Model ids offered by the OpenAI-compatible /v1/models listing; [] when unavailable. */
  async listModels() {
    try {
      const response = await this.fetch(`${this.baseUrl}/v1/models`, { headers: this.#headers(), signal: AbortSignal.timeout(4000) });
      if (!response.ok) return [];
      const body = await response.json();
      return (Array.isArray(body?.data) ? body.data : []).map((entry) => entry?.id).filter((id) => typeof id === 'string' && SUPPORTED_MODEL.test(id));
    } catch {
      return [];
    }
  }

  /** Config files KoboldCpp can switch to; [] unless it runs with --admin and --admindir. */
  async listAdminConfigs() {
    try {
      const response = await this.fetch(`${this.baseUrl}/api/admin/list_options`, { headers: this.#headers(), signal: AbortSignal.timeout(4000) });
      if (!response.ok) return [];
      const body = await response.json();
      return Array.isArray(body) ? body.filter((name) => typeof name === 'string' && SUPPORTED_MODEL.test(name)) : [];
    } catch {
      return [];
    }
  }

  /** Asks KoboldCpp to restart with another config. The server goes away while
   * it reloads, so callers watch checkAvailability() to learn when it is back. */
  async reloadConfig(filename) {
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}/api/admin/reload_config`, {
        method: 'POST', headers: this.#headers(), body: JSON.stringify({ filename }),
      });
    } catch (cause) {
      throw unreachable('Switching models', this.baseUrl, cause);
    }
    if (!response.ok) throw httpFailure('Switching models', response, await response.text().catch(() => ''), 'RELOAD_FAILED');
  }

  async fetchContextLength() {
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}/api/v1/config/max_context_length`, { headers: this.#headers() });
    } catch (cause) {
      throw unreachable('Reading the context length', this.baseUrl, cause);
    }
    if (!response.ok) throw httpFailure('Reading the context length', response, await response.text().catch(() => ''), 'CONTEXT_LENGTH_FAILED');
    const body = await this.#readJSON(response);
    const value = Number(body.value);
    if (!Number.isFinite(value)) throw new KoboldError('The AI server returned a malformed context length.', { code: 'MALFORMED_RESPONSE' });
    return value;
  }

  async countTokens(prompt) {
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}/api/extra/tokencount`, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify({ prompt: String(prompt) }),
      });
    } catch (cause) {
      throw unreachable('Counting tokens', this.baseUrl, cause);
    }
    if (!response.ok) throw httpFailure('Counting tokens', response, await response.text().catch(() => ''), 'TOKEN_COUNT_FAILED');
    const body = await this.#readJSON(response);
    const value = Number(body.value);
    if (!Number.isFinite(value)) throw new KoboldError('The AI server returned a malformed token count.', { code: 'MALFORMED_RESPONSE' });
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
        headers: this.#headers(),
        body: JSON.stringify(request),
        signal,
      });
    } catch (cause) {
      if (cause?.name === 'AbortError') throw cause;
      throw unreachable('Generation', this.baseUrl, cause);
    }
    if (!response.ok || !response.body) {
      throw httpFailure('Generation', response, await response.text().catch(() => ''), 'GENERATE_FAILED');
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
        headers: this.#headers(),
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
      const payload = { model: this.model, messages, max_tokens: maxTokens, temperature };
      if (tools.length > 0) {
        payload.tools = tools;
        payload.tool_choice = toolChoice;
      }
      response = await this.fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST', headers: this.#headers(),
        body: JSON.stringify(payload), signal,
      });
    } catch (cause) {
      if (cause?.name === 'AbortError') throw cause;
      throw unreachable('The chat request', this.baseUrl, cause);
    }
    let raw;
    try {
      raw = await response.text();
    } catch (cause) {
      throw new KoboldError('The AI server returned an unreadable chat response.', { code: 'MALFORMED_RESPONSE', cause });
    }
    if (!response.ok) throw httpFailure('The chat request', response, raw, 'CHAT_COMPLETION_FAILED');
    let body;
    try {
      body = JSON.parse(raw);
    } catch (cause) {
      throw new KoboldError('The AI server returned a malformed chat response.', { code: 'MALFORMED_RESPONSE', cause, rawText: raw });
    }
    const choice = body?.choices?.[0];
    const message = choice?.message;
    if (!message || !Array.isArray(message.tool_calls ?? [])) throw new KoboldError('The AI server returned a malformed chat response.', { code: 'MALFORMED_RESPONSE', rawText: raw });
    return { message, finishReason: choice.finish_reason ?? null, raw, usage: readUsage(body) };
  }

  /** Streams an ordinary OpenAI-compatible chat reply when the server offers
   * SSE. A non-streaming response is still decoded as one final event, which
   * keeps older KoboldCpp builds usable without changing the chat protocol. */
  async *chatCompletionStream({ messages, maxTokens = 200, temperature = 0, signal }) {
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST', headers: this.#headers(),
        body: JSON.stringify({ model: this.model, messages, max_tokens: maxTokens, temperature, stream: true }), signal,
      });
    } catch (cause) {
      if (cause?.name === 'AbortError') throw cause;
      throw unreachable('The chat request', this.baseUrl, cause);
    }
    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      throw httpFailure('The chat request', response, raw, 'CHAT_COMPLETION_FAILED');
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream') || !response.body) {
      const raw = await response.text();
      let body;
      try { body = JSON.parse(raw); } catch (cause) { throw new KoboldError('The AI server returned a malformed chat response.', { code: 'MALFORMED_RESPONSE', cause, rawText: raw }); }
      const choice = body?.choices?.[0];
      const message = choice?.message;
      if (!message || typeof message.content !== 'string') throw new KoboldError('The AI server returned a malformed chat response.', { code: 'MALFORMED_RESPONSE', rawText: raw });
      yield { text: message.content, raw, done: true, finishReason: choice.finish_reason ?? null, usage: readUsage(body) };
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let raw = '';
    let usage;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        raw += chunk;
        buffer += chunk;
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const record = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = record.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('');
          if (data === '[DONE]') {
            yield { text: '', raw, done: true, finishReason: 'stop', usage };
          } else if (data) {
            try {
              const event = JSON.parse(data);
              usage = readUsage(event) ?? usage;
              const choice = event?.choices?.[0];
              yield { text: typeof choice?.delta?.content === 'string' ? choice.delta.content : '', raw, done: Boolean(choice?.finish_reason), finishReason: choice?.finish_reason ?? null, usage: choice?.finish_reason ? usage : undefined };
            } catch {
              // Ignore malformed individual SSE records; later records may remain valid.
            }
          }
          boundary = buffer.indexOf('\n\n');
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  async #readJSON(response) {
    try {
      return await response.json();
    } catch (cause) {
      throw new KoboldError('The AI server returned a malformed response.', { code: 'MALFORMED_RESPONSE', cause });
    }
  }
}
