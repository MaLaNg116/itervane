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
type Schedule = typeof operationsExecutionSchedules.$inferSelect;

async function sendOperationsExecutionWakeup(tx: Transaction, database: Database,
  schedule: Omit<Schedule, 'wakeupJobId'>, generation: number, id: string, delaySeconds?: number) {
  const wakeup = operationsExecutionWakeupSchema.parse({ ...schedule, generation });
  const jobId = await database.boss.send(operationsExecutionQueue, wakeup, {
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
  const jobId = await sendOperationsExecutionWakeup(tx, database, binding, 1, execution.id);
  const [schedule] = await tx.insert(operationsExecutionSchedules).values({
    ...binding, wakeupJobId: jobId,
  }).returning();
  if (!schedule) throw new DomainError('unavailable');
  return schedule;
}

export async function replaceOperationsExecutionWakeup(tx: Transaction, database: Database,
  { executionId, taskId, runId }: Schedule, generation: number, delaySeconds?: number) {
  const jobId = await sendOperationsExecutionWakeup(tx, database, { executionId, taskId, runId }, generation, randomUUID(), delaySeconds);
  await tx.update(operationsExecutionSchedules).set({ wakeupJobId: jobId }).where(eq(operationsExecutionSchedules.executionId, executionId));
}

// The caller has closed the parent reservation while holding the environment row lock.
export async function closeUndispatchedOperationsExecution(tx: Transaction, database: Database, executionId: string,
  reason: NonNullable<typeof operationsExecutions.$inferSelect['blockedReason']>, actorId: string, workerId?: string) {
  const [schedule] = await tx.select().from(operationsExecutionSchedules)
    .where(eq(operationsExecutionSchedules.executionId, executionId)).for('update');
  if (!schedule) return;
  const [task] = await tx.select().from(tasks).where(eq(tasks.id, schedule.taskId)).for('update');
  if (!task || (task.state !== 'queued' && task.state !== 'running')) throw new DomainError('unsupported_state');
  if (schedule.wakeupJobId) await database.boss.cancel(operationsExecutionQueue, schedule.wakeupJobId, { db: fromDrizzle(tx, sql) });
  const revoked = reason === 'approval_revoked';
  const detail = revoked ? 'operations_execution_revoked'
    : reason === 'proposal_expired' ? 'operations_execution_expired' : 'operations_restart_not_sent';
  await tx.update(runRuntime).set({ reason: detail }).where(eq(runRuntime.runId, schedule.runId));
  await appendEvent(tx, task, revoked ? 'task.cancelled' : 'task.needs_human', revoked ? 'cancelled' : 'needs_human', {
    actorId, reason: detail, ...(workerId ? { workerId } : {}),
  });
  if (schedule.wakeupJobId) {
    await tx.update(operationsExecutionSchedules).set({ wakeupJobId: null }).where(eq(operationsExecutionSchedules.executionId, executionId));
  }
}
