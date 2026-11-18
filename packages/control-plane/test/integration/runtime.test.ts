import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { emptyCheckpoint } from '@langchain/langgraph-checkpoint';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { createIdentityVerifier, type VerifiedIdentity } from '../../src/auth/identity.js';
import { queueName } from '../../src/persistence/database.js';
import { bootstrapOwner, ResourceService } from '../../src/service/resources.js';
import { TaskService } from '../../src/service/tasks.js';
import { ExecutionCoordinator } from '../../src/runtime/coordinator.js';
import { ExecutionLost, BudgetExhausted } from '../../src/runtime/authority.js';
import { GuardedCheckpointer } from '../../src/runtime/checkpointer.js';
import { ToolGateway } from '../../src/runtime/tools.js';
import { DurableWorker } from '../../src/runtime/worker.js';
import { databaseFixture } from '../helpers/database.js';
import { identityFixture } from '../helpers/identity.js';

let database: Awaited<ReturnType<typeof databaseFixture>>;
let issuer: Awaited<ReturnType<typeof identityFixture>>;
let identity: VerifiedIdentity;
let service: TaskService;
let coordinator: ExecutionCoordinator;
let source: { repositoryId: string; commit: string };
let projectId: string;
const workers: DurableWorker[] = [];
const worker = () => { const instance = new DurableWorker(database.storage, database.runtimeUrl); workers.push(instance); return instance; };
const admit = (locale: 'en' | 'zh-CN' = 'en') => service.admit(identity, { projectId, source, purpose: 'Preflight only', dataClass: 'synthetic', locale, idempotencyKey: randomUUID() });
const claim = async () => {
  const [job] = await database.storage.boss.fetch(queueName);
  if (!job) throw new Error('Expected a queued wakeup');
  const scope = await coordinator.claim(job, randomUUID());
  if (!scope) throw new Error('Expected execution authority');
  return scope;
};

beforeAll(async () => {
  database = await databaseFixture(); issuer = await identityFixture();
  identity = await createIdentityVerifier(issuer.config)(await issuer.token());
});
beforeEach(async () => {
  await database.reset();
  await bootstrapOwner(database.storage, { issuer: issuer.config.issuer, subject: 'owner' });
  const resources = new ResourceService(database.storage);
  projectId = (await resources.createProject(identity, { name: 'Preflight fixture', slug: 'preflight' })).id;
  const repository = await resources.registerRepository(identity, projectId, { name: 'fixture', url: 'https://example.invalid/fixture.git' });
  source = { repositoryId: repository.id, commit: 'c'.repeat(40) };
  service = new TaskService(database.storage); coordinator = new ExecutionCoordinator(database.storage);
});
afterEach(async () => { await Promise.all(workers.splice(0).map(instance => instance.close())); });
afterAll(async () => { await issuer?.close(); await database?.close(); });

it('grants only one global execution slot to two independent competing consumers', async () => {
  await admit(); await admit();
  const [a, b] = await Promise.all([database.storage.boss.fetch(queueName), database.storage.boss.fetch(queueName)]);
  expect(a).toHaveLength(1); expect(b).toHaveLength(1);
  const scopes = await Promise.all([coordinator.claim(a[0]!, randomUUID()), coordinator.claim(b[0]!, randomUUID())]);
  expect(scopes.filter(Boolean)).toHaveLength(1);
  expect((await database.admin.query("SELECT state,count(*)::int AS count FROM itervane.tasks GROUP BY state ORDER BY state")).rows)
    .toEqual([{ state: 'queued', count: 1 }, { state: 'running', count: 1 }]);
  expect((await database.storage.boss.findJobs(queueName)).filter(job => job.state === 'created')).toHaveLength(1);
  expect(await coordinator.claim(a[0]!, randomUUID())).toBeNull();
});

it('recovers a crashed domain owner and refuses the old fence before tools or writes', async () => {
  const accepted = await admit(); const old = await claim();
  await database.admin.query("UPDATE itervane.execution_slot SET lease_until=clock_timestamp()-interval '1 second'");
  await coordinator.reconcile(randomUUID()); const next = await claim();
  expect(next.runId).toBe(old.runId); expect(next.fence).toBeGreaterThan(old.fence);
  await expect(coordinator.heartbeat(old)).rejects.toBeInstanceOf(ExecutionLost);
  await expect(new ToolGateway(coordinator).call(old, 'project.describe', {}, 'stale')).rejects.toBeInstanceOf(ExecutionLost);
  expect((await database.admin.query('SELECT * FROM itervane.tool_calls')).rowCount).toBe(0);
  expect((await service.events(identity, accepted.task.id, 100)).map(event => event.type))
    .toEqual(['task.accepted', 'task.started', 'task.recovered', 'task.started']);
});

