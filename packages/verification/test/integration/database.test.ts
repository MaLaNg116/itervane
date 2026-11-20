import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { Annotation, Command, END, START, StateGraph, interrupt } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { openDatabaseProbe } from '../../src/database.js';

describe('real PostgreSQL 17 admission and recovery', () => {
  let probe: Awaited<ReturnType<typeof openDatabaseProbe>>;
  beforeEach(async () => {
    if (!process.env.DATABASE_URL) throw new Error('Run through pnpm test:integration or configure a disposable database');
    probe = await openDatabaseProbe(process.env.DATABASE_URL);
  });
  afterEach(async () => { if (probe) await probe.close(); });
  const input = () => ({ projectId: randomUUID(), principalId: randomUUID(), requestKey: randomUUID(), snapshot: 'a'.repeat(40) });

  it('rolls back admission and queue insertion together through the Drizzle adapter', async () => {
    await expect(probe.admit(input(), true)).rejects.toThrow('injected_rollback');
    expect(await probe.db.select().from(probe.admissions)).toHaveLength(0);
    expect(await probe.boss.findJobs('workflow')).toHaveLength(0);
  });

  it('commits an admission and exactly one wakeup together', async () => {
    const admitted = await probe.admit(input());
    expect(await probe.db.select().from(probe.admissions)).toHaveLength(1);
    const jobs = await probe.boss.findJobs<{ taskId: string }>('workflow');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.id).toBe(admitted.jobId);
    expect(jobs[0]?.data.taskId).toBe(admitted.taskId);
  });

  it('deduplicates concurrent admission and rejects changed content under the same key', async () => {
    const request = input();
    const [a, b] = await Promise.all([probe.admit(request), probe.admit(request)]);
    expect(a.taskId).toBe(b.taskId);
    expect(await probe.boss.findJobs('workflow')).toHaveLength(1);
    await expect(probe.admit({ ...request, snapshot: 'b'.repeat(40) })).rejects.toThrow('idempotency_conflict');
  });

  it('does not give the same wakeup to two concurrent consumers', async () => {
    await probe.admit(input());
    const [a, b] = await Promise.all([probe.boss.fetch('workflow'), probe.boss.fetch('workflow')]);
    expect(a.length + b.length).toBe(1);
  });

  it('enforces one global execution slot and fences an expired owner', async () => {
    const ownerA = randomUUID(); const ownerB = randomUUID();
    const [a, b] = await Promise.all([probe.acquire(ownerA), probe.acquire(ownerB)]);
    expect([a, b].filter(x => x !== undefined)).toHaveLength(1);
    const oldOwner = a !== undefined ? ownerA : ownerB;
    const generation = a ?? b;
    expect(await probe.isCurrent(oldOwner, generation!)).toBe(true);
    expect(await probe.recordObservation(oldOwner, generation!, 'current-evidence')).toBe(true);
    await probe.pool.query(`UPDATE ${probe.schemaName}.execution_slot SET lease_until=clock_timestamp()-interval '1 second' WHERE slot=1`);
    const newGeneration = await probe.acquire(randomUUID());
    expect(newGeneration).toBeGreaterThan(generation!);
    expect(await probe.isCurrent(oldOwner, generation!)).toBe(false);
    expect(await probe.recordObservation(oldOwner, generation!, 'stale-evidence')).toBe(false);
    const observations = await probe.pool.query(`SELECT value FROM ${probe.schemaName}.observations`);
    expect(observations.rows).toEqual([{ value: 'current-evidence' }]);
  });

  it('cancels a queued wakeup without claiming it', async () => {
    const admission = await probe.admit(input());
    await probe.boss.cancel('workflow', admission.jobId!);
    expect(await probe.boss.fetch('workflow')).toHaveLength(0);
    expect((await probe.boss.findJobs('workflow'))[0]?.state).toBe('cancelled');
  });

  it('rechecks lease expiry after waiting for another transaction to release the authority row', async () => {
    const owner = randomUUID();
    const generation = await probe.acquire(owner);
    await probe.pool.query(`UPDATE ${probe.schemaName}.execution_slot SET lease_until=clock_timestamp()+interval '500 milliseconds' WHERE slot=1`);
    const locker = await probe.pool.connect();
    let pending: Promise<boolean> | undefined;
    try {
      await locker.query('BEGIN');
      await locker.query(`SELECT 1 FROM ${probe.schemaName}.execution_slot WHERE slot=1 FOR UPDATE`);
      pending = probe.recordObservation(owner, generation!, 'expired-while-waiting');
      // 用数据库所在主机的时间等待，避免 Windows 与 Docker VM 的时钟调度差异。
      await locker.query('SELECT pg_sleep(0.75)');
      expect((await locker.query(`SELECT lease_until < clock_timestamp() AS expired FROM ${probe.schemaName}.execution_slot WHERE slot=1`)).rows[0]?.expired).toBe(true);
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
    }
    expect(await pending).toBe(false);
    expect((await probe.pool.query(`SELECT 1 FROM ${probe.schemaName}.observations`)).rowCount).toBe(0);
  });

  it('bounds retries without creating a new logical wakeup', async () => {
    const admission = await probe.admit(input());
    const [first] = await probe.boss.fetch('workflow');
    expect(first?.id).toBe(admission.jobId);
    await probe.boss.fail('workflow', first!, { reason: 'injected-transient-failure' });
    const [retry] = await probe.boss.fetch('workflow');
    expect(retry?.id).toBe(first?.id);
    expect(retry?.retryCount).toBe(1);
    await probe.boss.fail('workflow', retry!, { reason: 'injected-repeat-failure' });
    expect(await probe.boss.fetch('workflow')).toHaveLength(0);
    expect((await probe.boss.findJobs('workflow'))[0]?.state).toBe('failed');
    expect(await probe.db.select().from(probe.admissions)).toHaveLength(1);
  });

  it('recovers an expired claim after terminating a real worker process', async () => {
    const queueName = 'crash-recovery';
    await probe.boss.createQueue(queueName, { expireInSeconds: 1, retryLimit: 1, retryDelay: 0 });
    const jobId = await probe.boss.send(queueName, { taskId: randomUUID() });
    const worker = fork(fileURLToPath(new URL('../helpers/crash-worker.mjs', import.meta.url)), [], {
      execArgv: [], silent: true,
      env: { DATABASE_URL: process.env.DATABASE_URL, ITERVANE_QUEUE_SCHEMA: probe.queueSchema, SystemRoot: process.env.SystemRoot },
    });
    const exited = new Promise<void>(resolveExit => worker.once('exit', () => resolveExit()));
    try {
      const claimed = await new Promise<unknown>((resolveClaim, rejectClaim) => {
        const timeout = setTimeout(() => rejectClaim(new Error('Worker claim timed out')), 10_000);
        worker.once('message', value => { clearTimeout(timeout); resolveClaim(value); });
        worker.once('error', () => { clearTimeout(timeout); rejectClaim(new Error('Worker failed to start')); });
        worker.once('exit', () => { clearTimeout(timeout); rejectClaim(new Error('Worker exited before reporting a claim')); });
      });
      expect(claimed).toEqual({ jobId });
      worker.kill('SIGKILL');
      await exited;
      expect((await probe.boss.findJobs(queueName))[0]?.state).toBe('active');
      const queue = await probe.boss.getQueue(queueName);
      if (!queue) throw new Error('Missing recovery queue');
      const schema = sql.identifier(probe.queueSchema);
      // Supervision stamps its monitor time. PostgreSQL must observe expiry before the first pass.
      await vi.waitFor(async () => {
        const check = await probe.db.execute<{ expired: boolean }>(sql`
          SELECT started_on + expire_seconds * interval '1 second' < ${schema}.job_now() AS expired
          FROM ${schema}.${sql.identifier(queue.table)} WHERE name = ${queueName} AND id = ${jobId}`);
        expect(check.rows[0]?.expired).toBe(true);
      }, { timeout: 8_000, interval: 100 });
      await probe.boss.supervise(queueName);
      const recovered = await vi.waitFor(async () => {
        const [job] = await probe.boss.fetch(queueName);
        if (!job) throw new Error('Waiting for recovered job');
        return job;
      }, { timeout: 5_000, interval: 100 });
      expect(recovered?.id).toBe(jobId);
      expect(recovered?.retryCount).toBe(1);
      await probe.boss.complete(queueName, recovered!);
      expect((await probe.boss.findJobs(queueName))[0]?.state).toBe('completed');
    } finally {
      if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
      await exited;
    }
  });

  it('preserves accepted admission even when the first checkpoint never existed', async () => {
    const admission = await probe.admit(input());
    const saver = PostgresSaver.fromConnString(process.env.DATABASE_URL!, { schema: probe.checkpointSchema });
    try {
      await saver.setup();
      expect(await saver.getTuple({ configurable: { thread_id: admission.taskId } })).toBeUndefined();
      expect((await probe.db.select().from(probe.admissions))[0]?.id).toBe(admission.taskId);
      expect((await probe.boss.fetch<{ taskId: string }>('workflow'))[0]?.data.taskId).toBe(admission.taskId);
    } finally { await saver.end(); }
  });

  it('restores an interrupted graph through a new checkpointer connection without granting authority', async () => {
    const state = Annotation.Root({ observation: Annotation<string>() });
    const build = (saver: PostgresSaver) => new StateGraph(state)
      .addNode('observe', () => ({ observation: String(interrupt({ reason: 'awaiting-probe-observation' })) }))
      .addEdge(START, 'observe').addEdge('observe', END).compile({ checkpointer: saver });
    const config = { configurable: { thread_id: randomUUID() } };
    const first = PostgresSaver.fromConnString(process.env.DATABASE_URL!, { schema: probe.checkpointSchema });
    await first.setup();
    await build(first).invoke({ observation: '' }, config);
    await first.end();
    const second = PostgresSaver.fromConnString(process.env.DATABASE_URL!, { schema: probe.checkpointSchema });
    try {
      expect(await second.getTuple(config)).toBeDefined();
      const resumed = await build(second).invoke(new Command({ resume: 'observed-after-reconnect' }), config);
      expect(resumed.observation).toBe('observed-after-reconnect');
      expect(resumed).not.toHaveProperty('approved');
    } finally { await second.end(); }
  });
});
