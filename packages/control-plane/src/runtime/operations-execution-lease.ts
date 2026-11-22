import { idSchema, operationsRestartApprovalInputSchema, sha256Schema } from '@itervane/contracts';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { fromDrizzle, type Job } from 'pg-boss';
import type { OperationsEnrollmentScope } from '../config.js';
import { operationsExecutionQueue, type Database } from '../persistence/database.js';
import { operationsExecutionIntents, operationsExecutionSchedules, operationsExecutions, operationsProposals, runRuntime, taskRuns,
  tasks } from '../persistence/schema.js';
import type { Transaction } from '../service/access.js';
import { expireUndispatchedOperations, lockEnvironmentForEffect } from '../service/environment-effects.js';
import { DomainError, parseInput } from '../service/errors.js';
import { lockOperationsDiagnosisTask, requireOperationsExecutionApproval } from '../service/operations-execution-admission.js';
import { readOperationsProposal } from '../service/operations-proposals.js';
import { databaseNow } from '../service/releases.js';
import { appendEvent, assertLeaseLive, assignSlot, clearSlot, ExecutionLost, lockExecution, lockSlot, renewSlot,
  type ExecutionScope } from './authority.js';
import type { ExecutionCoordinator } from './coordinator.js';
import { operationsExecutionWakeupSchema, replaceOperationsExecutionWakeup } from './operations-execution-queue.js';
import { attachOperationsRestartApproval, prepareOperationsRestartRequest } from './operations-restart-request.js';

export type OperationsExecutionLease = ExecutionScope & Readonly<{ executionId: string; mode: 'dispatch' | 'reconcile' }>;

// Callers lock the execution slot first. The diagnosis and environment locks also serialize approval and release.
async function lockOperationsExecution(tx: Transaction, executionId: string) {
  const [proposal] = await tx.select({ row: operationsProposals }).from(operationsExecutions)
    .innerJoin(operationsProposals, eq(operationsProposals.id, operationsExecutions.proposalId))
    .where(eq(operationsExecutions.id, executionId));
  if (!proposal) return;
  const diagnosis = await lockOperationsDiagnosisTask(tx, proposal.row);
  await lockEnvironmentForEffect(tx, proposal.row.environmentId);
  const execution = alias(operationsExecutions, 'execution');
  const schedule = alias(operationsExecutionSchedules, 'schedule');
  const task = alias(tasks, 'execution_task');
  const [current] = await tx.select({ execution, schedule, task, reason: runRuntime.reason, intent: operationsExecutionIntents })
    .from(execution).innerJoin(schedule, eq(schedule.executionId, execution.id)).innerJoin(task, eq(task.id, schedule.taskId))
    .innerJoin(taskRuns, and(eq(taskRuns.id, schedule.runId), eq(taskRuns.taskId, task.id), eq(taskRuns.generation, task.generation),
      eq(taskRuns.state, task.state), eq(taskRuns.role, 'operations')))
    .innerJoin(runRuntime, and(eq(runRuntime.runId, taskRuns.id), eq(runRuntime.taskId, task.id)))
    .leftJoin(operationsExecutionIntents, eq(operationsExecutionIntents.executionId, execution.id))
    .where(eq(execution.id, executionId)).for('update', { of: [execution, schedule, task] });
  if (current) return { ...current, diagnosis, proposal: proposal.row };
}

type BoundExecution = NonNullable<Awaited<ReturnType<typeof lockOperationsExecution>>>;

function wakeupMode({ execution, task, reason, intent }: BoundExecution): OperationsExecutionLease['mode'] | undefined {
  if (execution.state !== 'reserved') return;
  if (!intent && task.state === 'queued' && reason === 'operations_execution_queued') return 'dispatch';
  if (intent && task.state === 'reconciling' && reason === 'operations_execution_reconciling') return 'reconcile';
}

export async function recoverOperationsExecutionSlot(tx: Transaction, database: Database,
  slot: Awaited<ReturnType<typeof lockSlot>>, workerId: string) {
  if (!slot.taskId) return false;
  const [linked] = await tx.select({ id: operationsExecutions.id, state: operationsExecutions.state }).from(operationsExecutionSchedules)
    .innerJoin(operationsExecutions, eq(operationsExecutions.id, operationsExecutionSchedules.executionId))
    .where(eq(operationsExecutionSchedules.taskId, slot.taskId));
  if (!linked) return false;
  if (slot.live && linked.state === 'reserved') return true;

  const bound = await lockOperationsExecution(tx, linked.id);
  if (!bound || bound.schedule.runId !== slot.runId || bound.schedule.wakeupJobId) throw new ExecutionLost();
  const { execution, schedule, task, intent } = bound;
  if (execution.state === 'blocked') {
    if (intent || (task.state !== 'cancelled' && task.state !== 'needs_human')) throw new ExecutionLost();
  } else {
    if (task.state !== 'running') throw new ExecutionLost();
    const expired = !intent && await expireUndispatchedOperations(tx, database, execution.environmentId, task.requestedBy, workerId);
    if (!expired) {
      const reason = intent ? 'operations_execution_reconciling' : 'operations_execution_queued';
      await tx.update(runRuntime).set({ reason }).where(eq(runRuntime.runId, schedule.runId));
      await appendEvent(tx, task, 'task.operations_execution_recovered', intent ? 'reconciling' : 'queued', {
        workerId, reason, operationsExecution: { executionId: execution.id, proposalId: execution.proposalId, fence: slot.fence },
      });
      await replaceOperationsExecutionWakeup(tx, database, schedule, task.generation);
    }
  }
  await clearSlot(tx);
  return true;
}