it('rechecks expiry after acquiring a contended slot and also rolls back expiry during a write', async () => {
  await admit(); const scope = await claim();
  await database.admin.query("UPDATE itervane.execution_slot SET lease_until=clock_timestamp()+interval '500 milliseconds'");
  const locker = await database.admin.connect(); let entered = false;
  let pending: Promise<unknown>;
  await locker.query('BEGIN');
  try {
    await locker.query('SELECT id FROM itervane.execution_slot FOR UPDATE');
    pending = coordinator.withLease(scope, async () => { entered = true; });
    // Attach the rejection handler before releasing the lock.
    const rejected = expect(pending).rejects.toBeInstanceOf(ExecutionLost);
    await locker.query('SELECT pg_sleep(0.75)');
    expect((await locker.query('SELECT lease_until<clock_timestamp() AS expired FROM itervane.execution_slot')).rows[0]?.expired).toBe(true);
    await locker.query('ROLLBACK'); await rejected;
  } finally { await locker.query('ROLLBACK'); locker.release(); }
  expect(entered).toBe(false);
  await coordinator.reconcile(randomUUID()); const next = await claim();
  await database.admin.query("UPDATE itervane.execution_slot SET lease_until=clock_timestamp()+interval '100 milliseconds'");
  await expect(coordinator.withLease(next, async tx => { await tx.execute('SELECT pg_sleep(0.3)'); })).rejects.toBeInstanceOf(ExecutionLost);
});

it('recreates a missing or prematurely completed wakeup without losing the accepted task', async () => {
  const accepted = await admit(); const [stranded] = await database.storage.boss.fetch(queueName);
  await database.storage.boss.complete(queueName, stranded!);
  await coordinator.reconcile(randomUUID()); const scope = await claim();
  expect(scope.taskId).toBe(accepted.task.id);
  expect((await database.admin.query('SELECT * FROM itervane.tasks')).rowCount).toBe(1);
});

it('stops new tools immediately after running cancellation and acknowledges it separately', async () => {
  const accepted = await admit(); const scope = await claim();
  const running = await service.get(identity, accepted.task.id);
  const cancelled = await service.cancel(identity, running.id, { expectedVersion: running.version });
  expect(cancelled.state).toBe('cancel_requested');
  expect(await coordinator.heartbeat(scope)).toBe(false);
  await expect(new ToolGateway(coordinator).call(scope, 'project.describe', {}, 'cancelled')).rejects.toBeInstanceOf(ExecutionLost);
  await coordinator.stop(scope, 'cancelled');
  expect((await service.get(identity, running.id)).state).toBe('cancelled');
  expect((await database.admin.query('SELECT task_id FROM itervane.execution_slot')).rows[0]?.task_id).toBeNull();
});

it('checks current stored membership on tools and claim, and allows safe stop after revocation', async () => {
  await admit(); const scope = await claim();
  await database.admin.query('DELETE FROM itervane.workspace_members');
  await expect(new ToolGateway(coordinator).call(scope, 'project.describe', {}, 'revoked')).rejects.toMatchObject({ code: 'not_found' });
  await coordinator.stop(scope, 'permission_revoked');
  expect((await database.admin.query('SELECT state FROM itervane.tasks')).rows[0]?.state).toBe('needs_human');
  await database.admin.query('INSERT INTO itervane.workspace_members(workspace_id,principal_id) SELECT id,(SELECT id FROM itervane.principals) FROM itervane.workspaces');
  await admit(); await database.admin.query('DELETE FROM itervane.workspace_members');
  const [job] = await database.storage.boss.fetch(queueName);
  expect(await coordinator.claim(job!, randomUUID())).toBeNull();
  expect((await database.admin.query("SELECT * FROM itervane.tasks WHERE state='needs_human'")).rowCount).toBe(2);
});

