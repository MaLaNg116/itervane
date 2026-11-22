import {
  operationsLogObservationSchema, operationsLogTailLines, operationsMetricObservationSchema, operationsMetricPeriod,
  whiskersObservationSchema, whiskersReadKeySchema,
} from '@itervane/contracts';
import {
  WhiskersMcpError, whiskersContainerBindingSchema, whiskersToolText, withWhiskersMcp, type WhiskersContainerBinding,
  type WhiskersMcpFailure, type WhiskersReadOptions, type WhiskersReadTool,
} from './whiskers-mcp.js';

// Whiskers 0.15.0 writes these fields before labels and other container metadata.
const detailHeader = /^Name: [^\r\n]{1,256}\r?\nID: ([a-f0-9]{64})\r?\nImage: [^\r\n]{1,512}\r?\nState: ([a-z]{1,24})\r?\nHealth: [^\r\n]{0,128}\r?\nStatus: [^\r\n]{0,256}\r?\nCreated: [^\r\n]{1,128}\r?\nServer: [^\r\n]{1,256} \(([a-zA-Z0-9_.-]{1,128})\)(?:\r?\n|$)/;

type Authorize = () => Promise<void>;

export class WhiskersObservationError extends Error {
  constructor(readonly reason: WhiskersMcpFailure) {
    super('whiskers_observation_' + reason);
    this.name = 'WhiskersObservationError';
  }
}

function observation(text: string, binding: WhiskersContainerBinding) {
  const header = detailHeader.exec(text);
  const state = whiskersObservationSchema.shape.state.safeParse(header?.[2]);
  if (!header || !state.success) throw new WhiskersObservationError('response');
  if (header[1] !== binding.containerId || header[3] !== binding.serverId) throw new WhiskersObservationError('binding');
  return { containerId: binding.containerId, serverId: binding.serverId, state: state.data, observedAt: new Date().toISOString() };
}

function logObservation(text: string, binding: WhiskersContainerBinding) {
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

function metricObservation(text: string, binding: WhiskersContainerBinding) {
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
  readonly #binding: WhiskersContainerBinding;
  readonly #readKey: string;

  constructor(binding: WhiskersContainerBinding, readKey: string) {
    const target = whiskersContainerBindingSchema.safeParse(binding);
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

  private async read<T>(name: WhiskersReadTool, options: WhiskersReadOptions,
    project: (text: string, binding: WhiskersContainerBinding) => T, authorize: Authorize, signal?: AbortSignal) {
    signal?.throwIfAborted();
    await authorize();
    try {
      return await withWhiskersMcp(this.#binding, this.#readKey, 'observation', signal, async (invoke, requireTime) => {
        await authorize();
        const raw = await invoke(name, options);
        const text = whiskersToolText(raw);
        if (raw.isError || text === undefined) throw new WhiskersObservationError('response');
        const observed = project(text, this.#binding);
        await authorize();
        requireTime();
        return observed;
      });
    } catch (error) {
      if (error instanceof WhiskersMcpError) throw new WhiskersObservationError(error.reason);
      throw error;
    }
  }
}
