import { and, eq, sql } from 'drizzle-orm';
import { fromDrizzle, type Job } from 'pg-boss';
import { idSchema, komodoReleasePhases, wakeupSchema, type SourceInspectionPauseReason, type TaskEventReason } from '@itervane/contracts';
import type { OperationsWorkflowScope } from '../config.js';
import { queueName, type Database } from '../persistence/database.js';
import { formalRepairRetries, runRuntime, taskRuns, tasks } from '../persistence/schema.js';
import { requireProjectAccess, requireStoredActor, type Transaction } from '../service/access.js';
import { DomainError } from '../service/errors.js';
import { readOperationsDiagnosis, readOperationsRequest } from '../service/operations-requests.js';
import { appendEvent, assertLeaseLive, assignSlot, clearSlot, enqueue, ExecutionLost, lockExecution, lockSlot, renewSlot,
  type ExecutionScope, type TaskRow } from './authority.js';
import { recoverClaimedRelease, recoverKomodoLease, recoverRegistryLease } from './release-queue.js';

type Current = { task: TaskRow; run: typeof taskRuns.$inferSelect; runtime: typeof runRuntime.$inferSelect;
  operationsRequest: Awaited<ReturnType<typeof readOperationsRequest>> | undefined;
  operationsDiagnosis: Awaited<ReturnType<typeof readOperationsDiagnosis>> };

export async function authorizeRun(tx: Transaction, task: TaskRow, runId: string, role?: Current['run']['role']) {
  const access = await requireProjectAccess(tx, await requireStoredActor(tx, task.requestedBy), task.projectId, true);
  if (role === 'operations') {
    const operationsRequest = await readOperationsRequest(tx, task, runId);
    if (operationsRequest.document.grantId !== access.grantId) throw new DomainError('forbidden');
    return { ...access, operationsRequest, operationsDiagnosis: await readOperationsDiagnosis(tx, task, runId, operationsRequest) };
  } else if (task.generation !== 1) {
    const [retry] = await tx.select({ grantId: formalRepairRetries.grantId }).from(formalRepairRetries).where(eq(formalRepairRetries.runId, runId));
    if (retry && retry.grantId !== access.grantId) throw new DomainError('forbidden');
  }
  return { ...access, operationsRequest: undefined, operationsDiagnosis: undefined };
}

export class ExecutionCoordinator {
  readonly leaseSeconds: number;
  constructor(readonly database: Database, options: { leaseSeconds?: number } = {}) {
    this.leaseSeconds = options.leaseSeconds ?? 10;
    if (!Number.isInteger(this.leaseSeconds) || this.leaseSeconds < 2 || this.leaseSeconds > 60) throw new Error('Invalid lease duration');
  }

  async withLease<T>(scope: ExecutionScope, action: (tx: Transaction, current: Current) => Promise<T>, options: { allowCancel?: boolean; authorize?: boolean } = {}) {
    return this.database.db.transaction(async tx => {
      const { slot, task, run, runtime } = await lockExecution(tx, scope, options.allowCancel);
      if (runtime.reason?.startsWith('release_')) throw new ExecutionLost();
      const access = options.authorize === false ? undefined : await authorizeRun(tx, task, scope.runId, run.role);
      const result = await action(tx, { task, run, runtime, operationsRequest: access?.operationsRequest,
        operationsDiagnosis: access?.operationsDiagnosis });
      await assertLeaseLive(tx, slot.leaseUntil);
      return result;
    });
  }

