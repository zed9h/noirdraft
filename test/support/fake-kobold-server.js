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
  const chatRequests = [];

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
      chatRequests.push(payload);
      if (payload.stream === true && !payload.tools?.length) {
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        let index = 0;
        const timer = setInterval(() => {
          if (index >= tokens.length) {
            clearInterval(timer);
            response.write('data: [DONE]\n\n');
            response.end();
            return;
          }
          response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: tokens[index] }, finish_reason: null }] })}\n\n`);
          index += 1;
        }, tokenDelayMs);
        response.on('close', () => clearInterval(timer));
        return;
      }
      const replacements = toolCalls ?? (tokens.join('') ? [tokens.join('')] : []);
      const contextResult = payload.messages?.find((message) => message.role === 'user')?.content ?? '';
      const isGreeting = contextResult.includes('Say hello.');
      const toolMessages = payload.messages?.filter((message) => message.role === 'tool') ?? [];
      const lastTool = toolMessages.at(-1)?.content ?? '';
      const revisionIds = [...lastTool.matchAll(/----- REVISION #(\d+) -----/g)].map((match) => Number(match[1]));
      const call = (name, argumentsObject, index = 1) => ({ id: `call_${toolMessages.length + 1}_${index}`, type: 'function', function: { name, arguments: JSON.stringify(argumentsObject) } });
      const calls = (...items) => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: items } }] });
      const reply = !payload.tools?.length
        ? { choices: [{ message: { role: 'assistant', content: tokens.join(''), tool_calls: [] }, finish_reason: 'stop' }] }
        : toolMessages.length === 0
        ? isGreeting
          ? calls(call('draft_chat', { message: tokens.join('') }))
          : calls(call('propose_changes', { intent: 'Provide each requested replacement as a distinct sibling.', alternative_count: replacements.length, proposals: replacements.map((text) => ({ text })) }))
        : isGreeting
        ? calls(call('approve_chat', {}))
        : lastTool.includes('NOIRDRAFT CHANGE REVIEW') && revisionIds.length
        ? calls(call('review_changes', { set_overview: 'The proposals are grammatical and appropriate in context.', reviews: revisionIds.map((revision_id) => ({ revision_id, copyedit: { sentence_integrity: true, mechanics: true, clarity: true, style: true }, comment: 'Grammatical and appropriate in context.', verdict: 'approve' })) }))
        : lastTool.includes('NOIRDRAFT PROGRESS')
        ? calls(call('finish_changes', {}))
        : lastTool.includes('NOIRDRAFT CHANGE SET COMPLETE')
        ? calls(call('draft_chat', { message: 'Done.' }))
        : calls(call('approve_chat', {}));
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
        getChatRequests: () => chatRequests,
      });
    });
  });
}
