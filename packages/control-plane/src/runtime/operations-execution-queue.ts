import { randomUUID } from 'node:crypto';
import { idSchema, localeSchema, translate, wakeupSchema, type OperationsProposal } from '@itervane/contracts';
import { eq, sql } from 'drizzle-orm';
import { fromDrizzle } from 'pg-boss';
import { operationsExecutionQueue, type Database } from '../persistence/database.js';
import { operationsExecutions, operationsExecutionSchedules, runRuntime, taskEvents, taskRuns, tasks } from '../persistence/schema.js';
import type { Transaction } from '../service/access.js';
import { DomainError } from '../service/errors.js';
import { appendEvent } from './authority.js';

export const operationsExecutionWakeupSchema = wakeupSchema.extend({ executionId: idSchema });

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
  const wakeup = operationsExecutionWakeupSchema.parse({ executionId: execution.id, taskId, runId, generation: 1 });
  const jobId = await database.boss.send(operationsExecutionQueue, wakeup, { id: execution.id, db: fromDrizzle(tx, sql) });
  if (jobId !== execution.id) throw new DomainError('unavailable');
  const [schedule] = await tx.insert(operationsExecutionSchedules).values({
    executionId: execution.id, taskId, runId, wakeupJobId: jobId,
  }).returning();
  if (!schedule) throw new DomainError('unavailable');
  return schedule;
}

// The caller has closed the parent reservation while holding the environment row lock.
export async function closeQueuedOperationsExecution(tx: Transaction, database: Database, executionId: string,
  reason: 'approval_revoked' | 'proposal_expired', actorId: string) {
  const [schedule] = await tx.select().from(operationsExecutionSchedules)
    .where(eq(operationsExecutionSchedules.executionId, executionId)).for('update');
  if (!schedule?.wakeupJobId) return;
  const [task] = await tx.select().from(tasks).where(eq(tasks.id, schedule.taskId)).for('update');
  if (!task || task.state !== 'queued') throw new DomainError('unsupported_state');
  await database.boss.cancel(operationsExecutionQueue, schedule.wakeupJobId, { db: fromDrizzle(tx, sql) });
  const revoked = reason === 'approval_revoked';
  const detail = revoked ? 'operations_execution_revoked' : 'operations_execution_expired';
  await tx.update(runRuntime).set({ reason: detail }).where(eq(runRuntime.runId, schedule.runId));
  await appendEvent(tx, task, revoked ? 'task.cancelled' : 'task.needs_human', revoked ? 'cancelled' : 'needs_human', { actorId, reason: detail });
  await tx.update(operationsExecutionSchedules).set({ wakeupJobId: null }).where(eq(operationsExecutionSchedules.executionId, executionId));
}
