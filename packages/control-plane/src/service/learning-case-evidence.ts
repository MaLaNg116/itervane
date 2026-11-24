import { operationsRestartRecoveryProofSchema, verificationComparisonCountsSchema, type LearningCaseFacts } from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { and, eq } from 'drizzle-orm';
import { operationsDecisions, operationsExecutions, operationsExecutionSchedules, operationsProposals, operationsRestartRecoveries,
  operationsRestartResumes, taskEvents, taskRuns, tasks } from '../persistence/schema.js';
import type { TaskRow } from '../runtime/authority.js';
import { readOperationsRestartRequest } from '../runtime/operations-restart-request.js';
import type { Transaction } from './access.js';
import { DomainError } from './errors.js';
import { readOperationsProposal } from './operations-proposals.js';
import { readOperationsTaskRecord } from './operations-records.js';
import { readPublishedVerification } from './verification-result.js';

type CaseEvidence = { facts: LearningCaseFacts; evidenceSha256: string; recordedAt: Date };

export async function readDeliveryCaseEvidence(tx: Transaction, task: TaskRow, runId: string): Promise<CaseEvidence> {
  if (task.state !== 'waiting_input' && task.state !== 'waiting_approval' && task.state !== 'succeeded') throw new DomainError('unsupported_state');
  const verified = await readPublishedVerification(tx, task, { runId, generation: task.generation });
  if (!verified || verified.result.review?.outcome !== 'observed' || verified.input.subject.kind !== 'repair'
      || verified.evidence.source.status !== 'compared' || verified.evidence.source.introduced !== 0) throw new DomainError('unsupported_state');
  const { input, evidence } = verified;
  const repair = input.subject;
  if (repair.kind !== 'repair') throw new Error('learning_case_repair_integrity');
  const comparison = verificationComparisonCountsSchema.strip().parse(evidence.source);
  const observed = {
    patchSha256: repair.patchSha256, originalSnapshotSha256: input.inspection.snapshotSha256,
    repairedSnapshotSha256: repair.manifestSha256, verificationReceiptSha256: verified.row.receiptSha256, sourceComparison: comparison,
  };
  let facts: LearningCaseFacts;
  if (input.healthReproduction) {
    const previous = await readPublishedVerification(tx, task, { runId: input.healthReproduction.previousRunId, generation: 1 });
    const before = previous?.evidence.baseline.status === 'passed' ? previous.evidence.baseline.healthFollowup : undefined;
    const after = evidence.baseline.status === 'passed' ? evidence.baseline.healthFollowup : undefined;
    if (before?.status !== 'unhealthy' || after?.status !== 'passed') throw new DomainError('unsupported_state');
    facts = { ...observed, category: 'reproduced_health_failure', originalHealthStatus: before.statusCode,
      repairedHealthStatus: after.statusCode, reproductionSha256: input.healthReproduction.receiptSha256 };
  } else {
    if (comparison.resolved === 0) throw new DomainError('unsupported_state');
    facts = { ...observed, category: 'resolved_source_findings' };
  }
  return { facts, evidenceSha256: verified.row.sha256, recordedAt: verified.row.createdAt };
}

