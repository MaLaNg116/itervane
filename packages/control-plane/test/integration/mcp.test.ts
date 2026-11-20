import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { admissionDtoSchema, apiErrorSchema, sourceInspectionDtoSchema, taskDtoSchema, translate } from '@itervane/contracts';
import { createApi } from '../../src/api.js';
import { openDatabase } from '../../src/persistence/database.js';
import { bootstrapOwner } from '../../src/service/resources.js';
import { DurableWorker } from '../../src/runtime/worker.js';
import { databaseFixture } from '../helpers/database.js';
import { identityFixture } from '../helpers/identity.js';

let database: Awaited<ReturnType<typeof databaseFixture>>;
let issuer: Awaited<ReturnType<typeof identityFixture>>;
let api: ReturnType<typeof createApi>;
let address: string;
let headers: { authorization: string };
let input: { projectId: string; source: { repositoryId: string; commit: string }; purpose: string; dataClass: string; idempotencyKey: string; locale: string };
const publicUrl = 'https://itervane.example'; const resource = `${publicUrl}/mcp`;
const clients: Client[] = [];
const token = (scope = 'itervane:read itervane:write', subject = 'owner') => issuer.token(subject, { aud: resource, scope });
const connect = async (bearer: string, locale = 'en') => {
  const client = new Client({ name: 'itervane-external-test', version: '0.0.0' }); clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${bearer}`, 'Accept-Language': locale } },
  }));
  return client;
};
const rpc = (name: string, args: Record<string, unknown>) => ({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } });

beforeAll(async () => { database = await databaseFixture(); issuer = await identityFixture(); });
beforeEach(async () => {
  await database.reset(); await bootstrapOwner(database.storage, { issuer: issuer.config.issuer, subject: 'owner' });
  headers = { authorization: `Bearer ${await issuer.token()}` };
  api = createApi(database.storage, { ...issuer.config, publicUrl }, { logger: false });
  address = await api.listen({ host: '127.0.0.1', port: 0 });
  const project = (await api.inject({ method: 'POST', url: '/v1/projects', headers, payload: { name: 'MCP fixture', slug: 'mcp' } })).json();
  const repository = (await api.inject({ method: 'POST', url: `/v1/projects/${project.id}/repositories`, headers,
    payload: { name: 'source', url: 'https://example.invalid/source.git' } })).json();
  input = { projectId: project.id, source: { repositoryId: repository.id, commit: 'd'.repeat(40) },
    purpose: 'Preflight over real MCP', dataClass: 'synthetic', idempotencyKey: randomUUID(), locale: 'zh-CN' };
});
afterEach(async () => { await Promise.allSettled(clients.splice(0).map(client => client.close())); await api?.close(); });
afterAll(async () => { await issuer?.close(); await database?.close(); });

it('advertises a fixed canonical MCP resource and rejects wrong audience, missing scope, Host and Origin', async () => {
  const metadata = await fetch(`${address}/.well-known/oauth-protected-resource/mcp`);
  expect(metadata.status).toBe(200); expect(await metadata.json()).toEqual({ resource,
    authorization_servers: [issuer.config.issuer], bearer_methods_supported: ['header'], scopes_supported: ['itervane:read', 'itervane:write'] });
  const denied = await fetch(`${address}/mcp`, { method: 'POST', headers: { 'Accept-Language': 'zh-CN' } });
  expect(denied.status).toBe(401); expect(denied.headers.get('www-authenticate')).toContain(`${publicUrl}/.well-known/oauth-protected-resource/mcp`);
  expect(apiErrorSchema.parse(await denied.json()).error.message).toBe(translate('zh-CN', 'error.unauthenticated'));
  const apiAudience = await fetch(`${address}/mcp`, { headers }); expect(apiAudience.status).toBe(401);
  const bearer = await token();
  expect((await fetch(`${address}/v1/me`, { headers: { authorization: `Bearer ${bearer}` } })).status).toBe(401);
  expect((await fetch(`${address}/mcp`, { headers: { authorization: `Bearer ${await token('')}` } })).status).toBe(403);
  for (const extra of [{ origin: 'https://untrusted.invalid' }, { origin: 'null' }, { host: 'untrusted.invalid' }]) {
    expect((await api.inject({ method: 'POST', url: '/mcp', headers: { ...extra, authorization: `Bearer ${bearer}` }, payload: rpc('start_audit', input) })).statusCode).toBe(403);
  }
  expect((await database.admin.query('SELECT * FROM itervane.tasks')).rowCount).toBe(0);
});

it('serves localized SDK tool discovery and real task start/query/events/cancel across reconnects', async () => {
  const bearer = await token(); const first = await connect(bearer, 'zh-CN');
  const catalog = await first.listTools();
  expect(catalog.tools.map(tool => tool.name).sort()).toEqual(['cancel_task', 'get_source_inspection', 'get_task', 'get_task_events', 'resume_task', 'start_audit']);
  expect(catalog.tools.find(tool => tool.name === 'start_audit')?.description).toBe(translate('zh-CN', 'mcp.start'));
  const accepted = admissionDtoSchema.parse((await first.callTool({ name: 'start_audit', arguments: input })).structuredContent);
  expect(accepted.task).toMatchObject({ locale: 'zh-CN', state: 'queued' });
  await first.close(); const second = await connect(bearer);
  const queried = taskDtoSchema.parse((await second.callTool({ name: 'get_task', arguments: { taskId: accepted.task.id } })).structuredContent);
  expect(queried).toEqual(accepted.task);
  const inspection = sourceInspectionDtoSchema.parse((await second.callTool({ name: 'get_source_inspection', arguments: { taskId: accepted.task.id } })).structuredContent);
  expect(inspection).toMatchObject({ status: 'not_prepared', plan: null, sourceFetched: false, snapshotVerified: false, scanCompleted: false });
  expect((await api.inject({ url: `/v1/tasks/${accepted.task.id}/source-inspection`, headers })).json()).toEqual(inspection);
  expect((await api.inject(`/v1/tasks/${accepted.task.id}/source-inspection`)).statusCode).toBe(401);
  const repeated = admissionDtoSchema.parse((await second.callTool({ name: 'start_audit', arguments: input })).structuredContent);
  expect(repeated.task.id).toBe(accepted.task.id); expect(repeated.replayed).toBe(true);
  const events = await second.callTool({ name: 'get_task_events', arguments: { taskId: accepted.task.id } });
  expect(events.structuredContent).toMatchObject({ items: [{ message: translate('en', 'task.accepted'), locale: 'en', actorKind: 'principal', workerId: null }] });
  expect((await api.inject({ url: `/v1/tasks/${accepted.task.id}`, headers })).json()).toEqual(queried);
  const cancelled = taskDtoSchema.parse((await second.callTool({ name: 'cancel_task', arguments: { taskId: accepted.task.id, expectedVersion: queried.version } })).structuredContent);
  expect(cancelled.state).toBe('cancelled');
});

it('enforces read-only scopes even for direct unadvertised write calls and localizes validation errors', async () => {
  const readToken = await token('itervane:read'); const reader = await connect(readToken, 'zh-CN');
  expect((await reader.listTools()).tools.map(tool => tool.name).sort()).toEqual(['get_source_inspection', 'get_task', 'get_task_events']);
  const write = await fetch(`${address}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${readToken}`,
    'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify(rpc('start_audit', input)) });
  expect(write.status).toBe(403); expect(write.headers.get('www-authenticate')).toContain('scope="itervane:write"');
  const invalid = await reader.callTool({ name: 'get_task', arguments: { taskId: 'invalid-private-test-value', approved: true } });
  expect(invalid.isError).toBe(true);
  expect(apiErrorSchema.parse(invalid.structuredContent).error).toMatchObject({ code: 'invalid_input', locale: 'zh-CN', message: translate('zh-CN', 'error.invalid_input') });
  expect(JSON.stringify(invalid)).not.toContain('invalid-private-test-value');
});

it('rechecks database project permissions on every MCP command, including token reuse after revocation', async () => {
  const first = await connect(await token()); const accepted = admissionDtoSchema.parse((await first.callTool({ name: 'start_audit', arguments: input })).structuredContent);
  const principalId = randomUUID();
  await database.admin.query('INSERT INTO itervane.principals(id,issuer,subject) VALUES($1,$2,$3)', [principalId, issuer.config.issuer, 'member']);
  await database.admin.query("INSERT INTO itervane.project_members(project_id,principal_id,role) VALUES($1,$2,'viewer')", [input.projectId, principalId]);
  const client = await connect(await token('itervane:read itervane:write', 'member'));
  expect((await client.callTool({ name: 'get_task', arguments: { taskId: accepted.task.id } })).isError).not.toBe(true);
  const denied = await client.callTool({ name: 'cancel_task', arguments: { taskId: accepted.task.id, expectedVersion: 1 } });
  expect(apiErrorSchema.parse(denied.structuredContent).error.code).toBe('forbidden');
  await database.admin.query('DELETE FROM itervane.project_members WHERE principal_id=$1', [principalId]);
  expect(apiErrorSchema.parse((await client.callTool({ name: 'get_task', arguments: { taskId: accepted.task.id } })).structuredContent).error.code).toBe('not_found');
  expect(apiErrorSchema.parse((await client.callTool({ name: 'get_source_inspection', arguments: { taskId: accepted.task.id } })).structuredContent).error.code).toBe('not_found');
  const differentProject = (await api.inject({ method: 'POST', url: '/v1/projects', headers, payload: { name: 'other', slug: 'other' } })).json();
  const foreign = await first.callTool({ name: 'start_audit', arguments: { ...input, projectId: differentProject.id, idempotencyKey: randomUUID() } });
  expect(apiErrorSchema.parse(foreign.structuredContent).error.code).toBe('not_found');
});

it('resumes the persisted Worker interrupt through MCP and preserves it across API and connection replacement', async () => {
  const bearer = await token(); const first = await connect(bearer);
  const accepted = admissionDtoSchema.parse((await first.callTool({ name: 'start_audit', arguments: input })).structuredContent);
  const instance = new DurableWorker(database.storage, database.runtimeUrl);
  try {
    // MCP 接收是异步入队；按实际 Worker 的轮询语义等待可领取，不能假设首个 tick 必有 job。
    await vi.waitFor(async () => {
      await instance.tick();
      expect((await database.admin.query('SELECT state FROM itervane.tasks WHERE id=$1', [accepted.task.id])).rows[0]?.state).toBe('waiting_input');
    }, { timeout: 5_000, interval: 100 });
    const paused = taskDtoSchema.parse((await first.callTool({ name: 'get_task', arguments: { taskId: accepted.task.id } })).structuredContent);
    expect(paused.state).toBe('waiting_input');
    await first.close(); await api.close();
    const connection = await openDatabase(database.runtimeUrl);
    api = createApi(connection, { ...issuer.config, publicUrl }, { logger: false });
    api.addHook('onClose', () => connection.close()); address = await api.listen({ host: '127.0.0.1', port: 0 });
    const second = await connect(bearer, 'zh-CN');
    expect(taskDtoSchema.parse((await second.callTool({ name: 'get_task', arguments: { taskId: paused.id } })).structuredContent)).toEqual(paused);
    const resumed = await second.callTool({ name: 'resume_task', arguments: { taskId: paused.id, expectedVersion: paused.version } });
    expect(taskDtoSchema.parse(resumed.structuredContent).state).toBe('queued');
    await instance.tick();
    const next = taskDtoSchema.parse((await second.callTool({ name: 'get_task', arguments: { taskId: paused.id } })).structuredContent);
    expect(next).toMatchObject({ state: 'waiting_input', locale: 'zh-CN' });
    const stale = await second.callTool({ name: 'resume_task', arguments: { taskId: paused.id, expectedVersion: paused.version } });
    expect(apiErrorSchema.parse(stale.structuredContent).error.code).toBe('version_conflict');
  } finally { await instance.close(); }
});