export class OperationsExecutionCoordinator {
  constructor(private readonly coordinator: ExecutionCoordinator, private readonly installation: OperationsEnrollmentScope) {}

  async claim(job: Job<unknown>, workerId: string): Promise<OperationsExecutionLease | null> {
    idSchema.parse(workerId);
    const database = this.coordinator.database;
    const request = operationsExecutionWakeupSchema.safeParse(job.data);
    return database.db.transaction(async tx => {
      await this.coordinator.recoverExpired(tx, workerId);
      const slot = await lockSlot(tx);
      const complete = () => database.boss.complete(operationsExecutionQueue, job, undefined, { db: fromDrizzle(tx, sql) });
      const wakeup = request.success ? request.data : undefined;
      const bound = wakeup ? await lockOperationsExecution(tx, wakeup.executionId) : undefined;
      const mode = bound && wakeupMode(bound);
      if (!bound || !mode || bound.task.id !== wakeup?.taskId || bound.schedule.runId !== wakeup.runId
          || bound.task.generation !== wakeup.generation || bound.schedule.wakeupJobId !== job.id) {
        await complete();
        return null;
      }

      const { execution, schedule, task, proposal, diagnosis } = bound;
      if (mode === 'dispatch' && await expireUndispatchedOperations(tx, database, execution.environmentId, task.requestedBy, workerId)) return null;
      const { target } = readOperationsProposal(proposal);
      let eligible = !slot.taskId && target.environmentId === this.installation.environmentId
        && target.enrollmentSha256 === this.installation.enrollmentSha256;
      if (eligible && mode === 'dispatch') {
        try { await requireOperationsExecutionApproval(tx, diagnosis, proposal, this.installation, execution.decisionVersion); }
        catch (error) {
          if (!(error instanceof DomainError)) throw error;
          eligible = false;
        }
      }
      if ((await complete()).affected !== 1) return null;
      if (!eligible) {
        await replaceOperationsExecutionWakeup(tx, database, schedule, task.generation, slot.taskId ? 1 : 5);
        return null;
      }

      const lease = await assignSlot(tx, task, schedule.runId, workerId, this.coordinator.leaseSeconds);
      const reason = mode === 'dispatch' ? 'operations_execution_claimed' : 'operations_execution_reconciling';
      await tx.update(runRuntime).set({ reason }).where(eq(runRuntime.runId, schedule.runId));
      await appendEvent(tx, task, 'task.operations_execution_started', 'running', {
        workerId, reason, operationsExecution: { executionId: execution.id, proposalId: execution.proposalId, fence: lease.fence },
      });
      await tx.update(operationsExecutionSchedules).set({ wakeupJobId: null }).where(eq(operationsExecutionSchedules.executionId, execution.id));
      return Object.freeze({ ...lease, executionId: execution.id, mode });
    });
  }

  async heartbeat(scope: OperationsExecutionLease) {
    await this.withLease(scope, async (tx, { diagnosis, proposal, execution, intent }) => {
      if (!intent) await requireOperationsExecutionApproval(tx, diagnosis, proposal, this.installation, execution.decisionVersion);
      await renewSlot(tx, this.coordinator.leaseSeconds);
    });
  }

  async prepareDispatch(scope: OperationsExecutionLease, restart?: { credentialSha256: string }) {
    const credentialSha256 = restart && parseInput(sha256Schema, restart.credentialSha256);
    return this.withLease(scope, async (tx, { execution, task, proposal, diagnosis, reason }) => {
      if (scope.mode !== 'dispatch' || reason !== 'operations_execution_claimed') throw new ExecutionLost();
      const { frozen, whiskers } = await requireOperationsExecutionApproval(tx, diagnosis, proposal, this.installation, execution.decisionVersion);
      if (credentialSha256 && frozen.action.kind !== 'restart') throw new DomainError('unsupported_state');
      const [intent] = await tx.insert(operationsExecutionIntents).values({ executionId: execution.id,
        decisionVersion: execution.decisionVersion, proposalFingerprint: execution.proposalFingerprint,
        generation: scope.generation, workerId: scope.workerId, fence: scope.fence }).returning();
      if (!intent) throw new DomainError('unavailable');
      const dispatchReason = 'operations_execution_dispatch_intended';
      await tx.update(runRuntime).set({ reason: dispatchReason }).where(eq(runRuntime.runId, scope.runId));
      const restartRequest = credentialSha256 ? await prepareOperationsRestartRequest(tx, execution.id, {
        version: 1, tool: 'restart_container', target: { ...whiskers, containerId: frozen.target.containerId }, credentialSha256,
      }) : undefined;
      await appendEvent(tx, task, 'task.operations_execution_dispatch_intended', 'running', {
        workerId: scope.workerId, reason: dispatchReason,
        operationsExecution: { executionId: execution.id, proposalId: execution.proposalId, fence: scope.fence },
      });
      return { intent, proposal: frozen, ...(restartRequest ? { restartRequest } : {}) };
    });
  }

