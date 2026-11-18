import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { admissionDtoSchema, apiErrorSchema, taskDtoSchema, wakeupSchema } from '@itervane/contracts';
import { createApi } from '../../src/api.js';
import { openDatabase, queueName } from '../../src/persistence/database.js';
import { migrateDatabase } from '../../src/persistence/migrate.js';
import { bootstrapOwner, ResourceService } from '../../src/service/resources.js';
import { databaseFixture } from '../helpers/database.js';
import { identityFixture } from '../helpers/identity.js';

let database: Awaited<ReturnType<typeof databaseFixture>>;
let issuer: Awaited<ReturnType<typeof identityFixture>>;
let api: ReturnType<typeof createApi>;
let headers: { authorization: string };
beforeAll(async () => {
  database = await databaseFixture(); issuer = await identityFixture();
  api = createApi(database.storage, issuer.config, { logger: false });
  await api.ready(); headers = { authorization: `Bearer ${await issuer.token()}` };
});
afterAll(async () => { if (api) await api.close(); if (issuer) await issuer.close(); if (database) await database.close(); });
beforeEach(async () => { await database.reset(); });

async function owner() { return bootstrapOwner(database.storage, { issuer: issuer.config.issuer, subject: 'owner' }); }
async function project(slug = 'example') {
  await owner();
  const response = await api.inject({ method: 'POST', url: '/v1/projects', headers, payload: { name: slug, slug } });
  expect(response.statusCode).toBe(201); return response.json<{ id: string }>();
}
async function registered(slug = 'example') {
  const resource = await project(slug);
  const response = await api.inject({ method: 'POST', url: `/v1/projects/${resource.id}/repositories`, headers,
    payload: { name: 'example', url: `https://example.invalid/${slug}.git` } });
  expect(response.statusCode).toBe(201);
  return { projectId: resource.id, source: { repositoryId: response.json<{ id: string }>().id, commit: 'a'.repeat(40) },
    purpose: 'Audit synthetic fixture', dataClass: 'synthetic', idempotencyKey: randomUUID() };
}
const admit = (payload: unknown, auth = headers) => api.inject({ method: 'POST', url: '/v1/tasks', headers: auth, payload: payload as Record<string, unknown> });

it('keeps liveness minimal, rejects unauthenticated calls and does not enroll the first token holder', async () => {
  expect((await api.inject('/health/live')).json()).toEqual({ status: 'alive' });
  expect((await api.inject('/v1/projects')).statusCode).toBe(401);
  const unknown = await api.inject({ url: '/v1/me', headers });
  expect(unknown.statusCode).toBe(403);
  expect((await database.admin.query('SELECT * FROM itervane.principals')).rowCount).toBe(0);
});

it('serializes explicit owner bootstrap and refuses implicit ownership replacement', async () => {
  const [a, b] = await Promise.all([owner(), owner()]);
  expect(a).toEqual(b);
  expect((await database.admin.query('SELECT * FROM itervane.workspaces')).rowCount).toBe(1);
  await expect(bootstrapOwner(database.storage, { issuer: issuer.config.issuer, subject: 'other' })).rejects.toMatchObject({ code: 'conflict' });
});

it('registers protected resources and rejects cross-project application bindings', async () => {
  const a = await project('project-a'); const b = await project('project-b');
  const app = await api.inject({ method: 'POST', url: `/v1/projects/${a.id}/applications`, headers, payload: { name: 'demo' } });
  expect(app.statusCode).toBe(201);
  const applicationId = app.json<{ id: string }>().id;
  const environment = await api.inject({ method: 'POST', url: `/v1/projects/${a.id}/environments`, headers, payload: { applicationId, name: 'demo' } });
  expect(environment.json().access).toBe('protected');
  expect((await api.inject({ method: 'POST', url: `/v1/projects/${b.id}/environments`, headers, payload: { applicationId, name: 'wrong' } })).statusCode).toBe(404);
  await expect(database.admin.query('INSERT INTO itervane.environments(project_id,application_id,name) VALUES($1,$2,$3)', [b.id, applicationId, 'bypass'])).rejects.toMatchObject({ code: '23503' });
});