it('releases the slot while waiting for a same-project child and rejects wait cycles', async () => {
  const parent = await admit(); const parentScope = await claim(); const child = await admit();
  await expect(coordinator.waitForChild(parentScope, parent.task.id)).rejects.toMatchObject({ code: 'invalid_input' });
  await coordinator.waitForChild(parentScope, child.task.id);
  const childScope = await claim();
  expect(childScope.taskId).toBe(child.task.id);
  expect((await service.get(identity, parent.task.id)).state).toBe('waiting_input');
  await expect(coordinator.waitForChild(childScope, parent.task.id)).rejects.toMatchObject({ code: 'conflict' });
  await expect(service.resume(identity, parent.task.id, { expectedVersion: 3 })).rejects.toMatchObject({ code: 'unsupported_state' });
});

it('deduplicates read observations, charges a persistent budget and refuses commands or foreign targets', async () => {
  await admit(); const scope = await claim(); const gateway = new ToolGateway(coordinator);
  await database.admin.query('UPDATE itervane.run_runtime SET max_tools=3');
  const [result, concurrent] = await Promise.all([gateway.call(scope, 'project.describe', {}, 'metadata'), gateway.call(scope, 'project.describe', {}, 'metadata')]);
  expect(concurrent).toEqual(result);
  expect(result).toMatchObject({ status: 'success', data: { projectId, repositoryId: source.repositoryId, commit: source.commit } });
  expect(await gateway.call(scope, 'project.describe', {}, 'metadata')).toEqual(result);
  await expect(gateway.call(scope, 'project.describe', { projectId: randomUUID() }, 'metadata')).rejects.toMatchObject({ code: 'idempotency_conflict' });
  expect(await gateway.call(scope, 'shell.exec', { command: 'synthetic-forbidden-command' }, 'shell')).toEqual({ status: 'business_error', code: 'tool_denied', retryable: false });
  expect(await gateway.call(scope, 'project.describe', { projectId: randomUUID() }, 'foreign')).toMatchObject({ status: 'business_error', code: 'invalid_arguments' });
  await expect(gateway.call(scope, 'source.inspect', {}, 'exhausted')).rejects.toBeInstanceOf(BudgetExhausted);
  expect((await database.admin.query('SELECT tools_used FROM itervane.run_runtime')).rows[0]?.tools_used).toBe(3);
  expect(JSON.stringify((await database.admin.query('SELECT * FROM itervane.tool_calls')).rows)).not.toContain('synthetic-forbidden-command');
});

it('persists a real graph interrupt, releases the slot, resumes once and preserves language and budget', async () => {
  const accepted = await admit('zh-CN'); const first = worker();
  expect(await first.tick()).toBe(true);
  const paused = await service.get(identity, accepted.task.id);
  expect(paused.state).toBe('waiting_input'); expect(paused.locale).toBe('zh-CN');
  const before = (await database.admin.query('SELECT * FROM itervane.run_runtime')).rows[0]!;
  expect(before.checkpoint_id).toBeTruthy(); expect(before.tools_used).toBe(2);
  await first.close(); workers.splice(workers.indexOf(first), 1);
  const resumes = await Promise.allSettled([service.resume(identity, paused.id, { expectedVersion: paused.version }), service.resume(identity, paused.id, { expectedVersion: paused.version })]);
  expect(resumes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(resumes.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'version_conflict' } });
  expect(await worker().tick()).toBe(true);
  const after = (await database.admin.query('SELECT * FROM itervane.run_runtime')).rows[0]!;
  expect(after.tools_used).toBe(3); expect(after.resume_count).toBe(1); expect(after.checkpoint_id).not.toBe(before.checkpoint_id);
  expect((await service.get(identity, paused.id))).toMatchObject({ state: 'waiting_input', locale: 'zh-CN' });
  const events = await service.events(identity, paused.id, 100, 'zh-CN');
  expect(events.some(event => event.actorKind === 'worker' && event.workerId)).toBe(true);
  expect(events.at(-1)?.message).toBe('任务正在等待经过验证的 Runner。');
  await service.cancel(identity, paused.id, { expectedVersion: (await service.get(identity, paused.id)).version });
  expect((await service.get(identity, paused.id)).state).toBe('cancelled');
});

