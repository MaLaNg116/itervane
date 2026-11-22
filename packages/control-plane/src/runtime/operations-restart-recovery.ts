import { maxOperationsRestartRecoveryAttempts, operationsRestartRecoveryObservationSchema, operationsRestartRecoveryProofSchema,
  type OperationsRestartRecoveryFailure, type OperationsRestartRecoveryProof } from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { and, desc, eq } from 'drizzle-orm';
import type { OperationsEnrollmentScope } from '../config.js';
import type { Database } from '../persistence/database.js';
import { operationsExecutionSchedules, operationsExecutions, operationsProposals, operationsRestartRecoveries, operationsTargets,
  runRuntime } from '../persistence/schema.js';
import type { Transaction } from '../service/access.js';
import { DomainError } from '../service/errors.js';
import { readPublishedOperationsDeployment } from '../service/operations-deployment.js';
import { readOperationsProposal } from '../service/operations-proposals.js';
import { readOperationsEnrollment } from '../service/operations-targets.js';
import { appendEvent, clearSlot, ExecutionLost, type TaskRow } from './authority.js';
import type { OperationsExecutionLease } from './operations-execution-lease.js';
import { replaceOperationsExecutionWakeup } from './operations-execution-queue.js';
import { readOperationsRestartRequest, readOperationsRestartSubject } from './operations-restart-request.js';
import { latestRestartResume } from './operations-restart-resume.js';
import { matchRestartBaseline } from './release-rollout.js';

export type RecoveryFailure = Exclude<OperationsRestartRecoveryFailure, 'native_unconfirmed' | 'lease_expired'>;
type RecoveryAttempt = typeof operationsRestartRecoveries.$inferSelect;
type RecoveryExecution = {
  execution: typeof operationsExecutions.$inferSelect;
  proposal: typeof operationsProposals.$inferSelect;
  schedule: typeof operationsExecutionSchedules.$inferSelect;
  task: TaskRow;
};

export class RestartRecoveryRejected extends Error {
  constructor(readonly reason: 'target_changed' | 'missing_evidence') { super('operations_restart_recovery_' + reason); }
}

export async function startRestartRecovery(tx: Transaction, scope: OperationsExecutionLease) {
  const [last] = await tx.select().from(operationsRestartRecoveries).where(eq(operationsRestartRecoveries.executionId, scope.executionId))
    .orderBy(desc(operationsRestartRecoveries.attempt)).limit(1);
  const attempt = (last?.attempt ?? 0) + 1;
  if ((last && last.state !== 'retry') || attempt > maxOperationsRestartRecoveryAttempts) throw new ExecutionLost();
  await tx.insert(operationsRestartRecoveries).values({ executionId: scope.executionId, attempt, fence: scope.fence, workerId: scope.workerId });
}

export async function findActiveRestartRecovery(tx: Transaction, scope: Pick<OperationsExecutionLease, 'executionId' | 'fence' | 'workerId'>) {
  const [attempt] = await tx.select().from(operationsRestartRecoveries)
    .where(and(eq(operationsRestartRecoveries.executionId, scope.executionId), eq(operationsRestartRecoveries.fence, scope.fence),
      eq(operationsRestartRecoveries.workerId, scope.workerId), eq(operationsRestartRecoveries.state, 'observing'))).for('update');
  return attempt;
}

export async function readRestartRecoveryBinding(tx: Transaction, { execution, proposal, task }: RecoveryExecution, installed: OperationsEnrollmentScope) {
  const frozen = readOperationsProposal(proposal);
  const { target } = frozen;
  if (frozen.action.kind !== 'restart' || execution.environmentId !== target.environmentId || task.projectId !== target.projectId
      || target.environmentId !== installed.environmentId || target.enrollmentSha256 !== installed.enrollmentSha256) {
    throw new RestartRecoveryRejected('target_changed');
  }
  const request = await readOperationsRestartRequest(tx, execution.id).catch(error => {
    if (error instanceof DomainError && error.code === 'unsupported_state') throw new RestartRecoveryRejected('missing_evidence');
    throw error;
  });
  if (!request.runtimeBaseline || !request.runtimeBaselineSha256 || !request.writerInstallationId) throw new RestartRecoveryRejected('missing_evidence');
  const [registration] = await tx.select().from(operationsTargets).where(eq(operationsTargets.environmentId, target.environmentId)).for('share');
  if (!registration || registration.revision !== target.enrollmentRevision || registration.sha256 !== target.enrollmentSha256) {
    throw new RestartRecoveryRejected('target_changed');
  }
  const { whiskers } = readOperationsEnrollment(registration);
  if (request.document.target.serverId !== whiskers.serverId || request.document.target.origin !== whiskers.origin
      || request.document.target.containerId !== target.containerId) throw new RestartRecoveryRejected('target_changed');

  // The write is historical. Authorize the installed read scope using the immutable operation, even after human revocation.
  try {
    const release = await readPublishedOperationsDeployment(tx, target);
    if (release.releaseOperationId !== target.releaseOperationId || release.proofSha256 !== frozen.targetProofSha256
        || release.targetRevision !== target.targetRevision || release.mappingSha256 !== target.mappingSha256
        || release.containerId !== target.containerId || release.applicationId !== target.applicationId
        || release.manifestDigest !== target.manifestDigest || release.configDigest !== target.configDigest) {
      throw new RestartRecoveryRejected('target_changed');
    }
    const subject = await readOperationsRestartSubject(tx, target, release.version);
    return { subject, baseline: matchRestartBaseline(subject, request.runtimeBaseline), request, releaseOperationId: release.releaseOperationId };
  } catch (error) {
    if (error instanceof DomainError) throw new RestartRecoveryRejected('target_changed');
    throw error;
  }
}

