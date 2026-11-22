import { operationsRestartRequestSchema } from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { Database } from '../persistence/database.js';
import { operationsExecutions, operationsExecutionSchedules, operationsRestartRequests, runRuntime, tasks } from '../persistence/schema.js';
import type { Transaction } from '../service/access.js';
import { DomainError } from '../service/errors.js';
import { appendEvent } from './authority.js';
import { replaceOperationsExecutionWakeup } from './operations-execution-queue.js';

export async function prepareOperationsRestartRequest(tx: Transaction, executionId: string, raw: unknown) {
  const document = operationsRestartRequestSchema.parse(raw);
  const callSha256 = sha256(JSON.stringify(document));
  const [request] = await tx.insert(operationsRestartRequests).values({ executionId, callSha256, document }).returning();
  if (!request) throw new DomainError('unavailable');
  return request;
}

export async function attachOperationsRestartApproval(tx: Transaction, executionId: string, approval: { callSha256: string; approvalId: string }) {
  const [request] = await tx.select().from(operationsRestartRequests).where(eq(operationsRestartRequests.executionId, executionId)).for('update');
  if (!request || request.approvalId) throw new DomainError('unsupported_state');
  const document = operationsRestartRequestSchema.parse(request.document);
  if (sha256(JSON.stringify(document)) !== request.callSha256) throw new Error('operations_restart_request_integrity');
  if (request.callSha256 !== approval.callSha256) throw new DomainError('version_conflict');
  const [recorded] = await tx.update(operationsRestartRequests).set({ approvalId: approval.approvalId })
    .where(and(eq(operationsRestartRequests.executionId, executionId), isNull(operationsRestartRequests.approvalId))).returning();
  if (!recorded?.receivedAt) throw new DomainError('unavailable');
  return recorded;
}

// Approval decisions already hold the environment lock used by the execution coordinator.
export async function reconcileWithdrawnRestart(tx: Transaction, database: Database, proposalId: string, actorId: string) {
  const [paused] = await tx.select({ schedule: operationsExecutionSchedules, task: tasks }).from(operationsExecutions)
    .innerJoin(operationsExecutionSchedules, eq(operationsExecutionSchedules.executionId, operationsExecutions.id))
    .innerJoin(operationsRestartRequests, eq(operationsRestartRequests.executionId, operationsExecutions.id))
    .innerJoin(tasks, eq(tasks.id, operationsExecutionSchedules.taskId))
    .innerJoin(runRuntime, and(eq(runRuntime.runId, operationsExecutionSchedules.runId), eq(runRuntime.taskId, tasks.id)))
    .where(and(eq(operationsExecutions.proposalId, proposalId), eq(operationsExecutions.state, 'reserved'),
      eq(tasks.state, 'waiting_approval'), eq(runRuntime.reason, 'operations_execution_native_approval'),
      isNotNull(operationsRestartRequests.approvalId), isNull(operationsExecutionSchedules.wakeupJobId)));
  if (!paused) return;
  const { schedule, task } = paused;
  const reason = 'operations_execution_reconciling';
  await tx.update(runRuntime).set({ reason }).where(eq(runRuntime.runId, schedule.runId));
  await appendEvent(tx, task, 'task.operations_execution_recovered', 'reconciling', {
    actorId, reason, operationsExecution: { executionId: schedule.executionId, proposalId },
  });
  await replaceOperationsExecutionWakeup(tx, database, schedule, task.generation);
}
