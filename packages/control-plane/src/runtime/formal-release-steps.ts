import { qualifiedOciArchiveVerificationSchema, releaseRegistryImageProofSchema, type FormalReleaseManifest,
  type FormalReleaseTarget, type ReleaseRegistryImageProof } from '@itervane/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { formalReleaseSteps, releaseOperations, runRuntime } from '../persistence/schema.js';
import { DomainError, parseInput } from '../service/errors.js';
import { appendEvent } from './authority.js';
import type { FormalReleaseCoordinator, FormalReleaseScope } from './formal-release-claim.js';

function archiveStep(scope: FormalReleaseScope) {
  return and(eq(formalReleaseSteps.operationId, scope.operationId), eq(formalReleaseSteps.kind, 'archive'),
    eq(formalReleaseSteps.preparedFence, scope.fence));
}

function registryStep(scope: FormalReleaseScope) {
  return and(eq(formalReleaseSteps.operationId, scope.operationId), eq(formalReleaseSteps.kind, 'registry'));
}

function stepEvent(scope: FormalReleaseScope) {
  const { workerId, operationId, candidateId, fingerprint, decisionVersion, fence } = scope;
  return { workerId, releaseDecision: { operationId, candidateId, fingerprint, decisionVersion, fence } };
}

function requireMatchingImage(raw: unknown, mapping: FormalReleaseTarget, image: FormalReleaseManifest['image']) {
  const received = parseInput(releaseRegistryImageProofSchema, raw);
  if (received.registryOrigin !== mapping.registryOrigin || received.repository !== mapping.imageRepository
      || received.manifestDigest !== image.manifestDigest || received.configDigest !== image.configDigest
      || JSON.stringify(received.archive) !== JSON.stringify(image.archive)) throw new DomainError('conflict');
  return received;
}

export class FormalReleaseSteps {
  constructor(private readonly release: FormalReleaseCoordinator) {}

  async prepareArchive(scope: FormalReleaseScope) {
    return this.release.withAuthorizedRelease(scope, async (tx, task, phase, authority) => {
      if (phase !== 'release_claimed') throw new DomainError('unsupported_state');
      const [inserted] = await tx.insert(formalReleaseSteps).values({ operationId: scope.operationId, kind: 'archive',
        preparedFence: scope.fence, preparedBy: scope.workerId, createdAt: sql`clock_timestamp()` }).onConflictDoNothing().returning();
      if (inserted) await appendEvent(tx, task, 'task.release_archive_prepared', 'running', stepEvent(scope));
      return authority.archiveVerification;
    });
  }

  async confirmArchive(scope: FormalReleaseScope, raw: unknown) {
    const proof = parseInput(qualifiedOciArchiveVerificationSchema, raw);
    await this.release.withAuthorizedRelease(scope, async (tx, task, phase, authority) => {
      if (phase !== 'release_claimed') throw new DomainError('unsupported_state');
      if (JSON.stringify(proof) !== JSON.stringify(authority.archiveVerification)) throw new DomainError('conflict');
      const [step] = await tx.select().from(formalReleaseSteps).where(archiveStep(scope)).for('update');
      if (!step) throw new DomainError('unsupported_state');
      if (step.state === 'confirmed') return;
      await tx.update(formalReleaseSteps).set({
        state: 'confirmed', proof, settledFence: scope.fence, settledBy: scope.workerId, settledAt: sql`clock_timestamp()`,
      }).where(archiveStep(scope));
      await appendEvent(tx, task, 'task.release_archive_confirmed', 'running', stepEvent(scope));
    });
  }

  async prepareRegistry(scope: FormalReleaseScope) {
    return this.release.withAuthorizedRelease(scope, async (tx, task, phase, authority) => {
      if (phase !== 'release_claimed') throw new DomainError('unsupported_state');
      const [archive] = await tx.select().from(formalReleaseSteps).where(archiveStep(scope));
      if (archive?.state !== 'confirmed') throw new DomainError('unsupported_state');
      const [intent] = await tx.insert(formalReleaseSteps).values({ operationId: scope.operationId, kind: 'registry',
        preparedFence: scope.fence, preparedBy: scope.workerId, createdAt: sql`clock_timestamp()` }).onConflictDoNothing().returning();
      if (!intent) throw new DomainError('conflict');
      await tx.update(runRuntime).set({ reason: 'release_registry_prepared' }).where(eq(runRuntime.runId, scope.runId));
      await appendEvent(tx, task, 'task.release_registry_prepared', 'running', stepEvent(scope));
      return authority;
    });
  }

  async confirmRegistry(scope: FormalReleaseScope, raw: unknown): Promise<ReleaseRegistryImageProof> {
    return this.release.withRegistryObservation(scope, async (tx, task, { phase, mapping, manifest, intent }) => {
      const proof = requireMatchingImage(raw, mapping, manifest.image);
      if (phase === 'release_registry_verified' && intent.state === 'confirmed') {
        return requireMatchingImage(intent.proof, mapping, manifest.image);
      }
      if (phase === 'release_registry_verified') throw new DomainError('unsupported_state');
      if (intent.state === 'confirmed') requireMatchingImage(intent.proof, mapping, manifest.image);
      else {
        await tx.update(formalReleaseSteps).set({
          state: 'confirmed', proof, settledFence: scope.fence, settledBy: scope.workerId, settledAt: sql`clock_timestamp()`,
        }).where(registryStep(scope));
      }
      await tx.update(runRuntime).set({ reason: 'release_registry_verified' }).where(eq(runRuntime.runId, scope.runId));
      if (phase === 'release_registry_reconciling') {
        await tx.update(releaseOperations).set({ state: 'dispatching', updatedAt: sql`clock_timestamp()` })
          .where(eq(releaseOperations.id, scope.operationId));
      }
      await appendEvent(tx, task, 'task.release_registry_confirmed', task.state, stepEvent(scope));
      return proof;
    });
  }

  async readRegistryProof(scope: FormalReleaseScope) {
    return this.release.withRegistryObservation(scope, async (_tx, _task, { phase, intent, mapping, manifest }) =>
      phase === 'release_registry_verified' && intent.state === 'confirmed'
        ? requireMatchingImage(intent.proof, mapping, manifest.image)
        : null);
  }
}
