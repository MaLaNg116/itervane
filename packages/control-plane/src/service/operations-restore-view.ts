import { eventReasonMessages, idSchema, operationsRestoreExecutionViewSchema, operationsRestoreRecoveryProofSchema,
  releaseKomodoUpdateSchema, taskEventReasonSchema, translate, type Locale, type OperationsRestoreExecutionView } from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { VerifiedIdentity } from '../auth/identity.js';
import type { OperationsEnrollmentScope } from '../config.js';
import type { Database } from '../persistence/database.js';
import { operationsExecutionIntents, operationsExecutionSchedules, operationsExecutions, operationsRestoreRecoveries,
  operationsRestoreSteps, runRuntime, taskEvents, tasks } from '../persistence/schema.js';
import { isHumanWorkspaceOwner, type Transaction } from './access.js';
import { DomainError, parseInput } from './errors.js';
import { requireOperationsExecutionApproval, requireRestoreSubmissionTarget, type RestoreOperatorScope } from './operations-execution-admission.js';
import { readOperationsExecutionContext } from './operations-execution-view.js';
import { databaseNow } from './releases.js';

async function readRestoreExecution(tx: Transaction, proposalId: string, projectId: string) {
  const latestRecovery = tx.select({ state: operationsRestoreRecoveries.state, failure: operationsRestoreRecoveries.failure,
    proof: operationsRestoreRecoveries.proof, proofSha256: operationsRestoreRecoveries.proofSha256, complete: operationsRestoreRecoveries.completedAt,
    attempt: operationsRestoreRecoveries.attempt, fence: operationsRestoreRecoveries.fence }).from(operationsRestoreRecoveries)
    .where(eq(operationsRestoreRecoveries.executionId, operationsExecutions.id)).orderBy(desc(operationsRestoreRecoveries.attempt)).limit(1).as('latest_restore_recovery');
  const [row] = await tx.select({ execution: operationsExecutions, runId: operationsExecutionSchedules.runId,
    task: { id: tasks.id, version: tasks.version, state: tasks.state }, reason: runRuntime.reason, detail: taskEvents.detail,
    planSha256: operationsExecutionIntents.restorePlanSha256, receipt: operationsRestoreSteps.receipt,
    recovery: { state: latestRecovery.state, failure: latestRecovery.failure, proof: latestRecovery.proof, proofSha256: latestRecovery.proofSha256,
      completedAt: latestRecovery.complete, attempt: latestRecovery.attempt, fence: latestRecovery.fence },
  }).from(operationsExecutions)
    .innerJoin(operationsExecutionSchedules, eq(operationsExecutionSchedules.executionId, operationsExecutions.id))
    .innerJoin(tasks, and(eq(tasks.id, operationsExecutionSchedules.taskId), eq(tasks.projectId, projectId)))
    .innerJoin(runRuntime, and(eq(runRuntime.runId, operationsExecutionSchedules.runId), eq(runRuntime.taskId, tasks.id)))
    .innerJoin(taskEvents, and(eq(taskEvents.taskId, tasks.id), eq(taskEvents.sequence, tasks.version)))
    .leftJoin(operationsExecutionIntents, eq(operationsExecutionIntents.executionId, operationsExecutions.id))
    .leftJoin(operationsRestoreSteps, and(eq(operationsRestoreSteps.executionId, operationsExecutions.id), eq(operationsRestoreSteps.kind, 'deploy')))
    .leftJoinLateral(latestRecovery, sql`true`).where(eq(operationsExecutions.proposalId, proposalId));
  return row;
}

function readVerification(record: NonNullable<Awaited<ReturnType<typeof readRestoreExecution>>>, restoreOperationId: string, updateId: string | null) {
  const { execution, recovery, task, planSha256 } = record;
  if (recovery?.state !== 'verified') {
    if (execution.state === 'recovered') throw new Error('operations_restore_view_receipt');
    return recovery ? { state: recovery.state, failure: recovery.failure, proof: null } : null;
  }
  const proof = operationsRestoreRecoveryProofSchema.parse(recovery.proof);
  if (proof.executionId !== execution.id || proof.restoreOperationId !== restoreOperationId || proof.planSha256 !== planSha256
      || proof.update.updateId !== updateId || proof.fence !== recovery.fence || proof.attempt !== recovery.attempt
      || !recovery.proofSha256 || sha256(JSON.stringify(proof)) !== recovery.proofSha256
      || !recovery.completedAt || execution.closedAt?.getTime() !== recovery.completedAt.getTime()
      || execution.state !== 'recovered' || task.state !== 'succeeded') throw new Error('operations_restore_view_receipt');
  return { state: recovery.state, failure: null, proof: { proofSha256: recovery.proofSha256,
    version: proof.runtime.version, verifiedAt: recovery.completedAt.toISOString() } };
}

export class OperationsRestoreViewService {
  constructor(private readonly database: Database, private readonly installation: OperationsEnrollmentScope, private readonly operator?: RestoreOperatorScope) {}

  async get(identity: VerifiedIdentity, rawTaskId: unknown, locale: Locale) {
    const taskId = parseInput(idSchema, rawTaskId);
    return this.database.db.transaction(async tx => {
      const { actor, project, task, run, proposed } = await readOperationsExecutionContext(tx, identity, taskId);
      const view: OperationsRestoreExecutionView = { taskId, runId: run.id, locale, execution: null, action: null };
      if (proposed?.frozen.action.kind === 'rollback') {
        const { proposal, frozen: { action, target } } = proposed;
        const current = await readRestoreExecution(tx, proposal.id, task.projectId);
        if (current) {
          const { execution, runId, task: actionTask, receipt } = current;
          const reason = taskEventReasonSchema.parse(current.detail.reason ?? current.reason);
          if (execution.proposalFingerprint !== proposal.fingerprint || execution.environmentId !== target.environmentId) throw new Error('operations_restore_view_binding');
          const nativeUpdateId = receipt ? releaseKomodoUpdateSchema.parse(receipt).updateId : null;
          view.execution = { id: execution.id, taskId: actionTask.id, runId, taskVersion: actionTask.version,
            proposalId: proposal.id, releaseOperationId: target.releaseOperationId, state: actionTask.state,
            reason, message: translate(locale, eventReasonMessages[reason]), environmentHeld: execution.state === 'reserved',
            restore: { operationId: action.restore.operationId, manifestDigest: action.restore.manifestDigest }, nativeUpdateId,
            recovery: readVerification(current, action.restore.operationId, nativeUpdateId) };
        } else if (this.operator && isHumanWorkspaceOwner(identity, actor, project.workspaceId, this.operator.clientId)) {
          try {
            const { frozen, decision } = await requireOperationsExecutionApproval(tx, task, proposal, this.installation, 1);
            if (actor.principalId === decision.actorId && actor.workspaceGrantId === decision.grantId) {
              await requireRestoreSubmissionTarget(tx, frozen, this.operator.restoreTarget);
              view.action = { kind: 'enqueue', proposalId: proposal.id, fingerprint: proposal.fingerprint, decisionVersion: 1 };
            }
          } catch (error) { if (!(error instanceof DomainError)) throw error; }
        }
      }
      if (identity.expiresAt * 1_000 <= (await databaseNow(tx)).getTime()) throw new DomainError('unauthenticated');
      return operationsRestoreExecutionViewSchema.parse(view);
    });
  }
}
