import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WhiskersRestartClient } from '../../src/runtime/whiskers-restart.js';

const binding = { origin: 'https://ops.example.invalid', serverId: 'isolated', containerId: 'a'.repeat(64) };
const key = 'b'.repeat(64);
const id = 'c'.repeat(32);
const server = { name: 'whiskers', version: '0.15.0' };
const tool = { name: 'restart_container', arguments: { containerId: binding.containerId, serverId: binding.serverId } };
const text = (value: string, isError = false) => ({ isError, content: [{ type: 'text', text: value }] });
const raised = (approval: string) => text("Human approval required: 'restart_container' (write) requires confirmation. Approval "
  + approval + ' was raised (Whiskers → Approvals). After it is approved, repeat this exact call within 10 minutes; it then runs once.', true);
const pending = (approval: string) => text(`Approval ${approval} for 'restart_container' is still pending. Repeat this exact call once a human has approved it.`, true);
const acknowledged = text('Container demo restarted.');
const authority = vi.fn(async () => {});
const calls: unknown[] = [];
let remote: typeof server;
let toolResponse: () => unknown;

const fetchMcp = vi.fn<typeof fetch>(async (input, init) => {
  expect(String(input)).toBe(binding.origin + '/mcp');
  expect(init?.redirect).toBe('error');
  expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ' + key);
  if (init?.method === 'GET') return new Response(null, { status: 405 });
  expect(init?.method).toBe('POST');
  const message = JSON.parse(String(init?.body));
  if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
  if (message.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: message.id,
    result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: remote } });
  expect(message.method).toBe('tools/call');
  calls.push(message.params);
  return Response.json({ jsonrpc: '2.0', id: message.id, result: toolResponse() });
});

beforeEach(() => {
  fetchMcp.mockClear();
  authority.mockReset().mockResolvedValue(undefined);
  calls.length = 0;
  remote = server;
  toolResponse = () => raised(id);
  vi.stubGlobal('fetch', fetchMcp);
});
afterEach(() => vi.unstubAllGlobals());

it('raises native approval and sends identical fixed arguments after separate authorization', async () => {
  const restart = new WhiskersRestartClient(binding, key);
  await expect(restart.requestApproval(authority)).resolves.toEqual({ status: 'awaiting_approval', approvalId: id });
  toolResponse = () => pending(id);
  await expect(restart.resume(id, authority)).resolves.toEqual({ status: 'awaiting_approval', approvalId: id });
  toolResponse = () => acknowledged;
  await expect(restart.resume(id, authority)).resolves.toEqual({ status: 'acknowledged', approvalId: id });
  expect(calls).toEqual([tool, tool, tool]);
  expect(authority.mock.calls).toEqual([
    ['connect', { kind: 'request' }, binding], ['send', { kind: 'request' }, binding],
    ['connect', { kind: 'resume', approvalId: id }, binding], ['send', { kind: 'resume', approvalId: id }, binding],
    ['connect', { kind: 'resume', approvalId: id }, binding], ['send', { kind: 'resume', approvalId: id }, binding],
  ]);
});

it('treats immediate success, another native approval and unrecognized responses as uncertain', async () => {
  const restart = new WhiskersRestartClient(binding, key);
  toolResponse = () => acknowledged;
  await expect(restart.requestApproval(authority)).resolves.toEqual({ status: 'result_unknown' });
  for (const reply of [pending('d'.repeat(32)), raised('d'.repeat(32)), text('private fixture output', true),
    text('Container demo restarted.', true), text('x'.repeat(9 * 1024))]) {
    toolResponse = () => reply;
    await expect(restart.resume(id, authority)).resolves.toEqual({ status: 'result_unknown' });
  }
  expect(calls).toEqual(Array.from({ length: 6 }, () => tool));
});

it('makes one attempt and returns only an unknown result if the dispatch response is lost', async () => {
  toolResponse = () => { throw new Error('private transport details'); };
  const restart = new WhiskersRestartClient(binding, key);
  await expect(restart.resume(id, authority)).resolves.toEqual({ status: 'result_unknown' });
  expect(calls).toEqual([tool]);
});

it('fails before sending if identity changes on handshake or authorization is withdrawn', async () => {
  const restart = new WhiskersRestartClient(binding, key);
  remote = { ...server, version: '0.16.0' };
  await expect(restart.requestApproval(authority)).rejects.toMatchObject({ reason: 'binding' });
  expect(authority.mock.calls).toEqual([['connect', { kind: 'request' }, binding]]);
  remote = server;
  authority.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('revoked'));
  await expect(restart.resume(id, authority)).rejects.toThrow('revoked');
  expect(calls).toHaveLength(0);
});

it('rejects insecure origins, partial targets, invalid credentials and invalid approval IDs before I/O', async () => {
  expect(() => new WhiskersRestartClient({ ...binding, origin: 'http://ops.example.invalid' }, key)).toThrow('whiskers_restart_binding');
  expect(() => new WhiskersRestartClient({ ...binding, containerId: 'demo' }, key)).toThrow('whiskers_restart_binding');
  expect(() => new WhiskersRestartClient(binding, 'invalid')).toThrow('whiskers_restart_binding');
  const restart = new WhiskersRestartClient(binding, key);
  expect(() => restart.resume(id.slice(0, -1), authority)).toThrow('whiskers_restart_binding');
  await expect(restart.requestApproval(authority, AbortSignal.abort(new Error('cancelled')))).rejects.toThrow('cancelled');
  expect(authority).not.toHaveBeenCalled();
  expect(fetchMcp).not.toHaveBeenCalled();
});