it('commits the task, run, event and correctly typed wakeup together and fences request content', async () => {
  const input = await registered();
  const responses = await Promise.all([admit(input), admit({ ...input, source: { commit: input.source.commit, repositoryId: input.source.repositoryId } })]);
  expect(responses.map(value => value.statusCode).sort()).toEqual([200, 202]);
  const [a, b] = responses.map(value => admissionDtoSchema.parse(value.json()));
  expect(a!.task.id).toBe(b!.task.id);
  const jobs = await database.storage.boss.findJobs(queueName);
  expect(jobs).toHaveLength(1);
  expect(wakeupSchema.parse(jobs[0]!.data)).toEqual({ taskId: a!.task.id, runId: a!.task.runId, generation: 1 });
  for (const table of ['tasks', 'task_runs', 'task_events']) expect((await database.admin.query(`SELECT * FROM itervane.${table}`)).rowCount).toBe(1);
  expect((await admit({ ...input, purpose: 'Different request' })).statusCode).toBe(409);
  expect((await admit({ ...input, dataClass: 'public' })).statusCode).toBe(409);
});

it('rolls back the real queue insertion when a later domain write fails', async () => {
  const input = await registered();
  await database.admin.query("ALTER TABLE itervane.task_events ADD CONSTRAINT injected_admission_failure CHECK(type <> 'task.accepted') NOT VALID");
  try { expect((await admit(input)).statusCode).toBe(500); }
  finally { await database.admin.query('ALTER TABLE itervane.task_events DROP CONSTRAINT injected_admission_failure'); }
  for (const table of ['tasks', 'task_runs', 'task_events']) expect((await database.admin.query(`SELECT * FROM itervane.${table}`)).rowCount).toBe(0);
  expect(await database.storage.boss.findJobs(queueName)).toHaveLength(0);
});

it('rejects a repository from a different project before admitting a task', async () => {
  const input = await registered(); const b = await project('other-project');
  expect((await admit({ ...input, projectId: b.id })).statusCode).toBe(404);
  expect((await database.admin.query('SELECT * FROM itervane.tasks')).rowCount).toBe(0);
});

it('uses current project membership instead of token role claims and applies revocation on the next command', async () => {
  const input = await registered();
  const otherHeaders = { authorization: `Bearer ${await issuer.token('viewer', { realm_access: { roles: ['admin'] } })}` };
  expect((await admit(input, otherHeaders)).statusCode).toBe(403);
  const principalId = randomUUID();
  await database.admin.query('INSERT INTO itervane.principals(id,issuer,subject) VALUES($1,$2,$3)', [principalId, issuer.config.issuer, 'viewer']);
  await database.admin.query("INSERT INTO itervane.project_members(project_id,principal_id,role) VALUES($1,$2,'viewer')", [input.projectId, principalId]);
  const list = () => api.inject({ url: `/v1/projects/${input.projectId}/repositories`, headers: otherHeaders });
  expect((await list()).statusCode).toBe(200);
  expect((await admit(input, otherHeaders)).statusCode).toBe(403);
  await database.admin.query('DELETE FROM itervane.project_members WHERE principal_id=$1', [principalId]);
  expect((await list()).statusCode).toBe(404);
});

it('cancels queued work atomically, rejects stale versions and makes duplicate cancellation idempotent', async () => {
  const input = await registered(); const accepted = admissionDtoSchema.parse((await admit(input)).json());
  const cancel = (expectedVersion: number) => api.inject({ method: 'POST', url: `/v1/tasks/${accepted.task.id}/cancel`, headers, payload: { expectedVersion } });
  expect((await cancel(99)).statusCode).toBe(409);
  const results = await Promise.all([cancel(1), cancel(1)]);
  for (const response of results) expect(taskDtoSchema.parse(response.json())).toMatchObject({ state: 'cancelled', version: 2 });
  expect((await database.storage.boss.findJobs(queueName))[0]!.state).toBe('cancelled');
  const events = await api.inject({ url: `/v1/tasks/${accepted.task.id}/events`, headers });
  expect(events.json().items.map((event: { type: string }) => event.type)).toEqual(['task.accepted', 'task.cancelled']);
  expect((await database.admin.query('SELECT state FROM itervane.task_runs')).rows).toEqual([{ state: 'cancelled' }]);
});