it('bounds manual retries without resetting the tool budget or opening the Runner gate', async () => {
  const accepted = await admit(); const instance = worker(); await instance.tick();
  for (let attempt = 0; attempt < 3; attempt++) {
    const paused = await service.get(identity, accepted.task.id);
    await service.resume(identity, paused.id, { expectedVersion: paused.version }); await instance.tick();
  }
  const paused = await service.get(identity, accepted.task.id);
  expect(paused.state).toBe('waiting_input');
  await expect(service.resume(identity, paused.id, { expectedVersion: paused.version })).rejects.toMatchObject({ code: 'resume_limit' });
  expect((await database.admin.query('SELECT tools_used FROM itervane.run_runtime')).rows[0]?.tools_used).toBe(5);
});

it('ignores unpublished checkpoints and pending writes after a real saver commit and domain rollback', async () => {
  await admit(); const scope = await claim();
  const storage = PostgresSaver.fromConnString(database.runtimeUrl, { schema: 'itervane_checkpoint' });
  const guard = new GuardedCheckpointer(coordinator, scope, storage);
  const config = { configurable: { thread_id: scope.runId } };
  const first = emptyCheckpoint(); const second = emptyCheckpoint();
  try {
    const bound = await guard.put(config, first, { source: 'input', step: 0, parents: {} }, {});
    await database.admin.query(`ALTER TABLE itervane.run_runtime ADD CONSTRAINT injected_publish_failure CHECK(checkpoint_id <> '${second.id}') NOT VALID`);
    try { await expect(guard.put(bound, second, { source: 'loop', step: 1, parents: {} }, {})).rejects.toThrow(); }
    finally { await database.admin.query('ALTER TABLE itervane.run_runtime DROP CONSTRAINT injected_publish_failure'); }
    expect((await storage.getTuple(config))?.checkpoint.id).toBe(second.id);
    expect((await guard.getTuple(config))?.checkpoint.id).toBe(first.id);
    await database.admin.query('ALTER TABLE itervane.checkpoint_write_receipts ADD CONSTRAINT injected_writes_failure CHECK(false) NOT VALID');
    try { await expect(guard.putWrites(bound, [['registered', true]], randomUUID())).rejects.toThrow(); }
    finally { await database.admin.query('ALTER TABLE itervane.checkpoint_write_receipts DROP CONSTRAINT injected_writes_failure'); }
    expect((await storage.getTuple(bound))?.pendingWrites).toHaveLength(1);
    expect((await guard.getTuple(config))?.pendingWrites).toHaveLength(0);
    await guard.putWrites(bound, [['registered', true]], 'published-node');
    expect((await guard.getTuple(config))?.pendingWrites).toEqual([['published-node', 'registered', true]]);
    await database.admin.query("UPDATE itervane.execution_slot SET lease_until=clock_timestamp()-interval '1 second'");
    await expect(guard.putWrites(bound, [['registered', false]], 'stale-node')).rejects.toBeInstanceOf(ExecutionLost);
    await expect(guard.put(bound, emptyCheckpoint(), { source: 'loop', step: 2, parents: {} }, {})).rejects.toBeInstanceOf(ExecutionLost);
  } finally { await storage.end(); }
});

it('recovers a published interrupt after killing an actual Worker process before the domain pause', async () => {
  const accepted = await admit();
  const child = fork(fileURLToPath(new URL('../helpers/durable-worker.ts', import.meta.url)), [], {
    execArgv: ['--import', 'tsx'], silent: true,
    env: { DATABASE_URL: database.runtimeUrl, SystemRoot: process.env.SystemRoot },
  });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  try {
    const checkpoint = await new Promise<{ taskId: string; checkpointId: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Worker checkpoint timeout')), 15_000);
      child.once('error', reject);
      child.once('message', value => { clearTimeout(timeout); resolve(value as { taskId: string; checkpointId: string }); });
      child.once('exit', () => { clearTimeout(timeout); reject(new Error('Worker exited before checkpoint')); });
    });
    expect(checkpoint.taskId).toBe(accepted.task.id); expect(checkpoint.checkpointId).toBeTruthy();
    child.kill('SIGKILL'); await exited;
    expect((await service.get(identity, accepted.task.id)).state).toBe('running');
    await database.admin.query("UPDATE itervane.execution_slot SET lease_until=clock_timestamp()-interval '1 second'");
    await worker().tick();
    expect((await service.get(identity, accepted.task.id)).state).toBe('waiting_input');
    expect((await database.admin.query('SELECT tools_used FROM itervane.run_runtime')).rows[0]?.tools_used).toBe(2);
    expect((await service.events(identity, accepted.task.id, 100)).some(event => event.type === 'task.recovered')).toBe(true);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; }
});