  async recoverExpired(tx: Transaction, workerId: string) {
    const slot = await lockSlot(tx);
    if (!slot.taskId || slot.live) return;
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, slot.taskId)).for('update');
    if (task && slot.runId) {
      const [runtime] = await tx.select({ reason: runRuntime.reason }).from(runRuntime).where(eq(runRuntime.runId, slot.runId));
      if (runtime?.reason?.startsWith('release_')) {
        if (runtime.reason === 'release_claimed') await recoverClaimedRelease(tx, this.database, task, slot.runId, workerId, true);
        else if (['release_registry_prepared', 'release_registry_reconciling', 'release_registry_verified'].includes(runtime.reason)) {
          await recoverRegistryLease(tx, this.database, task, slot.runId, workerId);
        } else if (komodoReleasePhases.some(phase => phase === runtime.reason)) {
          await recoverKomodoLease(tx, this.database, task, slot.runId, workerId, { expired: true, fence: slot.fence });
        } else throw new ExecutionLost();
      } else if (task.state === 'cancel_requested') await appendEvent(tx, task, 'task.cancelled', 'cancelled', { workerId, reason: 'expired_cancel' });
      else if (task.state === 'running') {
        const next = await appendEvent(tx, task, 'task.recovered', 'queued', { workerId, reason: 'lease_expired' });
        await enqueue(tx, this.database, next, slot.runId);
      }
    }
    await clearSlot(tx);
  }

  async claim(job: Job<unknown>, workerId: string, operations?: OperationsWorkflowScope): Promise<ExecutionScope | null> {
    idSchema.parse(workerId);
    const parsed = wakeupSchema.safeParse(job.data);
    return this.database.db.transaction(async tx => {
      await this.recoverExpired(tx, workerId);
      const slot = await lockSlot(tx);
      const settle = () => this.database.boss.complete(queueName, job, undefined, { db: fromDrizzle(tx, sql) });
      if (!parsed.success) { await settle(); return null; }
      const input = parsed.data;
      const [task] = await tx.select().from(tasks).where(eq(tasks.id, input.taskId)).for('update');
      const [bound] = await tx.select({ run: taskRuns, reason: runRuntime.reason }).from(taskRuns)
        .innerJoin(runRuntime, eq(runRuntime.runId, taskRuns.id)).where(eq(taskRuns.id, input.runId));
      const run = bound?.run;
      if (!task || !run || task.state !== 'queued' || task.generation !== input.generation || run.taskId !== task.id
        || run.generation !== input.generation || run.wakeupJobId !== job.id || bound?.reason?.startsWith('release_')) { await settle(); return null; }
      if (slot.taskId) {
        await settle(); await enqueue(tx, this.database, task, run.id, true); return null;
      }
      let access: Awaited<ReturnType<typeof authorizeRun>>;
      try { access = await authorizeRun(tx, task, run.id, run.role); }
      catch (error) {
        if (!(error instanceof DomainError)) throw error;
        await appendEvent(tx, task, 'task.needs_human', 'needs_human', { workerId,
          reason: error.code === 'unsupported_state' && run.role === 'operations' ? 'operations_unavailable' : 'permission_revoked' });
        await settle(); return null;
      }
      if (access.operationsRequest && (access.operationsRequest.document.environmentId !== operations?.environmentId
        || (access.operationsDiagnosis && (access.operationsDiagnosis.providerSha256 !== operations.diagnosisProviderSha256
          || access.operationsRequest.document.enrollmentSha256 !== operations.enrollmentSha256)))) {
        await settle(); await enqueue(tx, this.database, task, run.id, true); return null;
      }
      const completed = await settle();
      if (completed.affected !== 1) return null;
      await appendEvent(tx, task, run.role === 'operations' ? 'task.operations_started' : 'task.started', 'running', { workerId });
      return assignSlot(tx, task, run.id, workerId, this.leaseSeconds);
    });
  }

  async heartbeat(scope: ExecutionScope): Promise<boolean> {
    return this.withLease(scope, async (tx, { task }) => {
      if (task.state === 'cancel_requested') return false;
      await renewSlot(tx, this.leaseSeconds);
      return true;
    }, { allowCancel: true });
  }

  async pause(scope: ExecutionScope, reason: SourceInspectionPauseReason | 'repair_deferred' = 'runner_unavailable') {
    await this.withLease(scope, async (tx, { task, runtime }) => {
      if (!runtime.checkpointId) throw new DomainError('unavailable');
      await tx.update(runRuntime).set({ reason, resumePending: false, waitingForTaskId: null }).where(eq(runRuntime.runId, scope.runId));
      const event = reason === 'repair_deferred' ? 'task.repair_deferred' : reason === 'runner_unavailable' ? 'task.paused' : 'task.inspection_paused';
      await appendEvent(tx, task, event, 'waiting_input', { workerId: scope.workerId, reason });
      await clearSlot(tx);
    });
  }

  async stop(scope: ExecutionScope, reason: TaskEventReason, onlyIfCancelled = false) {
    await this.withLease(scope, async (tx, { task }) => {
      const cancelled = task.state === 'cancel_requested';
      if (onlyIfCancelled && !cancelled) return;
      await tx.update(runRuntime).set({ reason, resumePending: false }).where(eq(runRuntime.runId, scope.runId));
      const reconciling = reason === 'verification_reconciling';
      const event = cancelled ? 'task.cancelled' : reconciling ? 'task.verification_paused' : 'task.needs_human';
      const state = cancelled ? 'cancelled' : reconciling ? 'reconciling' : 'needs_human';
      await appendEvent(tx, task, event, state, { workerId: scope.workerId, reason });
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
      .innerJoin(runRuntime, eq(runRuntime.runId, taskRuns.id))
      .where(and(eq(tasks.state, 'queued'), sql`left(coalesce(${runRuntime.reason}, ''), 8) <> 'release_'`)).limit(20);
    for (const candidate of candidates) {
      const jobs = candidate.run.wakeupJobId ? await this.database.boss.findJobs(queueName, { id: candidate.run.wakeupJobId }) : [];
      const job = jobs[0];
      if (job && ['created', 'retry'].includes(job.state)) continue;
      if (job?.state === 'active' && (!job.startedOn || Date.now() - new Date(job.startedOn).getTime() < this.leaseSeconds * 1_000)) continue;
      await this.database.db.transaction(async tx => {
        const slot = await lockSlot(tx);
        const [task] = await tx.select().from(tasks).where(eq(tasks.id, candidate.task.id)).for('update');
        const [bound] = await tx.select({ run: taskRuns, reason: runRuntime.reason }).from(taskRuns)
          .innerJoin(runRuntime, eq(runRuntime.runId, taskRuns.id)).where(eq(taskRuns.id, candidate.run.id));
        const run = bound?.run;
        if (!task || !run || task.state !== 'queued' || run.wakeupJobId !== candidate.run.wakeupJobId
            || slot.taskId === task.id || bound?.reason?.startsWith('release_')) return;
        if (job) await this.database.boss.cancel(queueName, job, { db: fromDrizzle(tx, sql) });
        await enqueue(tx, this.database, task, run.id);
      });
    }
  }
}
