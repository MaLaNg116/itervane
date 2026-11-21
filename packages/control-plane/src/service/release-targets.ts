import { formalReleaseTargetSchema } from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../persistence/database.js';
import { environments, formalReleaseTargets, releaseOperations } from '../persistence/schema.js';
import { DomainError, parseInput } from './errors.js';

export function readReleaseTarget(row: typeof formalReleaseTargets.$inferSelect) {
  const document = formalReleaseTargetSchema.parse(row.document);
  if (document.environmentId !== row.environmentId || document.deploymentId !== row.deploymentId
      || sha256(JSON.stringify(document)) !== row.sha256) throw new Error('formal_release_target_integrity');
  return document;
}

export async function registerReleaseTarget(database: Database, rawTarget: unknown) {
  const document = parseInput(formalReleaseTargetSchema, rawTarget);
  const { environmentId, deploymentId } = document;
  const fingerprint = sha256(JSON.stringify(document));
  return database.db.transaction(async tx => {
    const [environment] = await tx.select().from(environments).where(eq(environments.id, environmentId)).for('update');
    if (!environment || environment.access !== 'protected') throw new DomainError('not_found');
    const [current] = await tx.select().from(formalReleaseTargets).where(eq(formalReleaseTargets.environmentId, environmentId));
    if (current) {
      readReleaseTarget(current);
      if (current.sha256 === fingerprint) return { environmentId, revision: current.revision, fingerprint };
      const [inFlight] = await tx.select({ id: releaseOperations.id }).from(releaseOperations).where(and(
        eq(releaseOperations.environmentId, environmentId), inArray(releaseOperations.state, ['dispatching', 'reconciling']),
      )).limit(1);
      if (inFlight) throw new DomainError('conflict');
      const revision = current.revision + 1;
      await tx.update(formalReleaseTargets).set({ revision, sha256: fingerprint, document, deploymentId })
        .where(eq(formalReleaseTargets.environmentId, environmentId));
      return { environmentId, revision, fingerprint };
    }
    await tx.insert(formalReleaseTargets).values({ environmentId, projectId: environment.projectId,
      applicationId: environment.applicationId, deploymentId, revision: 1, sha256: fingerprint, document });
    return { environmentId, revision: 1, fingerprint };
  });
}
