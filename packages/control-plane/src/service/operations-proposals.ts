import { randomUUID } from 'node:crypto';
import { freezeOperationsProposalSchema, idSchema, operationsProposalSchema, type OperationsProposal } from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { eq } from 'drizzle-orm';
import type { VerifiedIdentity } from '../auth/identity.js';
import type { OperationsEnrollmentScope } from '../config.js';
import type { Database } from '../persistence/database.js';
import { operationsProposals, tasks } from '../persistence/schema.js';
import { requireActor, requireProjectAccess, requireStoredActor, type Transaction } from './access.js';
import { DomainError, parseInput } from './errors.js';
import { readOperationsTaskRecord } from './operations-records.js';
import { freezeOperationsRequest } from './operations-requests.js';
import { readOperationsObservationTarget } from './operations-targets.js';
import { databaseNow } from './releases.js';

type Row = typeof operationsProposals.$inferSelect;

export function readOperationsProposal(row: Row) {
  const document = operationsProposalSchema.parse(row.document);
  if (document.diagnosis.runId !== row.diagnosisRunId || document.target.environmentId !== row.environmentId
      || document.proposedBy !== row.proposedBy || document.grantId !== row.grantId
      || Date.parse(document.validUntil) !== row.validUntil.getTime() || sha256(JSON.stringify(document)) !== row.fingerprint) {
    throw new Error('operations_proposal_integrity');
  }
  return document;
}

export async function readOperationsProposalBasis(tx: Transaction, task: typeof tasks.$inferSelect,
  diagnosisSha256: string, installation: OperationsEnrollmentScope) {
  const { run, request, observation, diagnosis } = await readOperationsTaskRecord(tx, task);
  if (!diagnosis || !observation) throw new DomainError('unsupported_state');
  if (diagnosis.sha256 !== diagnosisSha256) throw new DomainError('version_conflict');
  const { environmentId, enrollmentSha256 } = request.document;
  if (environmentId !== installation.environmentId || enrollmentSha256 !== installation.enrollmentSha256) {
    throw new DomainError('unavailable');
  }
  const { recommendation, previousReleaseOperationId } = diagnosis.receipt.result;
  const { state, observedAt } = observation.receipt.observation;
  if ((recommendation.code !== 'review_restart' && recommendation.code !== 'review_rollback')
      || (state !== 'exited' && state !== 'dead')) throw new DomainError('unsupported_state');

  const requester = await requireStoredActor(tx, task.requestedBy);
  const target = await readOperationsObservationTarget(tx, requester, request.document, { includePrevious: recommendation.code === 'review_rollback' });
  if (freezeOperationsRequest(target).sha256 !== request.sha256) throw new DomainError('version_conflict');
  let action: OperationsProposal['action'] = { kind: 'restart' };
  if (recommendation.code === 'review_rollback') {
    const release = diagnosis.facts.find(({ data }) => data.section === 'release')?.data;
    const priorFact = release?.section === 'release' ? release.result.previous : undefined;
    const previous = target.previous;
    if (!previous || !priorFact || previous.releaseOperationId !== previousReleaseOperationId
        || previous.releaseOperationId !== priorFact.operationId || previous.manifestDigest !== priorFact.manifestDigest
        || previous.verifiedAt !== priorFact.verifiedAt) throw new DomainError('version_conflict');
    action = { kind: 'rollback', restore: { operationId: previous.releaseOperationId, manifestDigest: previous.manifestDigest,
      configDigest: previous.configDigest, proofSha256: previous.proofSha256 } };
  }
  // The database timestamp anchors the window to the diagnosis, including across Worker clocks or request retries.
  const validUntil = new Date(diagnosis.recordedAt.getTime() + target.approvalTtlSeconds * 1_000);
  return { run, environmentId, validUntil, whiskers: target.whiskers, publishedVersion: target.version, document: {
    version: 1 as const, diagnosis: { taskId: task.id, runId: run.id, sha256: diagnosis.sha256, observedAt },
    target: request.document, targetProofSha256: target.proofSha256, action, validUntil: validUntil.toISOString(),
  } };
}

export class OperationsProposalService {
  constructor(private readonly database: Database, private readonly installation: OperationsEnrollmentScope) {}

  async freeze(identity: VerifiedIdentity, rawTaskId: unknown, raw: unknown) {
    const taskId = parseInput(idSchema, rawTaskId);
    const { diagnosisSha256 } = parseInput(freezeOperationsProposalSchema, raw);
    return this.database.db.transaction(async tx => {
      const actor = await requireActor(tx, identity);
      const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for('update');
      if (!task) throw new DomainError('not_found');
      const { grantId } = await requireProjectAccess(tx, actor, task.projectId, true);
      const { run, environmentId, validUntil, document: basis } = await readOperationsProposalBasis(tx, task, diagnosisSha256, this.installation);
      const now = await databaseNow(tx);
      if (identity.expiresAt * 1_000 <= now.getTime()) throw new DomainError('unauthenticated');
      if (validUntil <= now) throw new DomainError('unsupported_state');
      const [existing] = await tx.select().from(operationsProposals).where(eq(operationsProposals.diagnosisRunId, run.id));
      const document = operationsProposalSchema.parse({
        ...basis,
        proposedBy: existing?.proposedBy ?? actor.principalId, grantId: existing?.grantId ?? grantId,
      });
      const fingerprint = sha256(JSON.stringify(document));
      if (existing) {
        readOperationsProposal(existing);
        if (existing.fingerprint !== fingerprint) throw new DomainError('version_conflict');
        return { proposal: existing, replayed: true };
      }
      const [proposal] = await tx.insert(operationsProposals).values({ id: randomUUID(), diagnosisRunId: run.id, environmentId,
        proposedBy: actor.principalId, grantId, document, fingerprint, createdAt: now, validUntil }).returning();
      if (!proposal) throw new DomainError('unavailable');
      return { proposal, replayed: false };
    });
  }
}
