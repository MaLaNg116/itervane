import { maxOperationsRestoreRecoveryAttempts, operationsRestoreObservationSchema, operationsRestoreRecoveryProofSchema, releaseKomodoUpdateSchema,
  type OperationsProposal, type OperationsRestorePlan, type OperationsRestoreRecoveryFailure, type OperationsRestoreRecoveryProof } from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '../persistence/database.js';
import { operationsExecutions, operationsExecutionSchedules, operationsRestoreRecoveries, operationsRestoreSteps, operationsTargets,
  runRuntime } from '../persistence/schema.js';
import type { Transaction } from '../service/access.js';
import { DomainError } from '../service/errors.js';
import { readPublishedOperationsDeployment } from '../service/operations-deployment.js';
import { readOperationsEnrollment } from '../service/operations-targets.js';
import { appendEvent, clearSlot, ExecutionLost, type TaskRow } from './authority.js';
import type { OperationsExecutionLease } from './operations-execution-lease.js';
import { replaceOperationsExecutionWakeup } from './operations-execution-queue.js';
import { restoreImageReference } from './operations-restore-steps.js';

type Attempt = typeof operationsRestoreRecoveries.$inferSelect;
type RestoreIntent = { plan: OperationsRestorePlan; sha256: string };
type RecoveryExecution = {
  execution: typeof operationsExecutions.$inferSelect;
  schedule: typeof operationsExecutionSchedules.$inferSelect;
  task: TaskRow;
};
export type RestoreReadFailure = Exclude<OperationsRestoreRecoveryFailure, 'lease_expired'>;

export class RestoreRecoveryRejected extends Error {
  constructor(readonly reason: 'target_changed' | 'missing_update') { super('operations_restore_recovery_' + reason); }
}

export async function startRestoreRecovery(tx: Transaction, scope: OperationsExecutionLease) {
  const [last] = await tx.select().from(operationsRestoreRecoveries).where(eq(operationsRestoreRecoveries.executionId, scope.executionId))
    .orderBy(desc(operationsRestoreRecoveries.attempt)).limit(1);
  const attempt = (last?.attempt ?? 0) + 1;
  if ((last && last.state !== 'retry') || attempt > maxOperationsRestoreRecoveryAttempts) throw new ExecutionLost();
  await tx.insert(operationsRestoreRecoveries).values({ executionId: scope.executionId, attempt, fence: scope.fence, workerId: scope.workerId });
}

export async function findActiveRestoreRecovery(tx: Transaction, scope: Pick<OperationsExecutionLease, 'executionId' | 'fence' | 'workerId'>) {
  const [attempt] = await tx.select().from(operationsRestoreRecoveries)
    .where(and(eq(operationsRestoreRecoveries.executionId, scope.executionId), eq(operationsRestoreRecoveries.fence, scope.fence),
      eq(operationsRestoreRecoveries.workerId, scope.workerId), eq(operationsRestoreRecoveries.state, 'observing'))).for('update');
  return attempt;
}

export async function readRestoreRecoveryBinding(tx: Transaction, scope: OperationsExecutionLease, intent: RestoreIntent, frozen: OperationsProposal) {
  const { plan } = intent;
  const { target } = frozen;
  const [enrollment] = await tx.select().from(operationsTargets).where(eq(operationsTargets.environmentId, plan.environmentId)).for('share');
  if (!enrollment || enrollment.revision !== target.enrollmentRevision || enrollment.sha256 !== target.enrollmentSha256
      || readOperationsEnrollment(enrollment).releaseTargetSha256 !== plan.mappingSha256) throw new RestoreRecoveryRejected('target_changed');
  const current = await readPublishedOperationsDeployment(tx, target).catch(error => {
    if (error instanceof DomainError) throw new RestoreRecoveryRejected('target_changed');
    throw error;
  });
  if (current.releaseOperationId !== plan.current.operationId || current.proofSha256 !== plan.current.proofSha256
      || current.mappingSha256 !== plan.mappingSha256 || current.targetRevision !== plan.targetRevision
      || current.containerId !== plan.current.containerId || current.releaseTarget.rolloutCheckSha256 !== plan.rolloutCheckSha256) {
    throw new RestoreRecoveryRejected('target_changed');
  }
  const [step] = await tx.select().from(operationsRestoreSteps).where(and(
    eq(operationsRestoreSteps.executionId, scope.executionId), eq(operationsRestoreSteps.kind, 'deploy'),
  ));
  if (!step?.receipt) throw new RestoreRecoveryRejected('missing_update');
  const update = releaseKomodoUpdateSchema.parse(step.receipt);
  if (step.fence >= scope.fence || step.planSha256 !== intent.sha256 || update.deploymentId !== plan.target.deploymentId
      || update.actorId !== plan.target.komodo.actorId) throw new RestoreRecoveryRejected('target_changed');
  return { updateId: update.updateId, intent, subject: { target: plan.target, image: {
    manifestDigest: plan.restore.manifestDigest, configDigest: plan.restore.configDigest,
  }, check: current.releaseTarget.rolloutCheck, rolloutCheckSha256: plan.rolloutCheckSha256 } };
}

