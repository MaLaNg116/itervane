import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { z } from 'zod';
import { report } from './report.js';

// Local protocol smoke test, not a production API or substitute for Keycloak OAuth.
export async function probeMcp() {
  const token = randomBytes(32).toString('hex');
  const tasks = new Map<string, string>();
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'itervane-p0-probe', version: '0.0.0' });
    server.registerTool('create_probe_task', { inputSchema: z.object({ requestKey: z.string().min(1).max(64) }).strict() }, async ({ requestKey }) => {
      const taskId = tasks.get(requestKey) ?? randomUUID();
      tasks.set(requestKey, taskId);
      return { content: [{ type: 'text', text: JSON.stringify({ taskId }) }], structuredContent: { taskId } };
    });
    server.registerTool('get_probe_task', { inputSchema: z.object({ requestKey: z.string() }).strict() }, async ({ requestKey }) => {
      const taskId = tasks.get(requestKey);
      return taskId
        ? { content: [{ type: 'text', text: JSON.stringify({ taskId }) }], structuredContent: { taskId } }
        : { content: [{ type: 'text', text: 'not_found' }], isError: true };
    });
    return server;
  });
  const handle = toNodeHandler(handler, { maxRequestBodySize: 64 * 1024 });
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const http = createServer((req, res) => {
    if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    const actual = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { res.writeHead(401).end(); return; }
    void handle({ method: req.method ?? 'POST', url: req.url ?? '/mcp', headers: req.headers,
      [Symbol.asyncIterator]: () => req[Symbol.asyncIterator](),
    }, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('No loopback MCP address');
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const clients: Client[] = [];
  async function connect() {
    const client = new Client({ name: 'itervane-p0-external-client', version: '0.0.0' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return client;
  }
  try {
    const denied = await fetch(url, { method: 'POST' });
    const originDenied = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, Origin: 'https://untrusted.invalid' } });
    const first = await connect();
    const requestKey = randomUUID();
    const created = await first.callTool({ name: 'create_probe_task', arguments: { requestKey } });
    const parsed = z.object({ taskId: z.uuid() }).parse(created.structuredContent);
    await first.close();
    const second = await connect();
    const queried = await second.callTool({ name: 'get_probe_task', arguments: { requestKey } });
    const repeated = await second.callTool({ name: 'create_probe_task', arguments: { requestKey } });
    const queryId = z.object({ taskId: z.uuid() }).parse(queried.structuredContent).taskId;
    const repeatId = z.object({ taskId: z.uuid() }).parse(repeated.structuredContent).taskId;
    return report('mcp', [
      { id: 'http-authentication', status: denied.status === 401 ? 'passed' : 'failed', detail: 'Unauthenticated HTTP request rejected before MCP dispatch.' },
      { id: 'origin-validation', status: originDenied.status === 403 ? 'passed' : 'failed', detail: 'Cross-origin request rejected.' },
      { id: 'external-client-reconnect', status: queryId === parsed.taskId && repeatId === parsed.taskId ? 'passed' : 'failed', detail: 'Official SDK HTTP client reconnects and retrieves the same probe task.' },
    ]);
  } finally {
    await Promise.allSettled(clients.map(c => c.close()));
    await handler.close();
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
  }
}