it('hides other-project tasks and events, and checks cancellation against current membership', async () => {
  const a = await registered('project-a'); const b = await registered('project-b');
  const taskA = admissionDtoSchema.parse((await admit(a)).json()).task;
  const taskB = admissionDtoSchema.parse((await admit(b)).json()).task;
  const principalId = randomUUID();
  await database.admin.query('INSERT INTO itervane.principals(id,issuer,subject) VALUES($1,$2,$3)', [principalId, issuer.config.issuer, 'reader']);
  await database.admin.query("INSERT INTO itervane.project_members(project_id,principal_id,role) VALUES($1,$2,'viewer')", [a.projectId, principalId]);
  const auth = { authorization: `Bearer ${await issuer.token('reader')}` };
  expect((await api.inject({ url: `/v1/tasks/${taskA.id}`, headers: auth })).statusCode).toBe(200);
  const projects = await api.inject({ url: '/v1/projects', headers: auth });
  expect(projects.json().items.map((item: { id: string }) => item.id)).toEqual([a.projectId]);
  for (const suffix of ['', '/events']) {
    expect((await api.inject({ url: `/v1/tasks/${taskB.id}${suffix}`, headers: auth })).statusCode).toBe(404);
  }
  const cancel = (id: string) => api.inject({ method: 'POST', url: `/v1/tasks/${id}/cancel`, headers: auth, payload: { expectedVersion: 1 } });
  expect((await cancel(taskB.id)).statusCode).toBe(404);
  expect((await cancel(taskA.id)).statusCode).toBe(403);
  await database.admin.query("UPDATE itervane.project_members SET role='maintainer' WHERE principal_id=$1", [principalId]);
  expect((await cancel(taskA.id)).statusCode).toBe(200);
});

it('rolls back cancellation in the queue when its domain event cannot be committed', async () => {
  const input = await registered(); const accepted = admissionDtoSchema.parse((await admit(input)).json());
  await database.admin.query("ALTER TABLE itervane.task_events ADD CONSTRAINT injected_cancel_failure CHECK(type <> 'task.cancelled') NOT VALID");
  try {
    const response = await api.inject({ method: 'POST', url: `/v1/tasks/${accepted.task.id}/cancel`, headers, payload: { expectedVersion: 1 } });
    expect(response.statusCode).toBe(500);
  } finally { await database.admin.query('ALTER TABLE itervane.task_events DROP CONSTRAINT injected_cancel_failure'); }
  expect((await database.storage.boss.findJobs(queueName))[0]!.state).toBe('created');
  expect((await database.admin.query('SELECT state,version FROM itervane.tasks')).rows).toEqual([{ state: 'queued', version: 1 }]);
  expect((await database.admin.query('SELECT * FROM itervane.task_events')).rowCount).toBe(1);
});

it('preserves tasks across a new API instance and database connection while keeping execution disabled', async () => {
  const input = await registered(); const task = admissionDtoSchema.parse((await admit(input)).json()).task;
  const connection = await openDatabase(database.runtimeUrl);
  const replacement = createApi(connection, issuer.config, { logger: false });
  try {
    const result = await replacement.inject({ url: `/v1/tasks/${task.id}`, headers });
    expect(taskDtoSchema.parse(result.json())).toEqual(task);
    const capabilities = await replacement.inject({ url: '/v1/capabilities', headers });
    expect(capabilities.json()).toMatchObject({ taskAdmission: true, taskExecution: false, deployment: false, operations: false });
  } finally { await replacement.close(); await connection.close(); }
});