export function proveRestoreRecovery(scope: OperationsExecutionLease, attempt: Attempt,
  binding: Awaited<ReturnType<typeof readRestoreRecoveryBinding>>, raw: unknown) {
  const observed = operationsRestoreObservationSchema.safeParse(raw);
  if (!observed.success) throw new RestoreRecoveryRejected('target_changed');
  const { plan } = binding.intent;
  const { update, runtime } = observed.data;
  if (update.updateId !== binding.updateId || update.deploymentId !== plan.target.deploymentId || update.actorId !== plan.target.komodo.actorId
      || runtime.containerId === plan.current.containerId || runtime.configDigest !== plan.restore.configDigest
      || runtime.imageReference !== restoreImageReference(plan.target, plan.restore.manifestDigest)
      || runtime.runtimeConfigSha256 !== plan.target.runtimeConfigSha256 || runtime.rolloutCheckSha256 !== plan.rolloutCheckSha256
      || runtime.network !== binding.subject.check.network || runtime.version !== plan.restore.publishedVersion) {
    throw new RestoreRecoveryRejected('target_changed');
  }
  return operationsRestoreRecoveryProofSchema.parse({ version: 1, executionId: scope.executionId, restoreOperationId: plan.restore.operationId,
    planSha256: binding.intent.sha256, attempt: attempt.attempt, fence: scope.fence, ...observed.data });
}

export async function finishRestoreRecovery(tx: Transaction, database: Database, bound: RecoveryExecution, attempt: Attempt, workerId: string,
  outcome: { proof: OperationsRestoreRecoveryProof } | { failure: OperationsRestoreRecoveryFailure }) {
  const { execution, schedule, task } = bound;
  const proof = 'proof' in outcome ? outcome.proof : null;
  const failure = 'failure' in outcome ? outcome.failure : null;
  const retry = (failure === 'update_pending' || failure === 'unavailable' || failure === 'unhealthy' || failure === 'lease_expired')
    && attempt.attempt < maxOperationsRestoreRecoveryAttempts;
  const state = proof ? 'verified' : retry ? 'retry' : 'manual_review';
  const proofSha256 = proof && sha256(JSON.stringify(proof));
  const [record] = await tx.update(operationsRestoreRecoveries).set({ state, failure, proof, proofSha256 })
    .where(and(eq(operationsRestoreRecoveries.executionId, execution.id), eq(operationsRestoreRecoveries.attempt, attempt.attempt),
      eq(operationsRestoreRecoveries.state, 'observing'))).returning();
  if (!record?.completedAt) throw new ExecutionLost();
  if (state === 'verified') {
    const [released] = await tx.update(operationsExecutions).set({ state: 'recovered' })
      .where(and(eq(operationsExecutions.id, execution.id), eq(operationsExecutions.state, 'reserved'))).returning({ id: operationsExecutions.id });
    if (!released) throw new ExecutionLost();
  }
  const reason = proof ? 'operations_restore_recovery_verified' : retry ? 'operations_execution_reconciling' : 'operations_restore_recovery_manual';
  await tx.update(runRuntime).set({ reason }).where(eq(runRuntime.runId, schedule.runId));
  await appendEvent(tx, task, 'task.operations_restore_recovery_recorded', state === 'verified' ? 'succeeded' : retry ? 'reconciling' : 'needs_human', {
    workerId, reason, operationsExecution: { executionId: execution.id, proposalId: execution.proposalId, fence: attempt.fence,
      recoveryAttempt: attempt.attempt, ...(proofSha256 ? { recoverySha256: proofSha256 } : {}) },
  });
  if (retry) await replaceOperationsExecutionWakeup(tx, database, schedule, task.generation, 4);
  await clearSlot(tx);
  return state;
}
