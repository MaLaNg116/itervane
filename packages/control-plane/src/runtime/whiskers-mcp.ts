import { operationsLogTailLines, operationsMetricPeriod, type WhiskersContainerBinding } from '@itervane/contracts';
import { Client, StreamableHTTPClientTransport, type CallToolResult } from '@modelcontextprotocol/client';

export { whiskersContainerBindingSchema, type WhiskersContainerBinding } from '@itervane/contracts';
export type WhiskersMcpFailure = 'binding' | 'timeout' | 'transport' | 'response';
export type WhiskersReadTool = 'get_container_details' | 'get_container_logs' | 'get_container_metrics';
type Tool = WhiskersReadTool | 'restart_container';
export type WhiskersReadOptions = { lines?: typeof operationsLogTailLines; period?: typeof operationsMetricPeriod };
type Invoke = (name: Tool, options?: WhiskersReadOptions) => Promise<CallToolResult>;

const responseLimit = 64 * 1024;
const toolTextLimit = 8 * 1024;
const myPermissionsUri = 'whiskers://me/permissions';
const restartPermission = /^# My Whiskers permissions\r?\n- Caller: API key "[^"\r\n]{1,128}"\r?\n- Scope: explicit tool list\r?\n- [^\r\n]{1,256}\r?\n\r?\n## Tools I may call \(1\)\r?\n\r?\n- `restart_container`\r?\n$/;

export class WhiskersMcpError extends Error {
  constructor(readonly reason: WhiskersMcpFailure) { super('whiskers_mcp_' + reason); }
}

export function whiskersToolText(result: CallToolResult) {
  const block = result.content[0];
  if (result.content.length !== 1 || block?.type !== 'text' || Buffer.byteLength(block.text) > toolTextLimit) return undefined;
  return block.text;
}

export async function withWhiskersMcp<T>(binding: WhiskersContainerBinding, key: string, purpose: 'observation' | 'restart',
  signal: AbortSignal | undefined, run: (invoke: Invoke, requireTime: () => void) => Promise<T>) {
  const timeout = AbortSignal.timeout(purpose === 'observation' ? 10_000 : 25_000);
  const active = signal ? AbortSignal.any([signal, timeout]) : timeout;
  active.throwIfAborted();
  const endpoint = new URL('/mcp', binding.origin);
  let responseTooLarge = false;
  let invoking = false;
  let toolPostSent = false;
  const requireTime = () => {
    signal?.throwIfAborted();
    if (timeout.aborted) throw new WhiskersMcpError('timeout');
  };
  const protocolFailure = () => {
    requireTime();
    throw new WhiskersMcpError(responseTooLarge ? 'response' : 'transport');
  };
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { Authorization: 'Bearer ' + key }, redirect: 'error' },
    fetch: async (input, init) => {
      const destination = input instanceof Request ? input.url : String(input);
      if (destination !== endpoint.href) throw new WhiskersMcpError('binding');
      // Prevent a second operations POST even if a transport later gains an automatic retry.
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      if (purpose === 'restart' && invoking && method.toUpperCase() === 'POST') {
        if (toolPostSent) throw new WhiskersMcpError('transport');
        toolPostSent = true;
      }
      const response = await fetch(input, { ...init, redirect: 'error',
        signal: init?.signal ? AbortSignal.any([active, init.signal]) : active });
      if (!response.body) return response;
      let bytes = 0;
      const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytes += chunk.byteLength;
          if (bytes > responseLimit) {
            responseTooLarge = true;
            controller.error(new WhiskersMcpError('response'));
            return;
          }
          controller.enqueue(chunk);
        },
      }));
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    },
  });
  const client = new Client({ name: 'itervane-whiskers-' + purpose, version: '1.0.0' });
  try {
    await client.connect(transport, { signal: active }).catch(protocolFailure);
    const server = client.getServerVersion();
    if (server?.name !== 'whiskers' || server.version !== '0.15.0') throw new WhiskersMcpError('binding');
    if (purpose === 'restart') {
      // The catalog describes the server. This native resource describes the caller's key.
      const { contents } = await client.readResource({ uri: myPermissionsUri }, { signal: active }).catch(protocolFailure);
      const scope = contents[0];
      if (contents.length !== 1 || scope?.uri !== myPermissionsUri || !('text' in scope)
          || Buffer.byteLength(scope.text) > toolTextLimit || !restartPermission.test(scope.text)) {
        throw new WhiskersMcpError('binding');
      }
    }
    requireTime();
    return await run(async (name, options) => {
      requireTime();
      if (invoking || (name === 'restart_container') !== (purpose === 'restart')) throw new WhiskersMcpError('binding');
      invoking = true;
      const { containerId, serverId } = binding;
      const result = await client.callTool({ name, arguments: { ...options, containerId, serverId } }, { signal: active })
        .catch(protocolFailure);
      requireTime();
      return result;
    }, requireTime);
  } finally {
    if (transport.sessionId && !active.aborted) await transport.terminateSession().catch(() => undefined);
    await client.close().catch(() => undefined);
  }
}
