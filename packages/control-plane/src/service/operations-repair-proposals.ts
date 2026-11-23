import { freezeOperationsRepairSchema, idSchema, operationsRepairProposalSchema, type OperationsRepairProposal,
  type QualifiedInspectionReceipt } from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { and, eq } from 'drizzle-orm';
import type { VerifiedIdentity } from '../auth/identity.js';
import type { Database } from '../persistence/database.js';
import { operationsIncidentDiagnoses, operationsRepairAdmissions, operationsRepairProposals, releaseCandidates, releaseOperations, repositories,
  tasks } from '../persistence/schema.js';
import { requireActor, requireProjectAccess, requireStoredActor, type Transaction } from './access.js';
import { DomainError, parseInput } from './errors.js';
import { readReleaseManifest } from './formal-release.js';
import { readHealthProbeTarget, type OperationsHealthInstallation } from './operations-health.js';
import { readOperationsTaskRecord } from './operations-records.js';
import { freezeOperationsRequest } from './operations-requests.js';
import { databaseNow } from './releases.js';
import { readPublishedVerification } from './verification-result.js';

type ProposalRow = typeof operationsRepairProposals.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;

export function readOperationsRepairProposal(row: ProposalRow) {
  const document = operationsRepairProposalSchema.parse(row.document);
  if (document.diagnosis.runId !== row.diagnosisRunId || document.target.environmentId !== row.environmentId
      || document.target.releaseOperationId !== row.releaseOperationId || document.source.candidateId !== row.candidateId
      || (document.incident?.id ?? null) !== row.incidentId || (document.incident?.sampleSequence ?? null) !== row.sampleSequence
      || document.proposedBy !== row.proposedBy || document.grantId !== row.grantId || Date.parse(document.validUntil) !== row.validUntil.getTime()
      || sha256(JSON.stringify(document)) !== row.fingerprint) throw new Error('operations_repair_proposal_integrity');
  return document;
}

export async function readLinkedOperationsRepair(tx: Transaction, task: TaskRow) {
  const [entry] = await tx.select({ admission: operationsRepairAdmissions, proposal: operationsRepairProposals })
    .from(operationsRepairAdmissions).innerJoin(operationsRepairProposals, eq(operationsRepairProposals.id, operationsRepairAdmissions.proposalId))
    .where(eq(operationsRepairAdmissions.taskId, task.id));
  if (!entry) return undefined;
  const { admission, proposal } = entry;
  const frozen = readOperationsRepairProposal(proposal);
  const requestSha256 = sha256(JSON.stringify({ proposalId: proposal.id, fingerprint: proposal.fingerprint, sourceCommit: task.commit, locale: task.locale }));
  if (frozen.target.projectId !== task.projectId || frozen.source.git.repositoryId !== task.repositoryId || frozen.source.dataClass !== task.dataClass
      || admission.sourceCommit !== task.commit || admission.actorId !== task.requestedBy || admission.requestSha256 !== requestSha256
      || task.requestHash !== requestSha256) throw new DomainError('version_conflict');
  return { admission, frozen };
}

export function matchesLinkedRepairSource({ source }: OperationsRepairProposal, receipt: QualifiedInspectionReceipt) {
  if (receipt.originSha256 !== source.originSha256 || receipt.scope.repositoryId !== source.git.repositoryId) return false;
  const { materializedFrom } = receipt.scope;
  if (source.patchSha256 === null) return !materializedFrom && receipt.scope.commit === source.git.commit
    && receipt.snapshot.manifestSha256 === source.originalSnapshotSha256;
  return materializedFrom?.commit === source.git.commit && materializedFrom.baseSnapshotSha256 === source.originalSnapshotSha256
    && receipt.snapshot.materializedCandidateSha256 === source.deployedSnapshotSha256;
}

export async function requireLinkedRepairReleaseTarget(tx: Transaction, task: TaskRow, environmentId: string, grantId: string) {
  const linked = await readLinkedOperationsRepair(tx, task);
  if (!linked) return;
  if (linked.admission.grantId !== grantId) throw new DomainError('forbidden');
  const { target } = linked.frozen;
  if (target.environmentId !== environmentId) throw new DomainError('version_conflict');
  const { binding } = await readHealthProbeTarget(tx, target);
  if (sha256(JSON.stringify(binding)) !== sha256(JSON.stringify(target))) throw new DomainError('version_conflict');
}

async function readRepairSource(tx: Transaction, scope: {
  releaseOperationId: string; releaseTaskId: string; projectId: string; environmentId: string;
}) {
  const [entry] = await tx.select({ candidate: releaseCandidates, sourceTask: tasks }).from(releaseOperations)
    .innerJoin(releaseCandidates, eq(releaseCandidates.id, releaseOperations.candidateId))
    .innerJoin(tasks, eq(tasks.id, releaseCandidates.taskId)).where(and(eq(releaseOperations.id, scope.releaseOperationId),
      eq(releaseOperations.state, 'verified_formal'), eq(releaseCandidates.environmentId, scope.environmentId),
      eq(tasks.id, scope.releaseTaskId), eq(tasks.projectId, scope.projectId)));
  if (!entry) throw new DomainError('unsupported_state');
  const { candidate, sourceTask } = entry;
  const manifest = readReleaseManifest(candidate);
  const verification = await readPublishedVerification(tx, sourceTask, { runId: manifest.runId, generation: manifest.generation });
  if (!verification || verification.row.inputSha256 !== manifest.verification.inputSha256 || verification.row.sha256 !== manifest.verification.resultSha256
      || verification.row.receiptSha256 !== manifest.verification.receiptSha256 || verification.input.inspection.snapshotSha256 !== manifest.originalSnapshotSha256
      || verification.input.subject.manifestSha256 !== manifest.repairedSnapshotSha256 || verification.input.dataClass !== sourceTask.dataClass
      || (verification.input.subject.kind === 'repair' ? verification.input.subject.patchSha256 : null) !== manifest.diffSha256) {
    throw new Error('operations_repair_source_integrity');
  }
  const [repository] = await tx.select({ url: repositories.url }).from(repositories).where(and(
    eq(repositories.id, manifest.source.repositoryId), eq(repositories.projectId, scope.projectId),
  )).for('share');
  if (!repository || sha256(repository.url) !== verification.originSha256) throw new DomainError('version_conflict');

  return { candidateId: candidate.id, candidateSha256: candidate.fingerprint, releaseTaskId: sourceTask.id,
    git: manifest.source, dataClass: verification.input.dataClass, originSha256: verification.originSha256,
    originalSnapshotSha256: manifest.originalSnapshotSha256, deployedSnapshotSha256: manifest.repairedSnapshotSha256, patchSha256: manifest.diffSha256 };
}

