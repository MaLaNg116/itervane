import { randomUUID } from 'node:crypto';
import { idSchema, localeSchema, translate, wakeupSchema, type OperationsProposal } from '@itervane/contracts';
import { eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { fromDrizzle } from 'pg-boss';
import { operationsExecutionQueue, operationsRestoreQueue, type Database } from '../persistence/database.js';
import { operationsExecutions, operationsExecutionSchedules, operationsProposals, runRuntime, taskEvents, taskRuns, tasks } from '../persistence/schema.js';
import type { Transaction } from '../service/access.js';
import { DomainError } from '../service/errors.js';
import { readOperationsProposal } from '../service/operations-proposals.js';
import { appendEvent } from './authority.js';

export const operationsExecutionWakeupSchema = wakeupSchema.extend({ executionId: idSchema });
export type OperationsActionKind = OperationsProposal['action']['kind'];
type Schedule = typeof operationsExecutionSchedules.$inferSelect;

export function operationsQueueForAction(action: OperationsActionKind) {
  return action === 'rollback' ? operationsRestoreQueue : operationsExecutionQueue;
}

async function sendOperationsExecutionWakeup(tx: Transaction, database: Database,
  schedule: Omit<Schedule, 'wakeupJobId'>, generation: number, action: OperationsActionKind, id: string, delaySeconds?: number) {
  const wakeup = operationsExecutionWakeupSchema.parse({ ...schedule, generation });
  const jobId = await database.boss.send(operationsQueueForAction(action), wakeup, {
    id, db: fromDrizzle(tx, sql), ...(delaySeconds ? { startAfter: delaySeconds } : {}),
  });
  if (jobId !== id) throw new DomainError('unavailable');
  return jobId;
}

export async function scheduleOperationsExecution(tx: Transaction, database: Database, execution: typeof operationsExecutions.$inferSelect,
  approvalActorId: string, proposal: OperationsProposal, diagnosisLocale: string) {
  const { target: { projectId, source, dataClass }, action } = proposal;
  const locale = localeSchema.parse(diagnosisLocale);
  const taskId = randomUUID();
  const runId = randomUUID();
  await tx.insert(tasks).values({ id: taskId, projectId, requestedBy: approvalActorId, ...source, dataClass, locale,
    purpose: translate(locale, `operations.execution.${action.kind}`), requestKey: execution.id, requestHash: execution.proposalFingerprint });
  await tx.insert(taskRuns).values({ id: runId, taskId, generation: 1, role: 'operations' });
  await tx.insert(runRuntime).values({ runId, taskId, reason: 'operations_execution_queued' });
  await tx.insert(taskEvents).values({ taskId, sequence: 1, type: 'task.accepted', state: 'queued', actorId: approvalActorId,
    detail: { reason: 'operations_execution_queued', executionId: execution.id, proposalId: execution.proposalId } });
  const binding = { executionId: execution.id, taskId, runId };
  const jobId = await sendOperationsExecutionWakeup(tx, database, binding, 1, action.kind, execution.id);
  const [schedule] = await tx.insert(operationsExecutionSchedules).values({
    ...binding, wakeupJobId: jobId,
  }).returning();
  if (!schedule) throw new DomainError('unavailable');
  return schedule;
}

export async function replaceOperationsExecutionWakeup(tx: Transaction, database: Database,
  { executionId, taskId, runId }: Schedule, generation: number, action: OperationsActionKind, delaySeconds?: number) {
  const jobId = await sendOperationsExecutionWakeup(tx, database, { executionId, taskId, runId }, generation, action, randomUUID(), delaySeconds);
  await tx.update(operationsExecutionSchedules).set({ wakeupJobId: jobId }).where(eq(operationsExecutionSchedules.executionId, executionId));
}

export async function cancelOperationsExecutionWakeup(tx: Transaction, database: Database, action: OperationsActionKind, jobId: string) {
  const options = { db: fromDrizzle(tx, sql) };
  const cancelled = await database.boss.cancel(operationsQueueForAction(action), jobId, options);
  if (!cancelled.affected && action === 'rollback') {
    // Earlier installations stored restoration wakeups in the shared execution queue.
    await database.boss.cancel(operationsExecutionQueue, jobId, options);
  }
}

// The caller has closed the parent reservation while holding the environment row lock.
export async function closeUndispatchedOperationsExecution(tx: Transaction, database: Database, executionId: string,
  reason: NonNullable<typeof operationsExecutions.$inferSelect['blockedReason']>, actorId: string, workerId?: string,
  ruleSnapshotChanged = false) {
  const scheduled = alias(operationsExecutionSchedules, 'execution_schedule');
  const [bound] = await tx.select({ schedule: scheduled, proposal: operationsProposals }).from(scheduled)
    .innerJoin(operationsExecutions, eq(operationsExecutions.id, scheduled.executionId))
    .innerJoin(operationsProposals, eq(operationsProposals.id, operationsExecutions.proposalId))
    .where(eq(scheduled.executionId, executionId)).for('update', { of: scheduled });
  if (!bound) return;
  const { schedule } = bound;
  const [task] = await tx.select().from(tasks).where(eq(tasks.id, schedule.taskId)).for('update');
  if (!task || (task.state !== 'queued' && task.state !== 'running')) throw new DomainError('unsupported_state');
  if (schedule.wakeupJobId) {
    await cancelOperationsExecutionWakeup(tx, database, readOperationsProposal(bound.proposal).action.kind, schedule.wakeupJobId);
  }
  const revoked = reason === 'approval_revoked';
  const detail = revoked ? 'operations_execution_revoked'
    : reason === 'proposal_expired' ? 'operations_execution_expired'
    : ruleSnapshotChanged ? 'operations_restart_rules_changed' : 'operations_restart_not_sent';
  await tx.update(runRuntime).set({ reason: detail }).where(eq(runRuntime.runId, schedule.runId));
  await appendEvent(tx, task, revoked ? 'task.cancelled' : 'task.needs_human', revoked ? 'cancelled' : 'needs_human', {
    actorId, reason: detail, ...(workerId ? { workerId } : {}),
  });
  if (schedule.wakeupJobId) {
    await tx.update(operationsExecutionSchedules).set({ wakeupJobId: null }).where(eq(operationsExecutionSchedules.executionId, executionId));
  }
}
