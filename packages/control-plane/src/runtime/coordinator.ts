import { and, eq, sql } from 'drizzle-orm';
import { fromDrizzle, type Job } from 'pg-boss';
import { idSchema, wakeupSchema, type SourceInspectionPauseReason, type TaskEventReason } from '@itervane/contracts';
import { queueName, type Database } from '../persistence/database.js';
import { executionSlot, runRuntime, taskRuns, tasks } from '../persistence/schema.js';
import { requireProject, requireStoredActor, type Transaction } from '../service/access.js';
import { DomainError } from '../service/errors.js';
import { appendEvent, clearSlot, enqueue, ExecutionLost, lockSlot, type ExecutionScope, type TaskRow } from './authority.js';

type Current = { task: TaskRow; runtime: typeof runRuntime.$inferSelect };
export class ExecutionCoordinator {
  readonly leaseSeconds: number;
  constructor(readonly database: Database, options: { leaseSeconds?: number } = {}) {
    this.leaseSeconds = options.leaseSeconds ?? 10;
    if (!Number.isInteger(this.leaseSeconds) || this.leaseSeconds < 2 || this.leaseSeconds > 60) throw new Error('Invalid lease duration');
  }

  async withLease<T>(scope: ExecutionScope, action: (tx: Transaction, current: Current) => Promise<T>, options: { allowCancel?: boolean; authorize?: boolean } = {}) {
    return this.database.db.transaction(async tx => {
      const slot = await lockSlot(tx);
      const [task] = await tx.select().from(tasks).where(eq(tasks.id, scope.taskId)).for('update');
      const [run] = await tx.select().from(taskRuns).where(eq(taskRuns.id, scope.runId));
      const [runtime] = await tx.select().from(runRuntime).where(eq(runRuntime.runId, scope.runId));
      if (!task || !run || !runtime || !slot.live || slot.taskId !== task.id || slot.runId !== run.id || slot.workerId !== scope.workerId || slot.fence !== scope.fence
        || task.generation !== scope.generation || run.taskId !== task.id || runtime.taskId !== task.id || run.generation !== scope.generation
        || (task.state !== 'running' && !(options.allowCancel && task.state === 'cancel_requested'))) throw new ExecutionLost();
      if (options.authorize !== false) await requireProject(tx, await requireStoredActor(tx, task.requestedBy), task.projectId, true);
      const result = await action(tx, { task, runtime });
      // 释放 slot 也不能绕过租约检查；心跳则使用本次延长后的截止时间。
      const [valid] = await tx.select({ live: sql<boolean>`CASE WHEN ${executionSlot.taskId} IS NULL
        THEN ${slot.leaseUntil}::timestamptz > clock_timestamp()
        ELSE ${executionSlot.leaseUntil} > clock_timestamp() END` }).from(executionSlot).where(eq(executionSlot.id, 1));
      if (!valid?.live) throw new ExecutionLost();
      return result;
    });
  }

