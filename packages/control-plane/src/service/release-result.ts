import {
  eventReasonMessages, formalReleaseOperationResultSchema, releaseRolloutProofSchema, taskEventReasonSchema, translate, type Locale,
} from '@itervane/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';
import { formalReleaseRolloutAttempts, formalReleaseSteps, releaseCandidates, releaseOperations, taskEvents } from '../persistence/schema.js';
import type { Transaction } from './access.js';

export async function readFormalReleaseOperationResult(
  tx: Transaction, scope: { taskId: string; runId: string; candidateId: string }, locale: Locale,
) {
  // The caller holds the project grant and task row while reading this operation.
  const [row] = await tx.select({
    operationId: releaseOperations.id, candidateId: releaseCandidates.id, state: releaseOperations.state,
    updateId: formalReleaseSteps.externalUpdateId, attempt: formalReleaseRolloutAttempts.state,
    proof: formalReleaseRolloutAttempts.proof, checkedAt: formalReleaseRolloutAttempts.completedAt,
    live: sql<boolean | null>`${formalReleaseRolloutAttempts.leaseUntil} > statement_timestamp()`,
    failure: formalReleaseRolloutAttempts.failure,
  }).from(releaseOperations)
    .innerJoin(releaseCandidates, eq(releaseCandidates.id, releaseOperations.candidateId))
    .leftJoin(formalReleaseSteps, and(eq(formalReleaseSteps.operationId, releaseOperations.id), eq(formalReleaseSteps.kind, 'komodo_dispatch')))
    .leftJoin(formalReleaseRolloutAttempts, eq(formalReleaseRolloutAttempts.operationId, releaseOperations.id))
    .where(and(eq(releaseCandidates.id, scope.candidateId), eq(releaseCandidates.taskId, scope.taskId),
      eq(releaseCandidates.runId, scope.runId), sql`${releaseCandidates.document}->>'origin' = 'formal_verification'`))
    .orderBy(desc(formalReleaseRolloutAttempts.fence)).limit(1);
  if (!row) return null;

  const base = { operationId: row.operationId, candidateId: row.candidateId, updateId: row.updateId, locale };
  if (row.state === 'verified_formal') {
    const proof = releaseRolloutProofSchema.parse(row.proof);
    if (row.attempt !== 'verified' || !row.checkedAt || proof.operationId !== row.operationId ||
        proof.candidateId !== row.candidateId || proof.update.updateId !== row.updateId) throw new Error('formal_release_result_integrity');
    return formalReleaseOperationResultSchema.parse({ ...base, status: 'verified',
      message: translate(locale, 'release.operation.verified_formal'), evidence: {
        checkedAt: row.checkedAt.toISOString(), manifestDigest: proof.manifestDigest, configDigest: proof.runtime.configDigest,
        version: proof.runtime.version, healthy: true, accessProtected: true,
      },
    });
  }
  if (row.state === 'verified_fixture') throw new Error('formal_release_result_integrity');
  if (row.state === 'queued' || row.state === 'dispatching') {
    const message = row.state === 'queued' ? 'task.release_confirmed' : 'task.release_claimed';
    return formalReleaseOperationResultSchema.parse({ ...base, status: row.state, message: translate(locale, message) });
  }
  if (row.attempt === 'observing' && row.live) {
    return formalReleaseOperationResultSchema.parse({ ...base, status: 'checking', message: translate(locale, 'task.release_rollout_claimed') });
  }

  const [event] = await tx.select({ type: taskEvents.type, detail: taskEvents.detail }).from(taskEvents)
    .where(and(eq(taskEvents.taskId, scope.taskId), sql`${taskEvents.detail}->>'operationId' = ${row.operationId}`))
    .orderBy(desc(taskEvents.sequence)).limit(1);
  const manual = row.attempt === 'manual_review' || row.attempt === 'rejected'
    || event?.type === 'task.release_registry_manual_review' || event?.type === 'task.release_komodo_manual_review';
  if (row.state === 'blocked' || manual) {
    const reason = taskEventReasonSchema.safeParse(row.failure ?? event?.detail.reason).data ?? null;
    const message = row.state === 'blocked' ? 'release.result.blocked' : 'release.result.manual_review';
    return formalReleaseOperationResultSchema.parse({ ...base, status: row.state === 'blocked' ? 'blocked' : 'manual_review',
      message: translate(locale, message), reason, reasonMessage: reason ? translate(locale, eventReasonMessages[reason]) : null,
    });
  }
  return formalReleaseOperationResultSchema.parse({ ...base, status: 'reconciling', message: translate(locale, 'release.operation.reconciling') });
}
