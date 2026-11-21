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
