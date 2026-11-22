import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WhiskersObservationClient } from '../../src/runtime/whiskers-observation.js';

const binding = { origin: 'https://ops.example.invalid', serverId: 'local', containerId: 'a'.repeat(64) };
const key = 'b'.repeat(64);
const instance = { name: 'whiskers', version: '0.15.0' };
const authorize = vi.fn(async () => {});
const toolCalls: unknown[] = [];
let serverInfo = instance;
let reply: unknown;

function detail(id = binding.containerId, server = binding.serverId, state = 'running') {
  return ['Name: demo', `ID: ${id}`, 'Image: sample@sha256:123', `State: ${state}`, 'Health: none',
    'Status: fixture status', 'Created: fixture time', `Server: Fixture (${server})`,
    'Labels: opaque=sensitive-fixture-data', 'State: exited', ''].join('\n');
}

const textReply = (text: string) => ({ content: [{ type: 'text', text }] });
const request = vi.fn<typeof fetch>(async (url, options) => {
  expect(String(url)).toBe(binding.origin + '/mcp');
  expect(options?.redirect).toBe('error');
  expect(new Headers(options?.headers).get('authorization')).toBe('Bearer ' + key);
  if (options?.method === 'GET') return new Response(null, { status: 405 });
  expect(options?.method).toBe('POST');
  const message = JSON.parse(String(options?.body));
  const response = (result: unknown) => Response.json({ jsonrpc: '2.0', id: message.id, result });
  if (message.method === 'initialize') {
    return response({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo });
  }
  if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
  expect(message.method).toBe('tools/call');
  toolCalls.push(message.params);
  return response(reply);
});

function observe(signal?: AbortSignal) {
  return new WhiskersObservationClient(binding, key).observe(authorize, signal);
}

beforeEach(() => {
  request.mockClear();
  authorize.mockReset().mockResolvedValue(undefined);
  toolCalls.length = 0;
  serverInfo = instance;
  reply = textReply(detail());
  vi.stubGlobal('fetch', request);
});
afterEach(() => vi.unstubAllGlobals());

it('uses one bound tool call and projects only the matching runtime facts', async () => {
  const observed = await observe();
  expect(observed).toEqual({ containerId: binding.containerId, serverId: binding.serverId,
    state: 'running', observedAt: expect.any(String) });
  expect(new Date(observed.observedAt).toISOString()).toBe(observed.observedAt);
  expect(toolCalls).toEqual([{ name: 'get_container_details', arguments: { serverId: binding.serverId, containerId: binding.containerId } }]);
  expect(authorize).toHaveBeenCalledTimes(3);
});

it('limits the native log tail to forty lines and retains only signal counts', async () => {
  reply = textReply('Logs for /fixture (last 40 lines):\nready\nWARNING synthetic detail\nError private fixture text\n');
  const report = await new WhiskersObservationClient(binding, key).observeLogs(authorize);
  expect(report).toEqual({ containerId: binding.containerId, serverId: binding.serverId, observedAt: expect.any(String),
    tailLines: 40, lines: 3, warningLines: 1, errorLines: 1 });
  expect(toolCalls).toEqual([{ name: 'get_container_logs', arguments: { containerId: binding.containerId, serverId: binding.serverId, lines: 40 } }]);
  expect(authorize).toHaveBeenCalledTimes(3);
});

it('rejects wrong log windows and returns no evidence before a final authorization check', async () => {
  const client = new WhiskersObservationClient(binding, key);
  for (const invalid of ['Logs for fixture (last 100 lines):\nprivate fixture text',
    'Logs for fixture (last 40 lines):\n' + 'unexpected line\n'.repeat(41)]) {
    reply = textReply(invalid);
    await expect(client.observeLogs(authorize)).rejects.toMatchObject({ reason: 'response', message: 'whiskers_observation_response' });
  }
  reply = textReply('Logs for fixture (last 40 lines):\nWARNING');
  authorize.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('revoked'));
  await expect(client.observeLogs(authorize)).rejects.toThrow('revoked');
});

