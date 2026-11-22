import { eventReasonMessages, idSchema, maxOperationsRestartResumes, operationsRestartExecutionViewSchema, taskEventReasonSchema, translate,
  type Locale, type OperationsRestartExecutionView } from '@itervane/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { VerifiedIdentity } from '../auth/identity.js';
import type { OperationsEnrollmentScope } from '../config.js';
import type { Database } from '../persistence/database.js';
import { operationsExecutions, operationsExecutionSchedules, operationsProposals, operationsRestartRecoveries,
  operationsRestartRequests, runRuntime, taskEvents, tasks } from '../persistence/schema.js';
import { readOperationsRestartRequest } from '../runtime/operations-restart-request.js';
import { latestRestartResume } from '../runtime/operations-restart-resume.js';
import { isHumanWorkspaceOwner, type Actor, type Transaction } from './access.js';
import { DomainError, parseInput } from './errors.js';
import { requireOperationsExecutionApproval, type RestartOperatorScope } from './operations-execution-admission.js';
import { readOperationsExecutionContext } from './operations-execution-view.js';
import { requireOperationsRestartWriter } from './operations-restart-installations.js';
import { databaseNow } from './releases.js';

async function readExecution(tx: Transaction, proposalId: string, projectId: string) {
  // Fetch the state, native receipt and latest check from one database snapshot.
  const latestRecovery = tx.select({ state: operationsRestartRecoveries.state, failure: operationsRestartRecoveries.failure,
    proofSha256: operationsRestartRecoveries.proofSha256 }).from(operationsRestartRecoveries)
    .where(eq(operationsRestartRecoveries.executionId, operationsExecutions.id)).orderBy(desc(operationsRestartRecoveries.attempt))
    .limit(1).as('latest_recovery');
  const [row] = await tx.select({ execution: operationsExecutions, schedule: operationsExecutionSchedules,
    task: { id: tasks.id, version: tasks.version, state: tasks.state }, reason: runRuntime.reason, detail: taskEvents.detail,
    nativeApprovalId: operationsRestartRequests.approvalId,
    recovery: { state: latestRecovery.state, failure: latestRecovery.failure, proofSha256: latestRecovery.proofSha256 },
  }).from(operationsExecutions)
    .innerJoin(operationsExecutionSchedules, eq(operationsExecutionSchedules.executionId, operationsExecutions.id))
    .innerJoin(tasks, and(eq(tasks.id, operationsExecutionSchedules.taskId), eq(tasks.projectId, projectId)))
    .innerJoin(runRuntime, and(eq(runRuntime.runId, operationsExecutionSchedules.runId), eq(runRuntime.taskId, tasks.id)))
    .innerJoin(taskEvents, and(eq(taskEvents.taskId, tasks.id), eq(taskEvents.sequence, tasks.version)))
    .leftJoin(operationsRestartRequests, eq(operationsRestartRequests.executionId, operationsExecutions.id))
    .leftJoinLateral(latestRecovery, sql`true`).where(eq(operationsExecutions.proposalId, proposalId));
  return row;
}

export class OperationsRestartViewService {
  constructor(private readonly database: Database, private readonly installation: OperationsEnrollmentScope, private readonly operator?: RestartOperatorScope) {}

  async get(identity: VerifiedIdentity, rawTaskId: unknown, locale: Locale) {
    const taskId = parseInput(idSchema, rawTaskId);
    return this.database.db.transaction(async tx => {
      const { actor, project, task, run, proposed } = await readOperationsExecutionContext(tx, identity, taskId);
      const view: OperationsRestartExecutionView = { taskId, runId: run.id, locale, execution: null, action: null };
      if (proposed?.frozen.action.kind === 'restart') {
        const { frozen, proposal } = proposed;
        const current = await readExecution(tx, proposal.id, task.projectId);
        if (current) {
          const { execution, schedule, task: actionTask, nativeApprovalId, recovery } = current;
          const reason = taskEventReasonSchema.parse(current.detail.reason ?? current.reason);
          if (execution.proposalFingerprint !== proposal.fingerprint) throw new Error('operations_restart_view_receipt');
          view.execution = { id: execution.id, taskId: actionTask.id, runId: schedule.runId, taskVersion: actionTask.version,
            proposalId: proposal.id, releaseOperationId: frozen.target.releaseOperationId, state: actionTask.state,
            reason, message: translate(locale, eventReasonMessages[reason]), environmentHeld: execution.state === 'reserved',
            nativeApprovalId, recovery };
        }
        if (this.operator && isHumanWorkspaceOwner(identity, actor, project.workspaceId, this.operator.clientId)) {
          view.action = await this.actionFor(tx, task, proposal, current, actor, this.operator).catch(error => {
            if (!(error instanceof DomainError)) throw error;
            return null;
          });
        }
      }
      if (identity.expiresAt * 1_000 <= (await databaseNow(tx)).getTime()) throw new DomainError('unauthenticated');
      return operationsRestartExecutionViewSchema.parse(view);
    });
  }

  private async actionFor(tx: Transaction, task: typeof tasks.$inferSelect, proposal: typeof operationsProposals.$inferSelect,
    current: Awaited<ReturnType<typeof readExecution>> | undefined, actor: Actor, { writer }: RestartOperatorScope):
    Promise<OperationsRestartExecutionView['action']> {
    if (current && (current.execution.state !== 'reserved' || current.task.state !== 'waiting_approval'
        || current.reason !== 'operations_execution_native_approval' || current.schedule.wakeupJobId || !current.nativeApprovalId)) return null;
    const { frozen, whiskers, decision } = await requireOperationsExecutionApproval(tx, task, proposal, this.installation, 1);
    if (actor.principalId !== decision.actorId || actor.workspaceGrantId !== decision.grantId) return null;
    await requireOperationsRestartWriter(tx, frozen.target, whiskers, writer);
    if (!current) return { kind: 'enqueue', proposalId: proposal.id, fingerprint: proposal.fingerprint, decisionVersion: 1 };
    const request = await readOperationsRestartRequest(tx, current.execution.id);
    if (!request.approvalId || request.writerInstallationId !== writer.installationId
        || request.document.credentialSha256 !== writer.credentialSha256) return null;
    const prior = await latestRestartResume(tx, current.execution.id);
    if (prior && (prior.state !== 'pending' || prior.attempt >= maxOperationsRestartResumes)) return null;
    return { kind: 'continue', executionId: current.execution.id, expectedVersion: current.task.version,
      approvalId: request.approvalId, callSha256: request.callSha256 };
  }
}
