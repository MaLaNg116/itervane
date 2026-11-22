import { operationsObservationReceiptSchema, type OperationsObservationReceipt, type TaskEventReason } from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { eq } from 'drizzle-orm';
import type { OperationsEnrollmentScope, OperationsInstallation } from '../config.js';
import { operationsObservations, runRuntime } from '../persistence/schema.js';
import { requireStoredActor, type Transaction } from '../service/access.js';
import { DomainError } from '../service/errors.js';
import { freezeOperationsRequest, type readOperationsRequest } from '../service/operations-requests.js';
import { readOperationsObservationTarget } from '../service/operations-targets.js';
import { appendEvent, BudgetExhausted, clearSlot, type ExecutionScope, type TaskRow } from './authority.js';
import type { ExecutionCoordinator } from './coordinator.js';
import { WhiskersObservationClient, WhiskersObservationError } from './whiskers-observation.js';

type Failure = Extract<TaskEventReason, `operations_${string}`>;

export class OperationsExecutionError extends Error {
  constructor(readonly reason: Failure) { super(reason); this.name = 'OperationsExecutionError'; }
}

export function operationsObservationFailure(error: unknown): never {
  if (!(error instanceof WhiskersObservationError)) throw error;
  if (error.reason === 'timeout') throw new OperationsExecutionError('operations_timeout');
  if (error.reason === 'transport') throw new OperationsExecutionError('operations_unavailable');
  throw new OperationsExecutionError('operations_invalid_observation');
}

export async function requireCurrentOperationsTarget(tx: Transaction, task: TaskRow,
  request: Awaited<ReturnType<typeof readOperationsRequest>> | undefined, installed: OperationsEnrollmentScope) {
  if (!request) throw new OperationsExecutionError('operations_unavailable');
  const { document } = request;
  if (document.environmentId !== installed.environmentId || document.enrollmentSha256 !== installed.enrollmentSha256) {
    throw new OperationsExecutionError('operations_target_changed');
  }
  const actor = await requireStoredActor(tx, task.requestedBy);
  const target = await readOperationsObservationTarget(tx, actor, document).catch(error => {
    if (error instanceof DomainError && error.code === 'conflict') throw new OperationsExecutionError('operations_release_busy');
    if (error instanceof DomainError && ['unsupported_state', 'version_conflict'].includes(error.code)) {
      throw new OperationsExecutionError('operations_target_changed');
    }
    throw error;
  });
  if (freezeOperationsRequest(target).sha256 !== request.sha256) throw new OperationsExecutionError('operations_target_changed');
  return target;
}

export function prepareOperationsObservation(scope: ExecutionScope, releaseOperationId: string, bindingSha256: string,
  observation: OperationsObservationReceipt['observation']) {
  const { taskId, runId, workerId, fence } = scope;
  const document = operationsObservationReceiptSchema.parse({ version: 1, taskId, runId, releaseOperationId, bindingSha256, fence, observation });
  return { runId, workerId, fence, bindingSha256, sha256: sha256(JSON.stringify(document)), document };
}

export async function settleOperationsObservation(tx: Transaction, task: TaskRow, receipt: ReturnType<typeof prepareOperationsObservation>,
  diagnosisSha256?: string) {
  const { runId, workerId, fence } = receipt;
  await tx.insert(operationsObservations).values(receipt);
  await tx.update(runRuntime).set({ reason: 'operations_observed' }).where(eq(runRuntime.runId, runId));
  await appendEvent(tx, task, 'task.operations_observed', 'succeeded', { workerId,
    ...(diagnosisSha256 ? { reason: 'operations_diagnosed' } : {}),
    operations: { runId, releaseOperationId: receipt.document.releaseOperationId, observationSha256: receipt.sha256, fence,
      ...(diagnosisSha256 ? { diagnosisSha256 } : {}) } });
  await clearSlot(tx);
}

export async function runOperationsObservation(coordinator: ExecutionCoordinator, scope: ExecutionScope,
  installed: OperationsInstallation, signal: AbortSignal) {
  signal.throwIfAborted();
  const target = await coordinator.withLease(scope, async (tx, current) => {
    const target = await requireCurrentOperationsTarget(tx, current.task, current.operationsRequest, installed);
    if (current.runtime.toolsUsed >= current.runtime.maxTools) throw new BudgetExhausted();
    await tx.update(runRuntime).set({ toolsUsed: current.runtime.toolsUsed + 1 }).where(eq(runRuntime.runId, scope.runId));
    return target;
  });
  const authorize = async () => {
    await coordinator.withLease(scope, (tx, current) => requireCurrentOperationsTarget(tx, current.task, current.operationsRequest, installed));
  };
  const observer = new WhiskersObservationClient({ ...target.whiskers, containerId: target.containerId }, installed.readKey);
  const observation = await observer.observe(authorize, signal).catch(operationsObservationFailure);
  signal.throwIfAborted();
  await coordinator.withLease(scope, async (tx, current) => {
    const checked = await requireCurrentOperationsTarget(tx, current.task, current.operationsRequest, installed);
    signal.throwIfAborted();
    if (observation.containerId !== checked.containerId || observation.serverId !== checked.whiskers.serverId) {
      throw new OperationsExecutionError('operations_invalid_observation');
    }
    const { sha256: bindingSha256 } = freezeOperationsRequest(checked);
    await settleOperationsObservation(tx, current.task, prepareOperationsObservation(scope, checked.releaseOperationId, bindingSha256, observation));
    signal.throwIfAborted();
  });
}
