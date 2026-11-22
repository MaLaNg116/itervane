import { releaseKomodoCompletionSchema, releaseRegistryHost, releaseRolloutProofSchema, taskDtoSchema } from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { environments, formalReleaseRolloutAttempts, formalReleaseSteps, formalReleaseTargets,
  releaseCandidates, releaseOperations, tasks } from '../persistence/schema.js';
import { requireProjectAccess, type Actor, type Transaction } from './access.js';
import { DomainError } from './errors.js';
import { readReleaseManifest } from './formal-release.js';
import { readReleaseTarget } from './release-targets.js';

type Mapping = typeof formalReleaseTargets.$inferSelect;
type VerifiedDeployment = {
  operation: typeof releaseOperations.$inferSelect;
  candidate: typeof releaseCandidates.$inferSelect;
  sourceTask: typeof tasks.$inferSelect;
  receipt: typeof formalReleaseRolloutAttempts.$inferSelect | null;
  dispatch: typeof formalReleaseSteps.$inferSelect | null;
};

function installedTarget(mapping: Mapping) {
  const target = readReleaseTarget(mapping);
  const { komodo, registryOrigin, rolloutCheck } = target;
  if (!komodo || !registryOrigin || !rolloutCheck) throw new DomainError('unsupported_state');
  return { ...target, komodo, registryOrigin, rolloutCheck };
}

function checkedRelease({ operation, candidate, sourceTask, receipt, dispatch }: VerifiedDeployment,
  mapping: Mapping, target: ReturnType<typeof installedTarget>) {
  const manifest = readReleaseManifest(candidate);
  if (manifest.target.revision !== mapping.revision || manifest.target.mappingSha256 !== mapping.sha256) return null;
  const verified = releaseRolloutProofSchema.safeParse(receipt?.proof);
  const dispatched = releaseKomodoCompletionSchema.safeParse(dispatch?.proof);
  if (!verified.success || !receipt?.completedAt || !dispatched.success
      || sourceTask.repositoryId !== manifest.source.repositoryId || sourceTask.commit !== manifest.source.commit
      || receipt.completedAt.getTime() !== operation.updatedAt.getTime()) {
    throw new Error('operations_deployment_evidence_integrity');
  }
  const proof = verified.data;
  const { runtime, update } = proof;
  const reference = `${releaseRegistryHost(target.registryOrigin)}/${target.imageRepository}@${manifest.image.manifestDigest}`;
  if (proof.operationId !== operation.id || proof.candidateId !== candidate.id || proof.fingerprint !== candidate.fingerprint
      || proof.rolloutFence !== receipt.fence || proof.decisionVersion !== operation.approvalVersion
      || proof.targetRevision !== mapping.revision || proof.mappingSha256 !== mapping.sha256 || proof.generation !== manifest.generation
      || proof.manifestDigest !== manifest.image.manifestDigest || runtime.configDigest !== manifest.image.configDigest
      || runtime.imageReference !== reference || runtime.runtimeConfigSha256 !== target.runtimeConfigSha256
      || runtime.rolloutCheckSha256 !== target.rolloutCheckSha256 || runtime.network !== target.rolloutCheck.network
      || update.updateId !== dispatch?.externalUpdateId || update.updateId !== dispatched.data.updateId || !dispatched.data.success
      || update.deploymentId !== target.deploymentId || update.deploymentId !== dispatched.data.deploymentId
      || update.actorId !== target.komodo.actorId || update.actorId !== dispatched.data.actorId) {
    throw new Error('operations_deployment_evidence_integrity');
  }
  return { releaseOperationId: operation.id, releaseTaskId: candidate.taskId, source: manifest.source,
    dataClass: taskDtoSchema.shape.dataClass.parse(sourceTask.dataClass),
    containerId: runtime.containerId, manifestDigest: proof.manifestDigest, configDigest: runtime.configDigest,
    version: runtime.version, updateId: update.updateId, verifiedAt: receipt.completedAt.toISOString(),
    proofSha256: sha256(JSON.stringify({ proof, dispatch: dispatched.data })) };
}

export async function readOperationsDeployment(tx: Transaction, actor: Actor, scope: { projectId: string; environmentId: string },
  options: { includePrevious?: boolean } = {}) {
  const { projectId, environmentId } = scope;
  const { grantId } = await requireProjectAccess(tx, actor, projectId, true);
  const [environment] = await tx.select().from(environments).where(and(eq(environments.id, environmentId),
    eq(environments.projectId, projectId), eq(environments.access, 'protected'))).for('share');
  if (!environment) throw new DomainError('not_found');

  const [mapping] = await tx.select().from(formalReleaseTargets).where(and(eq(formalReleaseTargets.environmentId, environment.id),
    eq(formalReleaseTargets.projectId, projectId), eq(formalReleaseTargets.applicationId, environment.applicationId))).for('share');
  if (!mapping) throw new DomainError('unsupported_state');
  const target = installedTarget(mapping);

  const [pending] = await tx.select({ id: releaseOperations.id }).from(releaseOperations).where(
    and(eq(releaseOperations.environmentId, environment.id), inArray(releaseOperations.state, ['queued', 'dispatching', 'reconciling'])),
  ).limit(1);
  if (pending) throw new DomainError('conflict');

  // Pick the latest settled formal release before validating its receipt. Broken evidence cannot fall back to an older version.
  const [latest, earlier] = await tx.select({ operation: releaseOperations, candidate: releaseCandidates, sourceTask: tasks,
    receipt: formalReleaseRolloutAttempts, dispatch: formalReleaseSteps })
    .from(releaseOperations).innerJoin(releaseCandidates, and(eq(releaseCandidates.id, releaseOperations.candidateId),
      eq(releaseCandidates.environmentId, environment.id), eq(releaseCandidates.projectId, projectId),
      eq(releaseCandidates.applicationId, environment.applicationId)))
    .innerJoin(tasks, and(eq(tasks.id, releaseCandidates.taskId), eq(tasks.projectId, projectId)))
    .leftJoin(formalReleaseRolloutAttempts, and(eq(formalReleaseRolloutAttempts.operationId, releaseOperations.id),
      eq(formalReleaseRolloutAttempts.state, 'verified')))
    .leftJoin(formalReleaseSteps, and(eq(formalReleaseSteps.operationId, releaseOperations.id),
      eq(formalReleaseSteps.kind, 'komodo_dispatch'), eq(formalReleaseSteps.state, 'confirmed')))
    .where(and(eq(releaseOperations.environmentId, environment.id), eq(releaseOperations.state, 'verified_formal')))
    .orderBy(desc(releaseOperations.updatedAt), desc(releaseOperations.id)).limit(options.includePrevious ? 2 : 1);
  if (!latest) throw new DomainError('unsupported_state');
  const current = checkedRelease(latest, mapping, target);
  if (!current) throw new DomainError('unsupported_state');
  const previous = earlier ? checkedRelease(earlier, mapping, target) : null;
  if (earlier?.operation.id === current.releaseOperationId) throw new Error('operations_deployment_evidence_integrity');
  return { projectId, environmentId, applicationId: environment.applicationId, grantId,
    targetRevision: mapping.revision, mappingSha256: mapping.sha256, deploymentId: target.deploymentId, ...current, previous };
}
