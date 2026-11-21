import {
  eventReasonMessages, formalVerificationInputSchema, formalVerificationResultSchema, idSchema,
  taskEventReasonSchema, translate, verificationViewSchema, type Locale, type MessageKey, type RecordedVerificationView,
} from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { and, eq } from 'drizzle-orm';
import type { VerifiedIdentity } from '../auth/identity.js';
import type { Database } from '../persistence/database.js';
import { formalRescanAttempts, formalVerificationInputs, formalVerificationResults, formalVerificationRuntime, runRuntime, taskRuns, tasks }
  from '../persistence/schema.js';
import type { TaskRow } from '../runtime/authority.js';
import { recordedVerificationEvidence } from '../runtime/verification-evidence.js';
import { requireActor, requireProject, type Transaction } from './access.js';
import { DomainError, parseInput } from './errors.js';
import { readRepairRetry } from './repair-retry.js';

type RunRef = { runId: string; generation: number };
const outcomeMessages: Record<RecordedVerificationView['outcome'], MessageKey> = {
  observed: 'reason.verification_observed', checks_failed: 'reason.verification_checks_failed',
  source_findings: 'reason.verification_checks_failed', incomplete: 'reason.verification_needs_human',
  requires_human: 'reason.verification_needs_human',
};

async function readRecord(tx: Transaction, task: TaskRow, run: RunRef, locale: Locale): Promise<RecordedVerificationView | null> {
  const [entry] = await tx.select({ row: formalVerificationResults, input: formalVerificationInputs, pointer: formalVerificationRuntime, attempt: formalRescanAttempts })
    .from(formalVerificationResults)
    .innerJoin(taskRuns, and(eq(taskRuns.id, formalVerificationResults.runId), eq(taskRuns.taskId, task.id), eq(taskRuns.generation, run.generation)))
    .innerJoin(formalVerificationInputs, eq(formalVerificationInputs.runId, taskRuns.id))
    .innerJoin(formalVerificationRuntime, eq(formalVerificationRuntime.runId, taskRuns.id))
    .innerJoin(formalRescanAttempts, eq(formalRescanAttempts.requestId, formalVerificationResults.requestId))
    .where(eq(taskRuns.id, run.runId));
  if (!entry) return null;

  const { row, input: storedInput, pointer, attempt } = entry;
  const input = formalVerificationInputSchema.parse(storedInput.document);
  const result = formalVerificationResultSchema.parse(row.document);
  const { receipt, evidence } = recordedVerificationEvidence(attempt.receipt, row.receiptSha256);
  if (result.taskId !== task.id || result.projectId !== task.projectId || result.locale !== task.locale
      || result.runId !== run.runId || result.generation !== run.generation || sha256(JSON.stringify(result)) !== row.sha256
      || result.inputSha256 !== row.inputSha256 || result.receiptSha256 !== row.receiptSha256 || result.requestId !== row.requestId
      || result.checkpointId !== row.checkpointId || pointer.checkpointId !== row.checkpointId
      || pointer.inputSha256 !== row.inputSha256 || pointer.receiptSha256 !== row.receiptSha256
      || attempt.state !== 'recorded' || attempt.runId !== run.runId || attempt.inputSha256 !== row.inputSha256
      || attempt.receiptSha256 !== row.receiptSha256 || receipt.scope.requestId !== row.requestId
      || input.taskId !== task.id || input.projectId !== task.projectId || input.runId !== run.runId || input.generation !== run.generation
      || input.source.repositoryId !== task.repositoryId || input.source.commit !== task.commit || input.locale !== task.locale
      || storedInput.sha256 !== row.inputSha256 || sha256(JSON.stringify(input)) !== row.inputSha256
      || input.subject.manifestSha256 !== evidence.binding.subjectManifestSha256
      || evidence.binding.source.repositoryId !== task.repositoryId || evidence.binding.source.commit !== task.commit
      || JSON.stringify(evidence) !== JSON.stringify(result.evidence)) {
    throw new Error('formal_verification_view_integrity');
  }

  const outcome = result.review?.outcome ?? 'requires_human';
  const { source, build, baseline, image } = evidence;
  return { ...run, status: 'recorded', outcome, message: translate(locale, outcomeMessages[outcome]), recordedAt: row.createdAt.toISOString(),
    resultSha256: row.sha256, receiptSha256: row.receiptSha256, candidateManifestSha256: evidence.binding.subjectManifestSha256,
    source, build, baseline, image: image.status === 'scanned'
      ? { status: image.status, manifestDigest: image.manifestDigest, findings: image.findings } : { status: image.status },
  };
}

function waitingStatus(task: TaskRow, reason: string | null, locale: Locale) {
  const parsed = taskEventReasonSchema.safeParse(reason);
  const text = (fallback: MessageKey) => translate(locale, parsed.success ? eventReasonMessages[parsed.data] : fallback);
  if (task.state === 'cancel_requested' || task.state === 'cancelled') {
    return { status: task.state, message: translate(locale, `task.${task.state}`) } as const;
  }
  if (task.state === 'reconciling') return { status: 'reconciling', message: text('state.reconciling') } as const;
  if (task.state === 'needs_human' || task.state === 'failed' || reason === 'verification_unavailable') {
    return { status: 'unavailable', message: text('reason.verification_unavailable') } as const;
  }
  return { status: 'pending', message: translate(locale, reason === 'verification_pending' ? 'reason.verification_pending' : 'verification.pending') } as const;
}

export class VerificationViewService {
  constructor(private readonly database: Database) {}

  async get(identity: VerifiedIdentity, taskId: string, locale: Locale) {
    parseInput(idSchema, taskId);
    return this.database.db.transaction(async tx => {
      const actor = await requireActor(tx, identity);
      const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for('share');
      if (!task) throw new DomainError('not_found');
      await requireProject(tx, actor, task.projectId);
      const [current] = await tx.select({ runId: taskRuns.id, reason: runRuntime.reason }).from(taskRuns)
        .innerJoin(runRuntime, eq(runRuntime.runId, taskRuns.id))
        .where(and(eq(taskRuns.taskId, taskId), eq(taskRuns.generation, task.generation)));
      if (!current) throw new DomainError('unavailable');

      const run = { runId: current.runId, generation: task.generation };
      const result = await readRecord(tx, task, run, locale);
      const retry = await readRepairRetry(tx, task, run);
      const previous = retry ? await readRecord(tx, task, { runId: retry.previous.previousRunId, generation: run.generation - 1 }, locale) : null;
      if (retry && (!previous || previous.resultSha256 !== retry.previous.verificationResultSha256
          || previous.receiptSha256 !== retry.previous.receiptSha256 || previous.candidateManifestSha256 !== retry.previous.candidateManifestSha256
          || previous.outcome !== retry.previous.failure.outcome)) {
        throw new Error('formal_verification_view_retry_binding');
      }
      return verificationViewSchema.parse({ version: 1, taskId, locale, current: result ?? { ...run, ...waitingStatus(task, current.reason, locale) }, previous });
    });
  }
}