export async function proveRestartRecovery(tx: Transaction, scope: OperationsExecutionLease, bound: RecoveryExecution,
  installed: OperationsEnrollmentScope, raw: unknown) {
  const { subject, baseline, request, releaseOperationId } = await readRestartRecoveryBinding(tx, bound, installed);
  const checked = operationsRestartRecoveryObservationSchema.safeParse(raw);
  if (!checked.success) throw new RestartRecoveryRejected('missing_evidence');
  const observation = checked.data;
  const { runtime } = observation;
  if (observation.startedAt <= baseline.startedAt || runtime.containerId !== baseline.containerId || runtime.configDigest !== baseline.configDigest
      || runtime.imageReference !== baseline.imageReference || runtime.runtimeConfigSha256 !== baseline.runtimeConfigSha256
      || runtime.network !== baseline.network || runtime.rolloutCheckSha256 !== subject.rolloutCheckSha256 || runtime.version !== subject.version) {
    throw new RestartRecoveryRejected('target_changed');
  }
  const resume = await latestRestartResume(tx, scope.executionId);
  const native = resume?.state === 'acknowledged' && resume.fence && resume.fence < scope.fence && request.approvalId
    && resume.approvalId === request.approvalId && resume.callSha256 === request.callSha256
    ? { approvalId: request.approvalId, attempt: resume.attempt } : null;
  return operationsRestartRecoveryProofSchema.parse({ version: 1, executionId: scope.executionId, releaseOperationId, fence: scope.fence,
    proposalFingerprint: bound.execution.proposalFingerprint, callSha256: request.callSha256, runtimeBaselineSha256: request.runtimeBaselineSha256,
    native, observation });
}

export async function finishRestartRecovery(tx: Transaction, database: Database, bound: RecoveryExecution, attempt: RecoveryAttempt, workerId: string,
  outcome: { proof: OperationsRestartRecoveryProof } | { failure: Exclude<OperationsRestartRecoveryFailure, 'native_unconfirmed'> }) {
  const { execution, schedule, task } = bound;
  const proof = 'proof' in outcome ? outcome.proof : null;
  const failure = 'failure' in outcome ? outcome.failure : proof?.native ? null : 'native_unconfirmed';
  const retry = (failure === 'unhealthy' || failure === 'unavailable' || failure === 'lease_expired') && attempt.attempt < maxOperationsRestartRecoveryAttempts;
  const state = !failure ? 'verified' : retry ? 'retry' : 'manual_review';
  const proofSha256 = proof && sha256(JSON.stringify(proof));
  const [record] = await tx.update(operationsRestartRecoveries).set({ state, failure, proof, proofSha256 })
    .where(and(eq(operationsRestartRecoveries.executionId, execution.id), eq(operationsRestartRecoveries.attempt, attempt.attempt),
      eq(operationsRestartRecoveries.state, 'observing'))).returning();
  if (!record?.completedAt) throw new ExecutionLost();
  if (state === 'verified') {
    const [released] = await tx.update(operationsExecutions).set({ state: 'recovered' })
      .where(and(eq(operationsExecutions.id, execution.id), eq(operationsExecutions.state, 'reserved'))).returning({ id: operationsExecutions.id });
    if (!released) throw new ExecutionLost();
  }
  const reason = state === 'verified' ? 'operations_restart_recovery_verified' : retry ? 'operations_restart_recovery_retry' : 'operations_restart_recovery_manual';
  await tx.update(runRuntime).set({ reason: retry ? 'operations_execution_reconciling' : reason }).where(eq(runRuntime.runId, schedule.runId));
  await appendEvent(tx, task, 'task.operations_restart_recovery_recorded', state === 'verified' ? 'succeeded' : retry ? 'reconciling' : 'needs_human', {
    workerId, reason, operationsExecution: { executionId: execution.id, proposalId: execution.proposalId, fence: attempt.fence,
      recoveryAttempt: attempt.attempt, ...(proofSha256 ? { recoverySha256: proofSha256 } : {}) },
  });
  if (retry) await replaceOperationsExecutionWakeup(tx, database, schedule, task.generation, 2);
  await clearSlot(tx);
  return state;
}