  private async recoverExpired(tx: Transaction, workerId: string) {
    const slot = await lockSlot(tx);
    if (!slot.taskId || slot.live) return;
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, slot.taskId)).for('update');
    if (task && slot.runId) {
      if (task.state === 'cancel_requested') await appendEvent(tx, task, 'task.cancelled', 'cancelled', { workerId, reason: 'expired_cancel' });
      else if (task.state === 'running') {
        const next = await appendEvent(tx, task, 'task.recovered', 'queued', { workerId, reason: 'lease_expired' });
        await enqueue(tx, this.database, next, slot.runId);
      }
    }
    await clearSlot(tx);
  }

  async claim(job: Job<unknown>, workerId: string): Promise<ExecutionScope | null> {
    idSchema.parse(workerId);
    const parsed = wakeupSchema.safeParse(job.data);
    return this.database.db.transaction(async tx => {
      await this.recoverExpired(tx, workerId);
      const slot = await lockSlot(tx);
      const settle = () => this.database.boss.complete(queueName, job, undefined, { db: fromDrizzle(tx, sql) });
      if (!parsed.success) { await settle(); return null; }
      const input = parsed.data;
      const [task] = await tx.select().from(tasks).where(eq(tasks.id, input.taskId)).for('update');
      const [run] = await tx.select().from(taskRuns).where(eq(taskRuns.id, input.runId));
      if (!task || !run || task.state !== 'queued' || task.generation !== input.generation || run.taskId !== task.id
        || run.generation !== input.generation || run.wakeupJobId !== job.id) { await settle(); return null; }
      if (slot.taskId && slot.live) {
        await settle(); await enqueue(tx, this.database, task, run.id, true); return null;
      }
      try { await requireProject(tx, await requireStoredActor(tx, task.requestedBy), task.projectId, true); }
      catch (error) {
        if (!(error instanceof DomainError)) throw error;
        await appendEvent(tx, task, 'task.needs_human', 'needs_human', { workerId, reason: 'permission_revoked' });
        await settle(); return null;
      }
      const completed = await settle();
      if (completed.affected !== 1) return null;
      await appendEvent(tx, task, 'task.started', 'running', { workerId });
      const [assignment] = await tx.update(executionSlot).set({ taskId: task.id, runId: run.id, workerId,
        fence: sql`${executionSlot.fence} + 1`, leaseUntil: sql`clock_timestamp() + ${this.leaseSeconds} * interval '1 second'` })
        .where(eq(executionSlot.id, 1)).returning();
      return Object.freeze({ taskId: task.id, runId: run.id, generation: task.generation, workerId, fence: assignment!.fence });
    });
  }

  async heartbeat(scope: ExecutionScope): Promise<boolean> {
    return this.withLease(scope, async (tx, { task }) => {
      if (task.state === 'cancel_requested') return false;
      const [renewed] = await tx.update(executionSlot).set({ leaseUntil: sql`clock_timestamp() + ${this.leaseSeconds} * interval '1 second'` })
        .where(and(eq(executionSlot.id, 1), sql`${executionSlot.leaseUntil} > clock_timestamp()`)).returning({ id: executionSlot.id });
      if (!renewed) throw new ExecutionLost();
      return true;
    }, { allowCancel: true });
  }

  async pause(scope: ExecutionScope, reason: SourceInspectionPauseReason = 'runner_unavailable') {
    await this.withLease(scope, async (tx, { task, runtime }) => {
      if (!runtime.checkpointId) throw new DomainError('unavailable');
      await tx.update(runRuntime).set({ reason, resumePending: false, waitingForTaskId: null }).where(eq(runRuntime.runId, scope.runId));
      const event = reason === 'runner_unavailable' ? 'task.paused' : 'task.inspection_paused';
      await appendEvent(tx, task, event, 'waiting_input', { workerId: scope.workerId, reason });
      await clearSlot(tx);
    });
  }

  async stop(scope: ExecutionScope, reason: TaskEventReason, onlyIfCancelled = false) {
    await this.withLease(scope, async (tx, { task }) => {
      const cancelled = task.state === 'cancel_requested';
      if (onlyIfCancelled && !cancelled) return;
      await tx.update(runRuntime).set({ reason, resumePending: false }).where(eq(runRuntime.runId, scope.runId));
      await appendEvent(tx, task, cancelled ? 'task.cancelled' : 'task.needs_human', cancelled ? 'cancelled' : 'needs_human', { workerId: scope.workerId, reason });
      await clearSlot(tx);
    }, { allowCancel: true, authorize: false });
  }

  async waitForChild(scope: ExecutionScope, childId: string) {
    idSchema.parse(childId);
    await this.withLease(scope, async (tx, { task }) => {
      const [child] = await tx.select().from(tasks).where(and(eq(tasks.id, childId), eq(tasks.projectId, task.projectId)));
      if (!child || child.id === task.id) throw new DomainError('invalid_input');
      const chain = await tx.execute<{ id: string }>(sql`WITH RECURSIVE chain(id, depth) AS (
        SELECT ${childId}::uuid, 0 UNION ALL SELECT r.waiting_for_task_id, c.depth + 1 FROM chain c
        JOIN itervane.tasks t ON t.id=c.id JOIN itervane.task_runs tr ON tr.task_id=t.id AND tr.generation=t.generation
        JOIN itervane.run_runtime r ON r.run_id=tr.id
        WHERE r.waiting_for_task_id IS NOT NULL AND c.depth < 100) SELECT id FROM chain`);
      if (chain.rows.some(row => row.id === task.id) || chain.rows.length >= 100) throw new DomainError('conflict');
      await tx.update(runRuntime).set({ reason: 'child_task', waitingForTaskId: childId }).where(eq(runRuntime.runId, scope.runId));
      await appendEvent(tx, task, 'task.waiting_child', 'waiting_input', { workerId: scope.workerId });
      await clearSlot(tx);
    });
  }

  async reconcile(workerId: string) {
    await this.database.db.transaction(tx => this.recoverExpired(tx, workerId));
    const candidates = await this.database.db.select({ task: tasks, run: taskRuns }).from(tasks)
      .innerJoin(taskRuns, and(eq(taskRuns.taskId, tasks.id), eq(taskRuns.generation, tasks.generation)))
      .where(eq(tasks.state, 'queued')).limit(20);
    for (const candidate of candidates) {
      const jobs = candidate.run.wakeupJobId ? await this.database.boss.findJobs(queueName, { id: candidate.run.wakeupJobId }) : [];
      const job = jobs[0];
      if (job && ['created', 'retry'].includes(job.state)) continue;
      if (job?.state === 'active' && (!job.startedOn || Date.now() - new Date(job.startedOn).getTime() < this.leaseSeconds * 1_000)) continue;
      await this.database.db.transaction(async tx => {
        const slot = await lockSlot(tx);
        const [task] = await tx.select().from(tasks).where(eq(tasks.id, candidate.task.id)).for('update');
        const [run] = await tx.select().from(taskRuns).where(eq(taskRuns.id, candidate.run.id));
        if (!task || !run || task.state !== 'queued' || run.wakeupJobId !== candidate.run.wakeupJobId || slot.taskId === task.id) return;
        if (job) await this.database.boss.cancel(queueName, job, { db: fromDrizzle(tx, sql) });
        await enqueue(tx, this.database, task, run.id);
      });
    }
  }
}
