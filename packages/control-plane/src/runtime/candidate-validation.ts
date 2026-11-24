import { randomUUID } from 'node:crypto';
import {
  candidateValidationRecordSchema, qualifiedRuleValidationResponseSchema, runbookEvaluationResultSchema,
  type CandidateValidationEvidence, type CodeRuleValidationProfile,
} from '@itervane/contracts';
import { evaluateRunbookSamples } from '@itervane/rules';
import { canonicalRuleValidationCommand, prepareQualifiedRuleValidationRequest, sha256, verifyQualifiedRuleValidationReceipt,
  type QualifiedInspectionClient } from '@itervane/runner';
import { eq } from 'drizzle-orm';
import { candidateValidationAttempts, candidateValidationResults, runRuntime } from '../persistence/schema.js';
import { readCandidateForValidation, requireCandidateValidationAdmission } from '../service/candidate-validations.js';
import type { Transaction } from '../service/access.js';
import { appendEvent, clearSlot, ExecutionLost, type ExecutionScope, type TaskRow } from './authority.js';
import type { ExecutionCoordinator } from './coordinator.js';

export type CandidateValidationOptions = Readonly<{
  code?: { profile: CodeRuleValidationProfile; runner: Pick<QualifiedInspectionClient, 'observe' | 'validateRuleSamples'> };
}>;
type Admission = Awaited<ReturnType<typeof requireCandidateValidationAdmission>>;

async function settle(tx: Transaction, task: TaskRow, scope: ExecutionScope, admission: Admission, evidence: CandidateValidationEvidence) {
  const { plan, planSha256 } = admission;
  if (plan.kind !== evidence.kind) throw new Error('candidate_validation_evidence_kind');
  const status = evidence.kind === 'code_rule' ? evidence.receipt.proof.result.status : evidence.result.status;
  const record = candidateValidationRecordSchema.parse({
    version: 1, taskId: task.id, runId: scope.runId, projectId: task.projectId, candidateId: plan.candidateId,
    extractionResultSha256: plan.extractionResultSha256, candidateSha256: plan.candidateSha256, planSha256, status, evidence,
  });
  const digest = sha256(JSON.stringify(record));
  const requestId = evidence.kind === 'code_rule' ? evidence.receipt.scope.requestId : null;
  const [result] = await tx.insert(candidateValidationResults).values({
    runId: scope.runId, candidateId: plan.candidateId, projectId: task.projectId, requestId, planSha256,
    sha256: digest, fence: scope.fence, workerId: scope.workerId, document: record,
  }).returning({ id: candidateValidationResults.id });
  if (!result) throw new ExecutionLost();
  await tx.update(runRuntime).set({ reason: null, toolsUsed: requestId ? 1 : 0 }).where(eq(runRuntime.runId, scope.runId));
  await appendEvent(tx, task, 'task.candidate_validation_recorded', status === 'passed' ? 'succeeded' : 'needs_human', {
    workerId: scope.workerId, candidateValidation: { runId: scope.runId, validationResultId: result.id, validationResultSha256: digest },
  });
  await clearSlot(tx);
}

export async function runCandidateValidation(coordinator: ExecutionCoordinator, scope: ExecutionScope,
  options: CandidateValidationOptions | undefined, signal: AbortSignal) {
  if (!options) return coordinator.stop(scope, 'candidate_validation_unavailable');
  const { admission, candidate, projectId } = await coordinator.withLease(scope, async (tx, { task, run }) => {
    if (run.role !== 'verify') throw new ExecutionLost();
    const bound = await requireCandidateValidationAdmission(tx, task, scope.runId);
    const stored = await readCandidateForValidation(tx, task.projectId, bound.candidateId);
    if (stored.row.sha256 !== bound.plan.extractionResultSha256 || stored.candidate.kind !== bound.plan.kind
        || sha256(JSON.stringify(stored.candidate)) !== bound.plan.candidateSha256) throw new Error('candidate_validation_source_integrity');
    return { admission: bound, candidate: stored.candidate, projectId: task.projectId };
  });
  if (candidate.kind === 'runbook') {
    const result = runbookEvaluationResultSchema.parse(evaluateRunbookSamples(candidate));
    return coordinator.withLease(scope, (tx, { task }) => {
      signal.throwIfAborted();
      return settle(tx, task, scope, admission, { kind: 'runbook', evaluatorVersion: 1, result });
    });
  }
  const { plan } = admission;
  const code = options.code;
  if (plan.kind !== 'code_rule' || !code || JSON.stringify(code.profile) !== JSON.stringify(plan.profile)) {
    return coordinator.stop(scope, 'candidate_validation_unavailable');
  }
  const status = await code.runner.observe(signal);
  if (!status || status.imageSha256 !== plan.profile.runnerImageSha256) return coordinator.stop(scope, 'candidate_validation_unavailable');
  // A recovered lease starts another domain only after the qualified controller observes an empty workspace.
  if (status.state !== 'idle') return coordinator.stop(scope, 'candidate_validation_cleanup_unknown');
  const reference = { candidateId: plan.candidateId, extractionResultSha256: plan.extractionResultSha256 };
  const command = canonicalRuleValidationCommand(candidate, reference, plan.profile);
  const coordinates = { taskId: scope.taskId, runId: scope.runId, generation: scope.generation, fence: scope.fence,
    projectId, requestId: randomUUID(), workspaceSha256: status.workspaceSha256 };
  const request = prepareQualifiedRuleValidationRequest(coordinates, command);
  await coordinator.withLease(scope, async tx => {
    signal.throwIfAborted();
    await tx.insert(candidateValidationAttempts).values({ requestId: request.requestId, runId: scope.runId, fence: scope.fence,
      workerId: scope.workerId, planSha256: admission.planSha256, request });
  });
  const received = qualifiedRuleValidationResponseSchema.parse(await code.runner.validateRuleSamples(coordinates, candidate, reference,
    plan.profile, () => coordinator.withLease(scope, async () => { signal.throwIfAborted(); }), signal));
  signal.throwIfAborted();
  if (received.kind === 'rejected') return coordinator.stop(scope, received.cleanup === 'unknown'
    ? 'candidate_validation_cleanup_unknown' : 'candidate_validation_unavailable');
  verifyQualifiedRuleValidationReceipt(received, request, command);
  await coordinator.withLease(scope, async (tx, { task }) => {
    signal.throwIfAborted();
    await settle(tx, task, scope, admission, { kind: 'code_rule', receipt: received });
  });
}