it('projects bounded container metrics and distinguishes the native no-samples response', async () => {
  const client = new WhiskersObservationClient(binding, key);
  reply = textReply(`Metrics for container ${binding.containerId.slice(0, 12)} (last 1h):\nCPU: avg 1.2%, max 2.0%, min 0.5%\nMemory: avg 3,1%, max 4,0%, min 2,0%\nData points: 12\n`);
  await expect(client.observeMetrics(authorize)).resolves.toEqual({ containerId: binding.containerId, serverId: binding.serverId,
    observedAt: expect.any(String), status: 'observed', period: '1h', cpu: { average: 1.2, maximum: 2, minimum: 0.5 },
    memory: { average: 3.1, maximum: 4, minimum: 2 }, dataPoints: 12 });
  reply = textReply('No metrics available for this container yet.');
  await expect(client.observeMetrics(authorize)).resolves.toMatchObject({ status: 'unavailable', reason: 'no_samples' });
  expect(toolCalls).toEqual(Array.from({ length: 2 }, () => ({
    name: 'get_container_metrics', arguments: { containerId: binding.containerId, serverId: binding.serverId, period: '1h' },
  })));
});

it('fails closed on misattributed or inconsistent metric observations', async () => {
  const client = new WhiskersObservationClient(binding, key);
  const metrics = (id: string, values: string) => textReply(`Metrics for container ${id} (last 1h):\nCPU: ${values}\nData points: 10\n`);
  reply = metrics('d'.repeat(12), 'avg 1.2%, max 2.0%, min 0.5%');
  await expect(client.observeMetrics(authorize)).rejects.toMatchObject({ reason: 'binding' });
  reply = metrics(binding.containerId.slice(0, 12), 'avg 9.0%, max 2.0%, min 0.5%');
  await expect(client.observeMetrics(authorize)).rejects.toMatchObject({ reason: 'response' });
});

it('rejects an insecure origin, shortened container ID or missing initial authority before connecting', async () => {
  expect(() => new WhiskersObservationClient({ ...binding, origin: 'http://ops.example.invalid' }, key)).toThrow('whiskers_observation_binding');
  expect(() => new WhiskersObservationClient({ ...binding, containerId: 'some-container' }, key)).toThrow('whiskers_observation_binding');
  authorize.mockRejectedValueOnce(new Error('revoked'));
  await expect(observe()).rejects.toThrow('revoked');
  expect(request).not.toHaveBeenCalled();
});

it('rechecks authority after connecting and before returning a completed observation', async () => {
  authorize.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('pre_dispatch_revoked'));
  await expect(observe()).rejects.toThrow('pre_dispatch_revoked');
  expect(toolCalls).toHaveLength(0);
  authorize.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('receipt_revoked'));
  await expect(observe()).rejects.toThrow('receipt_revoked');
  expect(toolCalls).toHaveLength(1);
});

it('accepts only the installed downstream contract', async () => {
  serverInfo = { ...instance, version: '0.16.0' };
  await expect(observe()).rejects.toMatchObject({ reason: 'binding' });
  expect(toolCalls).toHaveLength(0);
});

it.each([detail('c'.repeat(64)), detail(binding.containerId, 'another-server')])('rejects attribution to another target', async nativeText => {
  reply = textReply(nativeText);
  await expect(observe()).rejects.toMatchObject({ reason: 'binding', message: 'whiskers_observation_binding' });
});

it('rejects malformed or oversized responses without exposing native data', async () => {
  for (const invalid of [textReply(detail(binding.containerId, binding.serverId, 'unknown')),
    textReply('private tool failure'), textReply(detail() + 'x'.repeat(8 * 1024)), textReply('x'.repeat(65 * 1024))]) {
    reply = invalid;
    await expect(observe()).rejects.toMatchObject({ reason: 'response', message: 'whiskers_observation_response' });
  }
});

it('honors cancellation before network I/O', async () => {
  await expect(observe(AbortSignal.abort(new Error('cancelled')))).rejects.toThrow('cancelled');
  expect(authorize).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});
