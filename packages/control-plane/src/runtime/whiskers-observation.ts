import {
  operationsLogObservationSchema, operationsLogTailLines, operationsMetricObservationSchema, operationsMetricPeriod,
  sha256Schema, whiskersEndpointSchema, whiskersObservationSchema, whiskersReadKeySchema,
} from '@itervane/contracts';
import { Client, StreamableHTTPClientTransport, type CallToolResult } from '@modelcontextprotocol/client';
import { z } from 'zod';

const bindingSchema = whiskersEndpointSchema.extend({ containerId: sha256Schema });
const responseLimit = 64 * 1024;
const toolTextLimit = 8 * 1024;
const requestTimeout = 10_000;

// Whiskers 0.15.0 writes these fields before labels and other container metadata.
const detailHeader = /^Name: [^\r\n]{1,256}\r?\nID: ([a-f0-9]{64})\r?\nImage: [^\r\n]{1,512}\r?\nState: ([a-z]{1,24})\r?\nHealth: [^\r\n]{0,128}\r?\nStatus: [^\r\n]{0,256}\r?\nCreated: [^\r\n]{1,128}\r?\nServer: [^\r\n]{1,256} \(([a-zA-Z0-9_.-]{1,128})\)(?:\r?\n|$)/;

type Binding = z.output<typeof bindingSchema>;
type Authorize = () => Promise<void>;
type ReadTool = 'get_container_details' | 'get_container_logs' | 'get_container_metrics';

export class WhiskersObservationError extends Error {
  constructor(readonly reason: 'binding' | 'timeout' | 'transport' | 'response') {
    super('whiskers_observation_' + reason);
    this.name = 'WhiskersObservationError';
  }
}

function responseText(result: CallToolResult) {
  const block = result.content[0];
  if (result.isError || result.content.length !== 1 || block?.type !== 'text' || Buffer.byteLength(block.text) > toolTextLimit) {
    throw new WhiskersObservationError('response');
  }
  return block.text;
}

function observation(text: string, binding: Binding) {
  const header = detailHeader.exec(text);
  const state = whiskersObservationSchema.shape.state.safeParse(header?.[2]);
  if (!header || !state.success) throw new WhiskersObservationError('response');
  if (header[1] !== binding.containerId || header[3] !== binding.serverId) throw new WhiskersObservationError('binding');
  return { containerId: binding.containerId, serverId: binding.serverId, state: state.data, observedAt: new Date().toISOString() };
}

function logObservation(text: string, binding: Binding) {
  const header = /^Logs for \/?[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127} \(last (\d{1,3}) lines\):\r?\n/.exec(text);
  if (!header || Number(header[1]) !== operationsLogTailLines) throw new WhiskersObservationError('response');
  // Summarize untrusted application output before it can enter an Agent, checkpoint or event.
  const body = text.slice(header[0].length).replace(/\r?\n$/, '');
  const lines = body ? body.split(/\r?\n/) : [];
  const report = operationsLogObservationSchema.safeParse({
    containerId: binding.containerId, serverId: binding.serverId, observedAt: new Date().toISOString(),
    tailLines: operationsLogTailLines, lines: lines.length,
    warningLines: lines.filter(line => /\bwarn(?:ing)?\b/i.test(line)).length,
    errorLines: lines.filter(line => /\b(error|fatal|exception)\b/i.test(line)).length,
  });
  if (!report.success) throw new WhiskersObservationError('response');
  return report.data;
}

function metricSeries(line: string | undefined, name: 'CPU' | 'Memory') {
  const parts = /^(CPU|Memory): avg (\d{1,6}[.,]\d)%, max (\d{1,6}[.,]\d)%, min (\d{1,6}[.,]\d)%$/.exec(line ?? '');
  if (!parts || parts[1] !== name) throw new WhiskersObservationError('response');
  const [average, maximum, minimum] = parts.slice(2).map(value => Number(value.replace(',', '.')));
  return { average, maximum, minimum };
}

function metricObservation(text: string, binding: Binding) {
  const scope = { containerId: binding.containerId, serverId: binding.serverId,
    observedAt: new Date().toISOString(), period: operationsMetricPeriod };
  if (text === 'No metrics available for this container yet.') return operationsMetricObservationSchema.parse({
    ...scope, status: 'unavailable', reason: 'no_samples',
  });
  const lines = text.replace(/\r?\n$/, '').split(/\r?\n/);
  if (![3, 4].includes(lines.length)) throw new WhiskersObservationError('response');
  const header = /^Metrics for container ([a-f0-9]{12}) \(last 1h\):$/.exec(lines[0] ?? '');
  if (!header) throw new WhiskersObservationError('response');
  if (header[1] !== binding.containerId.slice(0, 12)) throw new WhiskersObservationError('binding');
  const points = /^Data points: ([1-9]\d{0,5})$/.exec(lines.at(-1) ?? '');
  const report = operationsMetricObservationSchema.safeParse({
    ...scope, status: 'observed', cpu: metricSeries(lines[1], 'CPU'),
    memory: lines.length === 4 ? metricSeries(lines[2], 'Memory') : null, dataPoints: points ? Number(points[1]) : undefined,
  });
  if (!report.success) throw new WhiskersObservationError('response');
  return report.data;
}

export class WhiskersObservationClient {
  readonly #binding: Binding;
  readonly #readKey: string;

  constructor(binding: z.input<typeof bindingSchema>, readKey: string) {
    const target = bindingSchema.safeParse(binding);
    const key = whiskersReadKeySchema.safeParse(readKey);
    if (!target.success || !key.success) throw new WhiskersObservationError('binding');
    this.#binding = target.data;
    this.#readKey = key.data;
  }

  observe(authorize: Authorize, signal?: AbortSignal) {
    return this.read('get_container_details', {}, observation, authorize, signal);
  }

  observeLogs(authorize: Authorize, signal?: AbortSignal) {
    return this.read('get_container_logs', { lines: operationsLogTailLines }, logObservation, authorize, signal);
  }

  observeMetrics(authorize: Authorize, signal?: AbortSignal) {
    return this.read('get_container_metrics', { period: operationsMetricPeriod }, metricObservation, authorize, signal);
  }

  private async read<T>(name: ReadTool, options: { lines?: typeof operationsLogTailLines; period?: typeof operationsMetricPeriod },
    project: (text: string, binding: Binding) => T, authorize: Authorize, signal?: AbortSignal) {
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
      const raw = await client.callTool({ name, arguments: { containerId, serverId, ...options } }, { signal: active })
        .catch(protocolFailure);
      requireTime();
      const observed = project(responseText(raw), this.#binding);
      await authorize();
      requireTime();
      return observed;
    } finally {
      if (transport.sessionId && !active.aborted) await transport.terminateSession().catch(() => undefined);
      await client.close().catch(() => undefined);
    }
  }
}