export async function readRestartCaseEvidence(tx: Transaction, task: TaskRow): Promise<CaseEvidence> {
  const { run, request, diagnosis, observation } = await readOperationsTaskRecord(tx, task);
  const state = observation?.receipt.observation.state;
  if (!diagnosis || (state !== 'exited' && state !== 'dead') || diagnosis.receipt.result.recommendation.code !== 'review_restart') {
    throw new DomainError('unsupported_state');
  }
  const [recovered] = await tx.select({ proposal: operationsProposals, execution: operationsExecutions,
    decision: operationsDecisions, recovery: operationsRestartRecoveries, actionTask: tasks, event: taskEvents }).from(operationsProposals)
    .innerJoin(operationsExecutions, and(eq(operationsExecutions.proposalId, operationsProposals.id), eq(operationsExecutions.state, 'recovered')))
    .innerJoin(operationsDecisions, and(eq(operationsDecisions.proposalId, operationsProposals.id),
      eq(operationsDecisions.version, operationsExecutions.decisionVersion), eq(operationsDecisions.action, 'confirm')))
    .innerJoin(operationsExecutionSchedules, eq(operationsExecutionSchedules.executionId, operationsExecutions.id))
    .innerJoin(tasks, and(eq(tasks.id, operationsExecutionSchedules.taskId), eq(tasks.projectId, task.projectId), eq(tasks.state, 'succeeded')))
    .innerJoin(taskRuns, and(eq(taskRuns.id, operationsExecutionSchedules.runId), eq(taskRuns.taskId, tasks.id),
      eq(taskRuns.generation, tasks.generation), eq(taskRuns.role, 'operations'), eq(taskRuns.state, 'succeeded')))
    .innerJoin(taskEvents, and(eq(taskEvents.taskId, tasks.id), eq(taskEvents.sequence, tasks.version)))
    .innerJoin(operationsRestartRecoveries, and(eq(operationsRestartRecoveries.executionId, operationsExecutions.id),
      eq(operationsRestartRecoveries.state, 'verified'))).where(eq(operationsProposals.diagnosisRunId, run.id));
  if (!recovered) throw new DomainError('unsupported_state');
  const { proposal, execution, recovery, event, decision, actionTask } = recovered;
  const frozen = readOperationsProposal(proposal);
  const proof = operationsRestartRecoveryProofSchema.parse(recovery.proof);
  const native = await readOperationsRestartRequest(tx, execution.id);
  const baseline = native.runtimeBaseline;
  const { runtime, startedAt } = proof.observation;
  if (!recovery.proofSha256 || !recovery.completedAt || !proof.native || !baseline || !execution.closedAt
      || frozen.action.kind !== 'restart' || frozen.diagnosis.taskId !== task.id || frozen.diagnosis.sha256 !== diagnosis.sha256
      || sha256(JSON.stringify(frozen.target)) !== request.sha256 || sha256(JSON.stringify(proof)) !== recovery.proofSha256
      || execution.proposalFingerprint !== proposal.fingerprint || execution.environmentId !== frozen.target.environmentId
      || proof.executionId !== execution.id || proof.proposalFingerprint !== proposal.fingerprint || proof.fence !== recovery.fence
      || proof.releaseOperationId !== frozen.target.releaseOperationId || proof.callSha256 !== native.callSha256
      || proof.runtimeBaselineSha256 !== native.runtimeBaselineSha256 || proof.native.approvalId !== native.approvalId
      || baseline.containerId !== frozen.target.containerId || native.document.target.containerId !== baseline.containerId
      || runtime.containerId !== baseline.containerId || runtime.configDigest !== baseline.configDigest
      || runtime.imageReference !== baseline.imageReference || runtime.runtimeConfigSha256 !== baseline.runtimeConfigSha256
      || runtime.network !== baseline.network || startedAt <= baseline.startedAt
      || event.type !== 'task.operations_restart_recovery_recorded' || event.state !== 'succeeded'
      || event.detail.executionId !== execution.id || event.detail.recoverySha256 !== recovery.proofSha256) {
    throw new Error('learning_case_restart_integrity');
  }
  const [resumed] = await tx.select().from(operationsRestartResumes).where(and(eq(operationsRestartResumes.executionId, execution.id),
    eq(operationsRestartResumes.attempt, proof.native.attempt)));
  if (resumed?.state !== 'acknowledged' || !resumed.fence || resumed.fence >= proof.fence || resumed.callSha256 !== native.callSha256
      || resumed.approvalId !== proof.native.approvalId || resumed.actorId !== decision.actorId || resumed.grantId !== decision.grantId) {
    throw new Error('learning_case_restart_acknowledgement_integrity');
  }
  return { evidenceSha256: recovery.proofSha256, recordedAt: recovery.completedAt, facts: {
    category: 'recovered_stopped_instance', diagnosisSha256: diagnosis.sha256, proposalSha256: proposal.fingerprint,
    releaseOperationId: proof.releaseOperationId, executionId: execution.id, actionTaskId: actionTask.id, diagnosisState: state,
    restartAttempt: proof.native.attempt, result: 'verified_recovered', sameInstance: true,
    healthStatus: runtime.healthStatus, anonymousStatus: runtime.anonymousStatus,
  } };
}
