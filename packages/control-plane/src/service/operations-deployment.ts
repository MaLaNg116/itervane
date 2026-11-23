import { operationsRestorePlanSchema, operationsRestoreRecoveryProofSchema, releaseKomodoCompletionSchema, releaseKomodoUpdateSchema,
  releaseRegistryHost, releaseRolloutProofSchema, taskDtoSchema } from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { and, desc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import { environments, formalReleaseRolloutAttempts, formalReleaseSteps, formalReleaseTargets, operationsExecutionIntents,
  operationsRestoreRecoveries, operationsRestoreSteps, releaseCandidates, releaseOperations, tasks } from '../persistence/schema.js';
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

async function readRestoredDeployment(tx: Transaction, archived: NonNullable<ReturnType<typeof checkedRelease>>,
  restoreExecutionId: string, mapping: Mapping, target: ReturnType<typeof installedTarget>) {
  const [restoration] = await tx.select({ receipt: operationsRestoreRecoveries, intent: operationsExecutionIntents, step: operationsRestoreSteps })
    .from(operationsRestoreRecoveries).innerJoin(operationsExecutionIntents,
      eq(operationsExecutionIntents.executionId, operationsRestoreRecoveries.executionId))
    .innerJoin(operationsRestoreSteps, and(eq(operationsRestoreSteps.executionId, operationsRestoreRecoveries.executionId),
      eq(operationsRestoreSteps.kind, 'deploy')))
    .where(and(eq(operationsRestoreRecoveries.executionId, restoreExecutionId), eq(operationsRestoreRecoveries.state, 'verified')));
  if (!restoration) throw new Error('operations_restore_publication_integrity');
  const { receipt, intent, step } = restoration;
  if (!receipt.completedAt) throw new Error('operations_restore_publication_integrity');
  const proof = operationsRestoreRecoveryProofSchema.parse(receipt.proof);
  const plan = operationsRestorePlanSchema.parse(intent.restorePlan);
  const sent = releaseKomodoUpdateSchema.parse(step.receipt);
  const { update, runtime } = proof;
  const reference = `${releaseRegistryHost(target.registryOrigin)}/${target.imageRepository}@${archived.manifestDigest}`;
  if (proof.executionId !== restoreExecutionId || proof.restoreOperationId !== archived.releaseOperationId
      || proof.attempt !== receipt.attempt || proof.fence !== receipt.fence || step.fence >= proof.fence
      || sha256(JSON.stringify(proof)) !== receipt.proofSha256 || sha256(JSON.stringify(plan)) !== proof.planSha256
      || proof.planSha256 !== intent.restorePlanSha256 || proof.planSha256 !== step.planSha256
      || plan.environmentId !== mapping.environmentId || plan.targetRevision !== mapping.revision || plan.mappingSha256 !== mapping.sha256
      || plan.restore.operationId !== archived.releaseOperationId || plan.restore.proofSha256 !== archived.proofSha256
      || plan.restore.manifestDigest !== archived.manifestDigest || plan.restore.configDigest !== archived.configDigest
      || plan.restore.publishedVersion !== archived.version || runtime.containerId === plan.current.containerId
      || runtime.configDigest !== archived.configDigest || runtime.imageReference !== reference || runtime.version !== archived.version
      || runtime.runtimeConfigSha256 !== target.runtimeConfigSha256 || runtime.rolloutCheckSha256 !== target.rolloutCheckSha256
      || runtime.network !== target.rolloutCheck.network || update.updateId !== sent.updateId
      || update.deploymentId !== target.deploymentId || update.deploymentId !== sent.deploymentId
      || update.actorId !== target.komodo.actorId || update.actorId !== sent.actorId) {
    throw new Error('operations_restore_publication_integrity');
  }
  return { ...archived, restoreExecutionId, containerId: runtime.containerId, updateId: update.updateId,
    verifiedAt: receipt.completedAt.toISOString(),
    proofSha256: sha256(JSON.stringify({ archivedProofSha256: archived.proofSha256, recoveryProofSha256: receipt.proofSha256 })) };
}

// Internal evidence lookup. Callers must authorize the project or bind a historical effect under its lease first.
export async function readPublishedOperationsDeployment(tx: Transaction, scope: { projectId: string; environmentId: string },
  options: { includePrevious?: boolean; ownReleaseOperationId?: string } = {}) {
  const { projectId, environmentId } = scope;
  const [environment] = await tx.select().from(environments).where(and(eq(environments.id, environmentId),
    eq(environments.projectId, projectId), eq(environments.access, 'protected'))).for('share');
  if (!environment) throw new DomainError('not_found');

  const [mapping] = await tx.select().from(formalReleaseTargets).where(and(eq(formalReleaseTargets.environmentId, environment.id),
    eq(formalReleaseTargets.projectId, projectId), eq(formalReleaseTargets.applicationId, environment.applicationId))).for('share');
  if (!mapping) throw new DomainError('unsupported_state');
  const target = installedTarget(mapping);

  const [pending] = await tx.select({ id: releaseOperations.id }).from(releaseOperations).where(
    and(eq(releaseOperations.environmentId, environment.id), inArray(releaseOperations.state, ['queued', 'dispatching', 'reconciling']),
      options.ownReleaseOperationId ? ne(releaseOperations.id, options.ownReleaseOperationId) : undefined),
  ).limit(1);
  if (pending) throw new DomainError('conflict');

  const { rows: [publication] } = await tx.execute<{ releaseOperationId: string | null; restoreExecutionId: string | null; fence: number | null }>(sql`
    SELECT release_operation_id AS "releaseOperationId", restore_execution_id AS "restoreExecutionId", fence
    FROM itervane.current_operations_publication(${environment.id}::uuid)
  `);
  if (!publication?.releaseOperationId || !publication.fence) throw new DomainError('unsupported_state');

  const findPublished = (filter: SQL | undefined) => tx.select({ operation: releaseOperations, candidate: releaseCandidates, sourceTask: tasks,
    receipt: formalReleaseRolloutAttempts, dispatch: formalReleaseSteps })
    .from(releaseOperations).innerJoin(releaseCandidates, and(eq(releaseCandidates.id, releaseOperations.candidateId),
      eq(releaseCandidates.environmentId, environment.id), eq(releaseCandidates.projectId, projectId),
      eq(releaseCandidates.applicationId, environment.applicationId)))
    .innerJoin(tasks, and(eq(tasks.id, releaseCandidates.taskId), eq(tasks.projectId, projectId)))
    .leftJoin(formalReleaseRolloutAttempts, and(eq(formalReleaseRolloutAttempts.operationId, releaseOperations.id),
      eq(formalReleaseRolloutAttempts.state, 'verified')))
    .leftJoin(formalReleaseSteps, and(eq(formalReleaseSteps.operationId, releaseOperations.id),
      eq(formalReleaseSteps.kind, 'komodo_dispatch'), eq(formalReleaseSteps.state, 'confirmed')))
    .where(and(eq(releaseOperations.environmentId, environment.id), eq(releaseOperations.state, 'verified_formal'), filter))
    .orderBy(desc(formalReleaseSteps.preparedFence), desc(releaseOperations.id)).limit(1);

  // Select the latest native dispatch before checking evidence, including when its mapping is no longer current.
  const [latest] = await findPublished(eq(releaseOperations.id, publication.releaseOperationId));
  if (!latest) throw new DomainError('unsupported_state');
  const archived = checkedRelease(latest, mapping, target);
  if (!archived) throw new DomainError('unsupported_state');
  const current = publication.restoreExecutionId ? await readRestoredDeployment(tx, archived, publication.restoreExecutionId, mapping, target) : archived;

  // An identical redeployment offers no recovery image. The candidate must have run under the current target revision.
  const [earlier] = options.includePrevious ? await findPublished(and(
    sql`${formalReleaseSteps.preparedFence} < ${publication.fence}`,
    sql`${releaseCandidates.document}#>>'{target,revision}' = ${String(mapping.revision)}`,
    sql`${releaseCandidates.document}#>>'{target,mappingSha256}' = ${mapping.sha256}`,
    sql`${releaseCandidates.document}#>>'{image,manifestDigest}' <> ${current.manifestDigest}`,
  )) : [];
  const previous = earlier ? checkedRelease(earlier, mapping, target) : null;
  return { projectId, environmentId, applicationId: environment.applicationId,
    targetRevision: mapping.revision, mappingSha256: mapping.sha256, deploymentId: target.deploymentId,
    approvalTtlSeconds: target.approvalTtlSeconds, releaseTarget: target, ...current, previous };
}

export async function readOperationsDeployment(tx: Transaction, actor: Actor, scope: { projectId: string; environmentId: string },
  options: { includePrevious?: boolean } = {}) {
  const { grantId } = await requireProjectAccess(tx, actor, scope.projectId, true);
  return { ...await readPublishedOperationsDeployment(tx, scope, options), grantId };
}
