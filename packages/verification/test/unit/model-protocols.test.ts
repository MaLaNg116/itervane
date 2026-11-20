import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { anthropicMessages, createAnthropic, createOpenAI, openaiMessages, privateFetch, safeEndpoint, type ConversationEntry } from '@itervane/model';

describe('model protocol compatibility', () => {
  const entries: ConversationEntry[] = [
    { kind: 'user', text: 'inspect' },
    { kind: 'assistant', turn: { text: '', calls: [{ id: 't1', name: 'inspect', input: {} }], tokenUsage: 0 } },
    { kind: 'observations', observations: [{ callId: 't1', name: 'inspect', output: '{"healthy":true}', isError: false }] },
  ];
  it('preserves call IDs and tool observations in both wire protocols', () => {
    expect(anthropicMessages(entries)[2]).toMatchObject({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] });
    expect(openaiMessages('system', entries)[3]).toMatchObject({ role: 'tool', tool_call_id: 't1', content: '{"healthy":true}' });
  });
  it.each(['anthropic', 'openai'] as const)('uses the official %s SDK against a local protocol fixture', async protocol => {
    let receivedPath = ''; let toolDefined = false; let outputLimit: unknown; let singleTool: unknown;
    const server = createServer(async (req, res) => {
      receivedPath = req.url ?? '';
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const request = JSON.parse(Buffer.concat(chunks).toString()) as {
        tools?: unknown[]; max_tokens?: unknown; max_completion_tokens?: unknown; tool_choice?: unknown; parallel_tool_calls?: unknown;
      };
      toolDefined = request.tools?.length === 1;
      outputLimit = protocol === 'anthropic' ? request.max_tokens : request.max_completion_tokens;
      singleTool = protocol === 'anthropic' ? request.tool_choice : request.parallel_tool_calls;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(protocol === 'anthropic' ? {
        id: 'msg_test', type: 'message', role: 'assistant', model: 'test',
        content: [{ type: 'tool_use', id: 't1', name: 'inspect', input: {} }],
        stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 2 },
      } : {
        id: 'chatcmpl_test', object: 'chat.completion', created: 1, model: 'test',
        choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'inspect', arguments: '{}' } }] } }],
        usage: { total_tokens: 3, prompt_tokens: 1, completion_tokens: 2 },
      }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No local fixture address');
    try {
      const baseURL = `http://127.0.0.1:${address.port}${protocol === 'openai' ? '/v1' : ''}`;
      const adapter = (protocol === 'anthropic' ? createAnthropic : createOpenAI)({ apiKey: 'fixture-key-not-a-credential', model: 'test', baseURL });
      const input: Parameters<typeof adapter.complete>[0] = {
        system: 'test', conversation: [{ kind: 'user', text: 'inspect' }],
        tools: [{ name: 'inspect', description: 'test', inputSchema: { type: 'object', properties: {} } }],
        signal: AbortSignal.timeout(5_000), maxOutputTokens: 500,
      };
      const result = await adapter.complete(input);
      expect(result.calls).toEqual([{ id: 't1', name: 'inspect', input: {} }]);
      expect(result.tokenUsage).toBe(3); expect(toolDefined).toBe(true); expect(outputLimit).toBe(500);
      expect(receivedPath).toBe(protocol === 'anthropic' ? '/v1/messages' : '/v1/chat/completions');
      expect(singleTool).toBeUndefined();
      await adapter.complete({ ...input, singleTool: true });
      expect(singleTool).toEqual(protocol === 'anthropic' ? { type: 'auto', disable_parallel_tool_use: true } : false);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('rejects plaintext non-loopback and credential-bearing model URLs', () => {
    for (const url of ['http://example.com', 'https://user:pass@example.com', 'https://example.com?key=placeholder']) expect(() => safeEndpoint(url)).toThrow();
    expect(safeEndpoint('http://localhost:23000/')).toBe('http://localhost:23000');
  });
  it('does not treat missing token usage as a free OpenAI turn', async () => {
    const server = createServer((req, res) => {
      req.resume();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', created: 1, model: 'test',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }] }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    try {
      const adapter = createOpenAI({ apiKey: 'fixture-only', model: 'test', baseURL: `http://127.0.0.1:${address.port}/v1` });
      await expect(adapter.complete({ system: 'test', conversation: [{ kind: 'user', text: 'inspect' }], tools: [], signal: AbortSignal.timeout(5_000) })).rejects.toThrow('Model omitted usage');
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('does not forward credentials through a model endpoint redirect', async () => {
    let forwarded = false;
    const target = createServer((_, res) => { forwarded = true; res.end('unexpected'); });
    target.listen(0, '127.0.0.1'); await once(target, 'listening');
    const address = target.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const origin = createServer((_, res) => { res.writeHead(307, { Location: `http://127.0.0.1:${address.port}/` }).end(); });
    origin.listen(0, '127.0.0.1'); await once(origin, 'listening');
    const originAddress = origin.address(); if (!originAddress || typeof originAddress === 'string') throw new Error('Missing fixture address');
    try {
      await expect(privateFetch(`http://127.0.0.1:${originAddress.port}/`, { headers: { 'x-api-key': 'fixture-only' } })).rejects.toThrow();
      expect(forwarded).toBe(false);
    } finally {
      origin.closeAllConnections(); target.closeAllConnections();
      await Promise.all([origin, target].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    }
  });
});
