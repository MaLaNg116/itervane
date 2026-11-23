import {
  eventReasonMessages, idSchema,
  taskEventReasonSchema, translate, verificationViewSchema, type Locale, type MessageKey, type RecordedVerificationView,
} from '@itervane/contracts';
import { and, eq } from 'drizzle-orm';
import type { VerifiedIdentity } from '../auth/identity.js';
import type { Database } from '../persistence/database.js';
import { runRuntime, taskRuns, tasks } from '../persistence/schema.js';
import type { TaskRow } from '../runtime/authority.js';
import { requireActor, requireProject, type Transaction } from './access.js';
import { DomainError, parseInput } from './errors.js';
import { readRepairRetry } from './repair-retry.js';
import { readPublishedVerification } from './verification-result.js';

type RunRef = { runId: string; generation: number };
const outcomeMessages: Record<RecordedVerificationView['outcome'], MessageKey> = {
  observed: 'reason.verification_observed', checks_failed: 'reason.verification_checks_failed',
  source_findings: 'reason.verification_checks_failed', incomplete: 'reason.verification_needs_human',
  requires_human: 'reason.verification_needs_human',
};

async function readRecord(tx: Transaction, task: TaskRow, run: RunRef, locale: Locale): Promise<RecordedVerificationView | null> {
  const verification = await readPublishedVerification(tx, task, run);
  if (!verification) return null;
  const { row, result, evidence } = verification;

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
      const prior = retry?.previous;
      const priorManifest = prior && ('subjectManifestSha256' in prior ? prior.subjectManifestSha256 : prior.candidateManifestSha256);
      const priorOutcome = prior && ('regression' in prior ? 'checks_failed' : prior.failure.outcome);
      if (prior && (!previous || previous.resultSha256 !== prior.verificationResultSha256
          || previous.receiptSha256 !== prior.receiptSha256 || previous.candidateManifestSha256 !== priorManifest || previous.outcome !== priorOutcome)) {
        throw new Error('formal_verification_view_retry_binding');
      }
      return verificationViewSchema.parse({ version: 1, taskId, locale, current: result ?? { ...run, ...waitingStatus(task, current.reason, locale) }, previous });
    });
  }
}
