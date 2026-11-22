import { operationsTargetInputSchema } from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../persistence/database.js';
import { environments, formalReleaseTargets, operationsTargets } from '../persistence/schema.js';
import type { Actor, Transaction } from './access.js';
import { DomainError, parseInput } from './errors.js';
import { readOperationsDeployment } from './operations-deployment.js';
import { readReleaseTarget } from './release-targets.js';

function readEnrollment(row: typeof operationsTargets.$inferSelect) {
  const parsed = operationsTargetInputSchema.safeParse(row.document);
  if (!parsed.success || parsed.data.environmentId !== row.environmentId || sha256(JSON.stringify(parsed.data)) !== row.sha256) {
    throw new Error('operations_target_integrity');
  }
  return parsed.data;
}

export async function registerOperationsTarget(database: Database, raw: unknown) {
  const document = parseInput(operationsTargetInputSchema, raw);
  const { environmentId, releaseTargetRevision, releaseTargetSha256 } = document;
  const fingerprint = sha256(JSON.stringify(document));
  return database.db.transaction(async tx => {
    const [environment] = await tx.select().from(environments).where(and(eq(environments.id, environmentId),
      eq(environments.access, 'protected'))).for('update');
    if (!environment) throw new DomainError('not_found');
    const [binding] = await tx.select().from(formalReleaseTargets).where(and(eq(formalReleaseTargets.environmentId, environmentId),
      eq(formalReleaseTargets.projectId, environment.projectId), eq(formalReleaseTargets.applicationId, environment.applicationId))).for('share');
    if (!binding || binding.revision !== releaseTargetRevision || binding.sha256 !== releaseTargetSha256) {
      throw new DomainError('version_conflict');
    }
    const release = readReleaseTarget(binding);
    if (!release.komodo || !release.registryOrigin || !release.rolloutCheck) throw new DomainError('unsupported_state');

    const [current] = await tx.select().from(operationsTargets).where(eq(operationsTargets.environmentId, environmentId));
    if (current) {
      readEnrollment(current);
      if (current.sha256 === fingerprint) return { environmentId, revision: current.revision, fingerprint };
      const revision = current.revision + 1;
      await tx.update(operationsTargets).set({ revision, sha256: fingerprint, document }).where(eq(operationsTargets.environmentId, environmentId));
      return { environmentId, revision, fingerprint };
    }
    await tx.insert(operationsTargets).values({ environmentId, projectId: environment.projectId, applicationId: environment.applicationId,
      revision: 1, sha256: fingerprint, document });
    return { environmentId, revision: 1, fingerprint };
  });
}

export async function readOperationsObservationTarget(tx: Transaction, actor: Actor, scope: { projectId: string; environmentId: string }) {
  const deployment = await readOperationsDeployment(tx, actor, scope);
  const [binding] = await tx.select().from(operationsTargets).where(and(eq(operationsTargets.environmentId, scope.environmentId),
    eq(operationsTargets.projectId, scope.projectId), eq(operationsTargets.applicationId, deployment.applicationId))).for('share');
  if (!binding) throw new DomainError('unsupported_state');
  const enrolled = readEnrollment(binding);
  if (enrolled.releaseTargetRevision !== deployment.targetRevision || enrolled.releaseTargetSha256 !== deployment.mappingSha256) {
    throw new DomainError('version_conflict');
  }
  return { ...deployment, whiskers: enrolled.whiskers, enrollmentRevision: binding.revision, enrollmentSha256: binding.sha256 };
}
