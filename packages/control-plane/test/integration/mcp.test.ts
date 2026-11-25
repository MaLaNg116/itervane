import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { admissionDtoSchema, apiErrorSchema, catalogDtoSchema, formalAuditDtoSchema, preauditAdmissionSchema, preauditDtoSchema, ruleDtoSchema, sourceInspectionDtoSchema, taskDtoSchema, translate, verificationViewSchema } from '@itervane/contracts';
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
  for (const tool of ['get_verification', 'get_release_candidate']) {
    expect((await api.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${await token('itervane:write')}` },
      payload: rpc(tool, { taskId: randomUUID() }),
    })).statusCode).toBe(403);
  }
  for (const extra of [{ origin: 'https://untrusted.invalid' }, { origin: 'null' }, { host: 'untrusted.invalid' }]) {
    expect((await api.inject({ method: 'POST', url: '/mcp', headers: { ...extra, authorization: `Bearer ${bearer}` }, payload: rpc('start_audit', input) })).statusCode).toBe(403);
  }
  expect((await database.admin.query('SELECT * FROM itervane.tasks')).rowCount).toBe(0);
});

it('serves localized SDK tool discovery and real task start/query/events/cancel across reconnects', async () => {
  const bearer = await token(); const first = await connect(bearer, 'zh-CN');
  const catalog = await first.listTools();
  expect(catalog.tools.map(tool => tool.name).sort()).toEqual(['cancel_task', 'get_audit', 'get_candidate_validation', 'get_preaudit',
    'get_release_candidate', 'get_release_options', 'get_release_result', 'get_repair', 'get_rule', 'get_rule_extraction',
    'get_source_inspection', 'get_task', 'get_task_events', 'get_task_rule_snapshot', 'get_verification', 'list_preaudits', 'list_rules', 'preaudit_text',
    'request_release', 'resume_task', 'start_audit']);
  expect(catalog.tools.find(tool => tool.name === 'start_audit')?.description).toBe(translate('zh-CN', 'mcp.start'));
  expect(catalog.tools.find(tool => tool.name === 'get_verification')).toMatchObject({ description: translate('zh-CN', 'mcp.verification'), annotations: { readOnlyHint: true } });
  expect(catalog.tools.find(tool => tool.name === 'get_candidate_validation')).toMatchObject({ description: translate('zh-CN', 'mcp.candidate_validation'), annotations: { readOnlyHint: true } });
  expect(catalog.tools.find(tool => tool.name === 'get_release_candidate')).toMatchObject({ description: translate('zh-CN', 'mcp.release_candidate'), annotations: { readOnlyHint: true } });
  expect(catalog.tools.find(tool => tool.name === 'get_release_result')).toMatchObject({ description: translate('zh-CN', 'mcp.release_result'), annotations: { readOnlyHint: true } });
  expect(catalog.tools.find(tool => tool.name === 'request_release')).toMatchObject({ description: translate('zh-CN', 'mcp.request_release'), annotations: { readOnlyHint: false } });
  const accepted = admissionDtoSchema.parse((await first.callTool({ name: 'start_audit', arguments: input })).structuredContent);
  expect(accepted.task).toMatchObject({ locale: 'zh-CN', state: 'queued' });
  await first.close(); const second = await connect(bearer);
  const queried = taskDtoSchema.parse((await second.callTool({ name: 'get_task', arguments: { taskId: accepted.task.id } })).structuredContent);
  expect(queried).toEqual(accepted.task);
  const noCandidate = await second.callTool({ name: 'get_release_candidate', arguments: { taskId: accepted.task.id } });
  expect(noCandidate.isError).toBe(true);
  expect(apiErrorSchema.parse(noCandidate.structuredContent).error.code).toBe('not_found');
  const inspection = sourceInspectionDtoSchema.parse((await second.callTool({ name: 'get_source_inspection', arguments: { taskId: accepted.task.id } })).structuredContent);
  expect(inspection).toMatchObject({ status: 'not_prepared', plan: null, sourceFetched: false, snapshotVerified: false, scanCompleted: false });
  expect((await api.inject({ url: `/v1/tasks/${accepted.task.id}/source-inspection`, headers })).json()).toEqual(inspection);
  expect((await api.inject(`/v1/tasks/${accepted.task.id}/source-inspection`)).statusCode).toBe(401);
  const audit = formalAuditDtoSchema.parse((await second.callTool({ name: 'get_audit', arguments: { taskId: accepted.task.id } })).structuredContent);
  expect(audit).toMatchObject({ status: 'pending', result: null });
  expect((await api.inject({ url: `/v1/tasks/${accepted.task.id}/audit`, headers: { ...headers, 'Accept-Language': audit.locale } })).json()).toEqual(audit);
  expect((await api.inject(`/v1/tasks/${accepted.task.id}/audit`)).statusCode).toBe(401);
  const repeated = admissionDtoSchema.parse((await second.callTool({ name: 'start_audit', arguments: input })).structuredContent);
  expect(repeated.task.id).toBe(accepted.task.id); expect(repeated.replayed).toBe(true);
  const events = await second.callTool({ name: 'get_task_events', arguments: { taskId: accepted.task.id } });
  expect(events.structuredContent).toMatchObject({ items: [{ message: translate('en', 'task.accepted'), locale: 'en', actorKind: 'principal', workerId: null }] });
  expect((await api.inject({ url: `/v1/tasks/${accepted.task.id}`, headers })).json()).toEqual(queried);
  const cancelled = taskDtoSchema.parse((await second.callTool({ name: 'cancel_task', arguments: { taskId: accepted.task.id, expectedVersion: queried.version } })).structuredContent);
  expect(cancelled.state).toBe('cancelled');
  const verification = verificationViewSchema.parse((await second.callTool({ name: 'get_verification', arguments: { taskId: accepted.task.id } })).structuredContent);
  expect(verification).toMatchObject({ current: { runId: accepted.task.runId, generation: 1, status: 'cancelled' }, previous: null });
  expect((await api.inject({ url: `/v1/tasks/${accepted.task.id}/verification`, headers })).json()).toEqual(verification);
  expect((await api.inject(`/v1/tasks/${accepted.task.id}/verification`)).statusCode).toBe(401);
});

it('shares versioned rules and a source-free preaudit record across real MCP and HTTP with locale-independent retries', async () => {
  const client = await connect(await token(), 'zh-CN');
  const catalog = catalogDtoSchema.parse((await client.callTool({ name: 'list_rules', arguments: { projectId: input.projectId, language: 'typescript' } })).structuredContent);
  expect(catalog.locale).toBe('zh-CN'); expect(catalog.items.some(rule => rule.kind === 'skill')).toBe(true);
  const rule = ruleDtoSchema.parse((await client.callTool({ name: 'get_rule', arguments: { projectId: input.projectId, ruleId: 'text-dynamic-eval', catalogSha256: catalog.sha256 } })).structuredContent);
  expect(rule.title).toBe(catalog.items[0]?.title);
  const request = { projectId: input.projectId, idempotencyKey: randomUUID(), catalogSha256: catalog.sha256, language: 'typescript', format: 'snippet', dataClass: 'synthetic', text: 'eval(value); // private-input-canary' };
  const created = preauditAdmissionSchema.parse((await client.callTool({ name: 'preaudit_text', arguments: request })).structuredContent);
  expect(created).toMatchObject({ replayed: false, report: { locale: 'zh-CN', submittedVia: 'mcp', formalScan: false, releaseEligible: false } });
  expect(JSON.stringify(created)).not.toContain('private-input-canary');
  const response = await api.inject({ method: 'POST', url: '/v1/preaudits', headers, payload: request }); expect(response.statusCode).toBe(200);
  const replay = preauditAdmissionSchema.parse(response.json()); expect(replay.replayed).toBe(true); expect(replay.report.id).toBe(created.report.id);
  expect(replay.report.reportSha256).toBe(created.report.reportSha256); expect(replay.report.locale).toBe('en');
  const reader = await connect(await token('itervane:read'));
  expect(preauditDtoSchema.parse((await reader.callTool({ name: 'get_preaudit', arguments: { preauditId: created.report.id } })).structuredContent)).toEqual(replay.report);
  expect((await api.inject(`/v1/preaudits/${created.report.id}`)).statusCode).toBe(401);
  const denied = await fetch(`${address}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${await token('itervane:read')}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify(rpc('preaudit_text', request)) });
  expect(denied.status).toBe(403);
  await database.admin.query('DELETE FROM itervane.workspace_members');
  expect(apiErrorSchema.parse((await reader.callTool({ name: 'get_preaudit', arguments: { preauditId: created.report.id } })).structuredContent).error.code).toBe('not_found');
});