it('runs without DDL and refuses altered migration history', async () => {
  await expect(openDatabase(database.adminUrl)).rejects.toThrow('runtime database role without DDL');
  await expect(database.storage.pool.query('CREATE TABLE itervane.forbidden_ddl(id integer)')).rejects.toMatchObject({ code: '42501' });
  await migrateDatabase(database.adminUrl);
  const original = await database.admin.query('SELECT id,hash FROM itervane_migrations.__drizzle_migrations ORDER BY id');
  const row = original.rows[0]!;
  await database.admin.query('UPDATE itervane_migrations.__drizzle_migrations SET hash=$1 WHERE id=$2', ['0'.repeat(64), row.id]);
  try { await expect(migrateDatabase(database.adminUrl)).rejects.toThrow('migration_history_conflict'); }
  finally { await database.admin.query('UPDATE itervane_migrations.__drizzle_migrations SET hash=$1 WHERE id=$2', [row.hash, row.id]); }
});

it('validates inputs and returns structured errors without leaking credentials or database details', async () => {
  const input = await registered();
  const bad = await admit({ ...input, actor: { kind: 'human' }, approved: true });
  expect(bad.statusCode).toBe(400); apiErrorSchema.parse(bad.json());
  const credential = 'synthetic-test-password';
  const invalidUrl = await api.inject({ method: 'POST', url: `/v1/projects/${input.projectId}/repositories`, headers,
    payload: { name: 'bad', url: `https://user:${credential}@example.invalid/repo` } });
  expect(invalidUrl.statusCode).toBe(400); expect(invalidUrl.body).not.toContain(credential);
  expect((await api.inject({ url: '/v1/projects?limit=101', headers })).statusCode).toBe(400);
  expect((await api.inject({ url: '/v1/projects?actor=owner', headers })).statusCode).toBe(400);
  const duplicate = await api.inject({ method: 'POST', url: '/v1/projects', headers, payload: { name: 'duplicate', slug: 'example' } });
  expect(duplicate.statusCode).toBe(409); expect(duplicate.body).not.toContain('constraint');
});

it('treats invalid server output as an internal error and keeps request content out of logs', async () => {
  const registeredOwner = await owner();
  const invalidOutput = vi.spyOn(ResourceService.prototype, 'me').mockResolvedValueOnce({ principalId: 'invalid-id', workspaceId: registeredOwner.workspaceId, isWorkspaceOwner: true });
  try {
    const response = await api.inject({ url: '/v1/me', headers });
    expect(response.statusCode).toBe(500); expect(response.json().error.code).toBe('internal_error');
  } finally { invalidOutput.mockRestore(); }
  const captured: unknown[] = [];
  const info = vi.spyOn(api.log, 'info').mockImplementation((...values: unknown[]) => { captured.push(values); });
  const warn = vi.spyOn(api.log, 'warn').mockImplementation((...values: unknown[]) => { captured.push(values); });
  const marker = 'synthetic-private-request-marker';
  try {
    const response = await api.inject({ url: `/v1/projects?secret=${marker}`, headers: { ...headers, 'request-id': marker } });
    expect(response.statusCode).toBe(400); expect(response.json().error.requestId).not.toBe(marker);
    expect(captured.length).toBeGreaterThan(0); expect(JSON.stringify(captured)).not.toContain(marker);
    expect(JSON.stringify(captured)).not.toContain(headers.authorization);
  } finally { info.mockRestore(); warn.mockRestore(); }
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    database.storage.pool.emit('error', new Error(marker));
    database.storage.boss.emit('error', new Error(marker));
    expect(diagnostic).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(marker);
    expect(JSON.stringify(diagnostic.mock.calls)).toContain('infrastructure_error');
  } finally { diagnostic.mockRestore(); }
});

it('serves the same authenticated API over a real loopback HTTP connection', async () => {
  await owner();
  const network = createApi(database.storage, issuer.config, { logger: false });
  const address = await network.listen({ host: '127.0.0.1', port: 0 });
  try {
    expect((await fetch(`${address}/health/live`)).status).toBe(200);
    expect((await fetch(`${address}/v1/me`)).status).toBe(401);
    const response = await fetch(`${address}/v1/me`, { headers });
    expect(response.status).toBe(200); expect((await response.json()).isWorkspaceOwner).toBe(true);
  } finally { await network.close(); }
});
