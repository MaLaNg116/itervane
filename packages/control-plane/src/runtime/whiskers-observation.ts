import { serviceOriginSchema } from '@itervane/contracts';
import { Client, StreamableHTTPClientTransport, type CallToolResult } from '@modelcontextprotocol/client';
import { z } from 'zod';

const bindingSchema = z.strictObject({
  origin: serviceOriginSchema('Whiskers'),
  serverId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/),
  containerId: z.string().regex(/^[a-f0-9]{64}$/),
});
const readKeySchema = z.string().regex(/^[a-f0-9]{64}$/);
const stateSchema = z.enum(['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead']);
const responseLimit = 64 * 1024;
const toolTextLimit = 8 * 1024;
const requestTimeout = 10_000;

// Whiskers 0.15.0 writes these fields before labels and other container metadata.
const detailHeader = /^Name: [^\r\n]{1,256}\r?\nID: ([a-f0-9]{64})\r?\nImage: [^\r\n]{1,512}\r?\nState: ([a-z]{1,24})\r?\nHealth: [^\r\n]{0,128}\r?\nStatus: [^\r\n]{0,256}\r?\nCreated: [^\r\n]{1,128}\r?\nServer: [^\r\n]{1,256} \(([a-zA-Z0-9_.-]{1,128})\)(?:\r?\n|$)/;

type Binding = z.output<typeof bindingSchema>;
type Authorize = () => Promise<void>;

export class WhiskersObservationError extends Error {
  constructor(readonly reason: 'binding' | 'timeout' | 'transport' | 'response') {
    super('whiskers_observation_' + reason);
    this.name = 'WhiskersObservationError';
  }
}

function observation(result: CallToolResult, binding: Binding) {
  const block = result.content[0];
  if (result.isError || result.content.length !== 1 || block?.type !== 'text' || Buffer.byteLength(block.text) > toolTextLimit) {
    throw new WhiskersObservationError('response');
  }
  const header = detailHeader.exec(block.text);
  const state = stateSchema.safeParse(header?.[2]);
  if (!header || !state.success) throw new WhiskersObservationError('response');
  if (header[1] !== binding.containerId || header[3] !== binding.serverId) throw new WhiskersObservationError('binding');
  return { containerId: binding.containerId, serverId: binding.serverId, state: state.data, observedAt: new Date().toISOString() };
}

export class WhiskersObservationClient {
  readonly #binding: Binding;
  readonly #readKey: string;

  constructor(binding: z.input<typeof bindingSchema>, readKey: string) {
    const target = bindingSchema.safeParse(binding);
    const key = readKeySchema.safeParse(readKey);
    if (!target.success || !key.success) throw new WhiskersObservationError('binding');
    this.#binding = target.data;
    this.#readKey = key.data;
  }

  async observe(authorize: Authorize, signal?: AbortSignal) {
    signal?.throwIfAborted();
    await authorize();
    const timeout = AbortSignal.timeout(requestTimeout);
    const active = signal ? AbortSignal.any([signal, timeout]) : timeout;
    active.throwIfAborted();
    const endpoint = new URL('/mcp', this.#binding.origin);
    let responseTooLarge = false;
    const requireTime = () => {
      signal?.throwIfAborted();
      if (timeout.aborted) throw new WhiskersObservationError('timeout');
    };
    const protocolFailure = () => {
      requireTime();
      throw new WhiskersObservationError(responseTooLarge ? 'response' : 'transport');
    };
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { Authorization: 'Bearer ' + this.#readKey }, redirect: 'error' },
      fetch: async (input, init) => {
        const destination = input instanceof Request ? input.url : String(input);
        if (destination !== endpoint.href) throw new WhiskersObservationError('binding');
        const response = await fetch(input, { ...init, redirect: 'error',
          signal: init?.signal ? AbortSignal.any([active, init.signal]) : active });
        if (!response.body) return response;
        let bytes = 0;
        const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            bytes += chunk.byteLength;
            if (bytes > responseLimit) {
              responseTooLarge = true;
              controller.error(new WhiskersObservationError('response'));
              return;
            }
            controller.enqueue(chunk);
          },
        }));
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      },
    });
    const client = new Client({ name: 'itervane-whiskers-observation', version: '1.0.0' });
    try {
      await client.connect(transport, { signal: active }).catch(protocolFailure);
      const server = client.getServerVersion();
      if (server?.name !== 'whiskers' || server.version !== '0.15.0') throw new WhiskersObservationError('binding');
      requireTime();
      await authorize();
      requireTime();
      const { containerId, serverId } = this.#binding;
      const raw = await client.callTool({ name: 'get_container_details', arguments: { containerId, serverId } }, { signal: active })
        .catch(protocolFailure);
      requireTime();
      const observed = observation(raw, this.#binding);
      await authorize();
      requireTime();
      return observed;
    } finally {
      if (transport.sessionId && !active.aborted) await transport.terminateSession().catch(() => undefined);
      await client.close().catch(() => undefined);
    }
  }
}