it('does not persist stale or executable preaudit requests and does not echo invalid text', async () => {
  const client = await connect(await token());
  const catalog = catalogDtoSchema.parse((await api.inject({ url: `/v1/projects/${input.projectId}/rules`, headers })).json());
  const base = { projectId: input.projectId, idempotencyKey: randomUUID(), catalogSha256: catalog.sha256, language: 'typescript', format: 'snippet', dataClass: 'synthetic', text: 'private-invalid-canary' };
  for (const [request, code] of [[{ ...base, catalogSha256: '0'.repeat(64) }, 'conflict'], [{ ...base, regex: '.*' }, 'invalid_input'], [{ ...base, format: 'unified_diff' }, 'invalid_input']] as const) {
    const result = await client.callTool({ name: 'preaudit_text', arguments: request });
    expect(apiErrorSchema.parse(result.structuredContent).error.code).toBe(code); expect(JSON.stringify(result)).not.toContain('private-invalid-canary');
  }
  expect((await database.admin.query('SELECT * FROM itervane.preaudits')).rowCount).toBe(0);
});

it('enforces read-only scopes even for direct unadvertised write calls and localizes validation errors', async () => {
  const readToken = await token('itervane:read'); const reader = await connect(readToken, 'zh-CN');
  expect((await reader.listTools()).tools.map(tool => tool.name).sort()).toEqual(['get_audit', 'get_candidate_validation',
    'get_preaudit', 'get_release_candidate', 'get_release_options', 'get_release_result', 'get_repair', 'get_rule', 'get_rule_extraction',
    'get_source_inspection', 'get_task', 'get_task_events', 'get_task_rule_snapshot', 'get_verification', 'list_preaudits', 'list_rules']);
  for (const body of [rpc('start_audit', input), rpc('request_release', { taskId: randomUUID(), environmentId: randomUUID(), expectedVersion: 1 })]) {
    const write = await fetch(`${address}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${readToken}`,
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) });
    expect(write.status).toBe(403);
    expect(write.headers.get('www-authenticate')).toContain('scope="itervane:write"');
  }
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
  const memberHeaders = { authorization: `Bearer ${await issuer.token('member')}` };
  const verificationUrl = `/v1/tasks/${accepted.task.id}/verification`;
  expect((await client.callTool({ name: 'get_task', arguments: { taskId: accepted.task.id } })).isError).not.toBe(true);
  expect(verificationViewSchema.parse((await client.callTool({ name: 'get_verification', arguments: { taskId: accepted.task.id } })).structuredContent))
    .toMatchObject({ current: { status: 'pending' }, previous: null });
  expect((await api.inject({ url: verificationUrl, headers: memberHeaders })).statusCode).toBe(200);

  const differentProject = (await api.inject({ method: 'POST', url: '/v1/projects', headers, payload: { name: 'other', slug: 'other' } })).json();
  const differentRepo = (await api.inject({ method: 'POST', url: `/v1/projects/${differentProject.id}/repositories`, headers,
    payload: { name: 'other', url: 'https://example.invalid/other.git' } })).json();
  const differentTask = admissionDtoSchema.parse((await first.callTool({ name: 'start_audit', arguments: { ...input,
    projectId: differentProject.id, source: { ...input.source, repositoryId: differentRepo.id }, idempotencyKey: randomUUID() },
  })).structuredContent).task;
  expect(apiErrorSchema.parse((await client.callTool({ name: 'get_verification', arguments: { taskId: differentTask.id } })).structuredContent).error.code).toBe('not_found');
  expect((await api.inject({ url: `/v1/tasks/${differentTask.id}/verification`, headers: memberHeaders })).statusCode).toBe(404);
  const denied = await client.callTool({ name: 'cancel_task', arguments: { taskId: accepted.task.id, expectedVersion: 1 } });
  expect(apiErrorSchema.parse(denied.structuredContent).error.code).toBe('forbidden');
  await database.admin.query('DELETE FROM itervane.project_members WHERE principal_id=$1', [principalId]);
  expect(apiErrorSchema.parse((await client.callTool({ name: 'get_task', arguments: { taskId: accepted.task.id } })).structuredContent).error.code).toBe('not_found');
  expect(apiErrorSchema.parse((await client.callTool({ name: 'get_source_inspection', arguments: { taskId: accepted.task.id } })).structuredContent).error.code).toBe('not_found');
  expect(apiErrorSchema.parse((await client.callTool({ name: 'get_audit', arguments: { taskId: accepted.task.id } })).structuredContent).error.code).toBe('not_found');
  expect(apiErrorSchema.parse((await client.callTool({ name: 'get_repair', arguments: { taskId: accepted.task.id } })).structuredContent).error.code).toBe('not_found');
  expect(apiErrorSchema.parse((await client.callTool({ name: 'get_verification', arguments: { taskId: accepted.task.id } })).structuredContent).error.code).toBe('not_found');
  expect((await api.inject({ url: `/v1/tasks/${accepted.task.id}/audit`, headers: memberHeaders })).statusCode).toBe(404);
  expect((await api.inject({ url: verificationUrl, headers: memberHeaders })).statusCode).toBe(404);
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