  async pauseForRestartApproval(scope: OperationsExecutionLease, raw: unknown) {
    const approval = parseInput(operationsRestartApprovalInputSchema, raw);
    return this.withLease(scope, async (tx, { execution, schedule, task, reason, diagnosis, proposal }) => {
      if (scope.mode !== 'dispatch' || reason !== 'operations_execution_dispatch_intended') throw new ExecutionLost();
      let canAwaitApproval = true;
      try { await requireOperationsExecutionApproval(tx, diagnosis, proposal, this.installation, execution.decisionVersion); }
      catch (error) {
        if (!(error instanceof DomainError)) throw error;
        canAwaitApproval = false;
      }
      const recorded = await attachOperationsRestartApproval(tx, execution.id, approval);
      const pauseReason = canAwaitApproval ? 'operations_execution_native_approval' : 'operations_execution_reconciling';
      const pauseState = canAwaitApproval ? 'waiting_approval' : 'reconciling';
      await tx.update(runRuntime).set({ reason: pauseReason }).where(eq(runRuntime.runId, scope.runId));
      await appendEvent(tx, task, 'task.operations_execution_native_approval', pauseState, {
        workerId: scope.workerId, reason: pauseReason,
        operationsExecution: { executionId: execution.id, proposalId: execution.proposalId, fence: scope.fence,
          nativeApprovalId: approval.approvalId, nativeCallSha256: approval.callSha256 },
      });
      if (!canAwaitApproval) await replaceOperationsExecutionWakeup(tx, this.coordinator.database, schedule, task.generation);
      await clearSlot(tx);
      return recorded;
    });
  }

  async reconcile(workerId: string) {
    idSchema.parse(workerId);
    const database = this.coordinator.database;
    await database.db.transaction(tx => this.coordinator.recoverExpired(tx, workerId));
    const candidates = await database.db.select({ id: operationsExecutionSchedules.executionId, jobId: operationsExecutionSchedules.wakeupJobId })
      .from(operationsExecutionSchedules).innerJoin(tasks, eq(tasks.id, operationsExecutionSchedules.taskId))
      .where(and(inArray(tasks.state, ['queued', 'reconciling']), isNotNull(operationsExecutionSchedules.wakeupJobId))).limit(20);
    for (const { id, jobId } of candidates) {
      if (!jobId) continue;
      const [job] = await database.boss.findJobs(operationsExecutionQueue, { id: jobId });
      if (job?.state === 'created' || job?.state === 'retry') continue;
      await database.db.transaction(async tx => {
        await lockSlot(tx);
        const bound = await lockOperationsExecution(tx, id);
        const mode = bound && wakeupMode(bound);
        if (!bound || !mode || bound.schedule.wakeupJobId !== jobId) return;
        const { execution, schedule, task } = bound;
        if (mode === 'dispatch' && await expireUndispatchedOperations(tx, database, execution.environmentId, task.requestedBy, workerId)) return;
        if (job?.state === 'active') {
          if (!job.startedOn || (await databaseNow(tx)).getTime() - new Date(job.startedOn).getTime() < this.coordinator.leaseSeconds * 1_000) return;
          await database.boss.cancel(operationsExecutionQueue, jobId, { db: fromDrizzle(tx, sql) });
        }
        await replaceOperationsExecutionWakeup(tx, database, schedule, task.generation);
      });
    }
  }

  private async withLease<T>(scope: OperationsExecutionLease, run: (tx: Transaction, bound: BoundExecution) => Promise<T>) {
    return this.coordinator.database.db.transaction(async tx => {
      const currentSlot = await lockSlot(tx);
      if (!currentSlot.live || currentSlot.taskId !== scope.taskId || currentSlot.runId !== scope.runId
          || currentSlot.workerId !== scope.workerId || currentSlot.fence !== scope.fence) throw new ExecutionLost();
      const bound = await lockOperationsExecution(tx, scope.executionId);
      if (!bound || bound.schedule.taskId !== scope.taskId || bound.schedule.runId !== scope.runId
          || bound.schedule.wakeupJobId || bound.execution.state !== 'reserved') throw new ExecutionLost();
      const { slot } = await lockExecution(tx, scope);
      const { intent, reason } = bound;
      const active = scope.mode === 'dispatch'
        ? (!intent && reason === 'operations_execution_claimed') || (intent?.fence === scope.fence && reason === 'operations_execution_dispatch_intended')
        : intent && intent.fence < scope.fence && reason === 'operations_execution_reconciling';
      if (!active) throw new ExecutionLost();
      const result = await run(tx, bound);
      await assertLeaseLive(tx, slot.leaseUntil);
      return result;
    });
  }
}
