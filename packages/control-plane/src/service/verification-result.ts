import { finishFormalVerification, type FormalVerificationReport } from '@itervane/agent';
import { formalVerificationResultSchema, type FormalVerificationEvidence,
  type FormalVerificationResult, type QualifiedOciArchiveVerification } from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../persistence/database.js';
import { formalRescanAttempts, formalVerificationResults, formalVerificationRuntime, runRuntime } from '../persistence/schema.js';
import { appendEvent, clearSlot, ExecutionLost, type ExecutionScope, type TaskRow } from '../runtime/authority.js';
import { recordedVerificationEvidence } from '../runtime/verification-evidence.js';
import type { Transaction } from './access.js';
import { DomainError } from './errors.js';
import { enqueueRepairRetry, prepareRepairRetry, readRepairRetry } from './repair-retry.js';

function recordedObservations(report: FormalVerificationReport, evidence: FormalVerificationEvidence) {
  if (report.trace.length !== report.evidence.length) throw new Error('formal_verification_trace');
  return report.evidence.map(({ id, ...observation }, index) => {
    const { data, bindingSha256, snapshotSha256, origin } = observation;
    const trace = report.trace[index];
    if (origin !== 'formal_verification' || bindingSha256 !== report.bindingSha256 || sha256(JSON.stringify(observation)) !== id
        || snapshotSha256 !== evidence.binding.subjectManifestSha256 || data.kind !== 'verification_section'
        || data.receiptSha256 !== evidence.binding.receiptSha256 || JSON.stringify(data.result) !== JSON.stringify(evidence[data.section])
        || trace?.tool !== 'read_verification' || trace.role !== 'verify' || trace.evidenceId !== id) {
      throw new Error('formal_verification_observation_binding');
    }
    return { id, section: data.section };
  });
}

export async function publishFormalVerification(tx: Transaction, task: TaskRow, scope: ExecutionScope,
  result: { report: FormalVerificationReport; evidence: FormalVerificationEvidence; archiveVerification?: QualifiedOciArchiveVerification },
  provider: FormalVerificationResult['provider'], signal: AbortSignal,
  retryConfig?: { database: Database; repairPolicySha256: string }) {
  signal.throwIfAborted();
  const { report, archiveVerification } = result;
  const [entry] = await tx.select({ pointer: formalVerificationRuntime, attempt: formalRescanAttempts })
    .from(formalVerificationRuntime).innerJoin(formalRescanAttempts, and(eq(formalRescanAttempts.runId, formalVerificationRuntime.runId),
      eq(formalRescanAttempts.inputSha256, formalVerificationRuntime.inputSha256),
      eq(formalRescanAttempts.receiptSha256, formalVerificationRuntime.receiptSha256)))
    .where(and(eq(formalVerificationRuntime.runId, scope.runId), eq(formalRescanAttempts.state, 'recorded')));
  if (!entry || entry.pointer.checkpointId !== report.checkpointId || report.runId !== scope.runId || report.role !== 'verify'
      || report.origin !== 'formal_verification') throw new ExecutionLost();
  const { receipt, evidence } = recordedVerificationEvidence(entry.attempt.receipt, entry.pointer.receiptSha256);
  if (JSON.stringify(evidence) !== JSON.stringify(result.evidence)) throw new Error('formal_verification_projection_binding');
  if (archiveVerification && archiveVerification.runnerImageSha256 !== receipt.imageSha256) {
    throw new Error('formal_verification_archive_runner');
  }

  const review = report.formalVerification ?? null;
  if (report.status === 'completed') {
    if (!review) throw new DomainError('unavailable');
    const { summary, evidenceIds, followUps } = review;
    if (JSON.stringify(finishFormalVerification(report.evidence, { summary, evidenceIds, followUps })) !== JSON.stringify(review)) {
      throw new Error('formal_verification_review_binding');
    }
  } else if (report.status !== 'requires_human' || review) throw new DomainError('unavailable');

  const { runId, generation, fence: finalizedFence, workerId } = scope;
  const { inputSha256, receiptSha256, checkpointId } = entry.pointer;
  const requestId = entry.attempt.requestId;
  const document = formalVerificationResultSchema.parse({
    version: 1, taskId: task.id, runId, projectId: task.projectId, generation, locale: task.locale,
    requestId, inputSha256, receiptSha256, checkpointId, provider, releaseEligible: report.releaseEligible, usage: report.usage,
    evidence, ...(archiveVerification ? { archiveVerification } : {}), observations: recordedObservations(report, evidence), review,
    status: review ? 'reviewed' : 'requires_human', reason: report.reason,
  });
  const hash = sha256(JSON.stringify(document));
  await tx.insert(formalVerificationResults).values({ runId, inputSha256, receiptSha256, checkpointId, requestId, finalizedFence, workerId,
    sha256: hash, document });

  const observed = review?.outcome === 'observed';
  const failed = review?.outcome === 'checks_failed' || review?.outcome === 'source_findings';
  const retry = failed && retryConfig ? await prepareRepairRetry(tx, task, scope, document, hash, retryConfig.repairPolicySha256) : undefined;
  const exhausted = failed && Boolean(await readRepairRetry(tx, task, scope));
  const reason = observed ? 'verification_observed' : exhausted ? 'repair_retry_limit'
    : failed ? 'verification_checks_failed' : 'verification_needs_human';
  await tx.update(runRuntime).set({ reason, resumePending: false, waitingForTaskId: null }).where(eq(runRuntime.runId, runId));
  const recordedTask = await appendEvent(tx, task, 'task.verification_recorded', retry ? 'running' : observed ? 'waiting_input' : 'needs_human', {
    workerId, reason, verification: { runId, verificationResultSha256: hash },
  });
  if (retry && retryConfig) await enqueueRepairRetry(tx, retryConfig.database, recordedTask, scope, retry);
  await clearSlot(tx);
  signal.throwIfAborted();
}
