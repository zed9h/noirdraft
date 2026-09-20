import { createServer } from 'node:http';

/**
 * A deterministic fake KoboldCpp HTTP server for automated tests, so
 * streaming/abort/malformed-response behavior never depends on a real model.
 */
export function startFakeKoboldServer(options = {}) {
  const {
    model = 'fake-model',
    contextLength = 4096,
    tokens = ['Hello', ', ', 'world', '.'],
    tokenDelayMs = 5,
    malformedStream = false,
    malformedJSON = false,
    toolCalls = null,
  } = options;

  const abortedKeys = new Set();
  let lastGenerateRequest = null;

  const server = createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }
    const url = new URL(request.url, 'http://localhost');
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      handle(url, request.method, body, response);
    });
  });

  function sendJSON(response, status, payload) {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(payload === undefined ? '' : JSON.stringify(payload));
  }

  function handle(url, method, body, response) {
    if (method === 'GET' && url.pathname === '/api/v1/model') {
      return sendJSON(response, 200, { result: model });
    }
    if (method === 'GET' && url.pathname === '/api/v1/config/max_context_length') {
      if (malformedJSON) { response.writeHead(200, { 'Content-Type': 'application/json' }); return response.end('{ not json'); }
      return sendJSON(response, 200, { value: contextLength });
    }
    if (method === 'POST' && url.pathname === '/api/extra/tokencount') {
      if (malformedJSON) { response.writeHead(200, { 'Content-Type': 'application/json' }); return response.end('not json at all'); }
      const prompt = JSON.parse(body || '{}').prompt ?? '';
      const value = prompt.split(/\s+/).filter(Boolean).length;
      return sendJSON(response, 200, { value });
    }
    if (method === 'POST' && url.pathname === '/v1/chat/completions') {
      const payload = JSON.parse(body || '{}');
      const replacements = toolCalls ?? (tokens.join('') ? [tokens.join('')] : []);
      const currentPacket = payload.messages?.at(-1)?.content?.slice(payload.messages.at(-1)?.content?.lastIndexOf('<noirdraft_context>')) ?? '';
      const isCursorContext = currentPacket.includes('<insert_here/>');
      const reply = !payload.tools?.length || isCursorContext
        ? { choices: [{ message: { role: 'assistant', content: tokens.join(''), tool_calls: [] }, finish_reason: 'stop' }] }
        : payload.tool_choice === 'none' || payload.messages?.some((message) => message.role === 'tool')
        ? { choices: [{ message: { role: 'assistant', content: 'Done.', tool_calls: [] } }] }
        : { choices: [{ message: {
          role: 'assistant', content: null,
          tool_calls: replacements.map((replacement, index) => ({ id: `call_${index + 1}`, type: 'function', function: { name: 'submit_change', arguments: JSON.stringify({ operation: isCursorContext ? 'insert' : 'replace', text: replacement }) } })),
        } }] };
      if (tokenDelayMs > 0) return setTimeout(() => sendJSON(response, 200, reply), tokenDelayMs);
      return sendJSON(response, 200, reply);
    }
    if (method === 'POST' && url.pathname === '/api/extra/generate/stream') {
      const requestPayload = JSON.parse(body || '{}');
      lastGenerateRequest = requestPayload;
      const genKey = requestPayload.genkey ?? null;
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      let index = 0;
      const timer = setInterval(() => {
        if (genKey && abortedKeys.has(genKey)) {
          clearInterval(timer);
          response.end();
          return;
        }
        if (index >= tokens.length) {
          clearInterval(timer);
          response.end();
          return;
        }
        if (malformedStream && index === 1) {
          response.write('data: { this is not valid json\n\n');
        } else {
          response.write(`data: ${JSON.stringify({ token: tokens[index] })}\n\n`);
        }
        index += 1;
      }, tokenDelayMs);
      response.on('close', () => clearInterval(timer));
      return;
    }
    if (method === 'POST' && url.pathname === '/api/extra/abort') {
      const genKey = JSON.parse(body || '{}').genkey ?? null;
      if (genKey) abortedKeys.add(genKey);
      return sendJSON(response, 200, { success: true });
    }
    sendJSON(response, 404, { error: 'not found' });
  }

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
        getLastGenerateRequest: () => lastGenerateRequest,
      });
    });
  });
}