export async function readOperationsRepairBasis(tx: Transaction, task: TaskRow, diagnosisSha256: string, installation: OperationsHealthInstallation) {
  const { run, request, diagnosis } = await readOperationsTaskRecord(tx, task);
  if (!diagnosis || diagnosis.receipt.result.recommendation.code !== 'investigate_code') throw new DomainError('unsupported_state');
  if (diagnosis.sha256 !== diagnosisSha256) throw new DomainError('version_conflict');
  const { environmentId, enrollmentSha256, mappingSha256 } = request.document;
  if (environmentId !== installation.environmentId || enrollmentSha256 !== installation.enrollmentSha256 || mappingSha256 !== installation.mappingSha256) {
    throw new DomainError('unavailable');
  }
  const requester = await requireStoredActor(tx, task.requestedBy);
  const { grantId } = await requireProjectAccess(tx, requester, task.projectId, true);
  const { binding, publication } = await readHealthProbeTarget(tx, installation);
  if (freezeOperationsRequest({ ...publication, grantId, enrollmentRevision: binding.enrollmentRevision, enrollmentSha256 }).sha256 !== request.sha256) {
    throw new DomainError('version_conflict');
  }
  const [trigger] = await tx.select().from(operationsIncidentDiagnoses).where(eq(operationsIncidentDiagnoses.runId, run.id));
  if (trigger && (trigger.taskId !== task.id || trigger.environmentId !== environmentId || trigger.bindingSha256 !== sha256(JSON.stringify(binding)))) {
    throw new DomainError('version_conflict');
  }
  const source = await readRepairSource(tx, publication);
  const validUntil = new Date(diagnosis.recordedAt.getTime() + publication.approvalTtlSeconds * 1_000);
  return { run, validUntil, diagnosedAt: diagnosis.recordedAt, document: {
    version: 1 as const, diagnosis: { taskId: task.id, runId: run.id, sha256: diagnosis.sha256 }, target: binding,
    incident: trigger ? { id: trigger.incidentId, sampleSequence: trigger.sampleSequence } : null, source, validUntil: validUntil.toISOString(),
  } };
}

export class OperationsRepairProposalService {
  constructor(private readonly database: Database, private readonly installation: OperationsHealthInstallation) {}

  async freeze(identity: VerifiedIdentity, rawTaskId: unknown, raw: unknown) {
    const taskId = parseInput(idSchema, rawTaskId);
    const { diagnosisSha256 } = parseInput(freezeOperationsRepairSchema, raw);
    return this.database.db.transaction(async tx => {
      const actor = await requireActor(tx, identity);
      const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for('update');
      if (!task) throw new DomainError('not_found');
      const { grantId } = await requireProjectAccess(tx, actor, task.projectId, true);
      const basis = await readOperationsRepairBasis(tx, task, diagnosisSha256, this.installation);
      const now = await databaseNow(tx, basis.diagnosedAt);
      if (identity.expiresAt * 1_000 <= now.getTime()) throw new DomainError('unauthenticated');
      if (basis.validUntil <= now) throw new DomainError('unsupported_state');
      const [existing] = await tx.select().from(operationsRepairProposals).where(eq(operationsRepairProposals.diagnosisRunId, basis.run.id));
      const document = operationsRepairProposalSchema.parse({ ...basis.document,
        proposedBy: existing?.proposedBy ?? actor.principalId, grantId: existing?.grantId ?? grantId });
      const fingerprint = sha256(JSON.stringify(document));
      if (existing) {
        readOperationsRepairProposal(existing);
        const proposer = await requireStoredActor(tx, existing.proposedBy);
        if ((await requireProjectAccess(tx, proposer, task.projectId, true)).grantId !== existing.grantId) throw new DomainError('forbidden');
        if (existing.fingerprint !== fingerprint) throw new DomainError('version_conflict');
        return { proposal: existing, replayed: true };
      }
      const [proposal] = await tx.insert(operationsRepairProposals).values({ diagnosisRunId: basis.run.id, environmentId: document.target.environmentId,
        releaseOperationId: document.target.releaseOperationId, candidateId: document.source.candidateId,
        incidentId: document.incident?.id ?? null, sampleSequence: document.incident?.sampleSequence ?? null,
        proposedBy: actor.principalId, grantId, fingerprint, document, createdAt: now, validUntil: basis.validUntil }).returning();
      if (!proposal) throw new DomainError('unavailable');
      return { proposal, replayed: false };
    });
  }
}
