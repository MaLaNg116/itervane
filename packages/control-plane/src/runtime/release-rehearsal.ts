import {
  fixtureReleaseObservationSchema, fixtureReleaseOperationSchema, fixtureReleaseWakeupSchema, idSchema, translate,
  type FixtureReleaseManifest, type FixtureReleaseObservation, type Locale, type ReleaseOperationState,
} from '@itervane/contracts';
import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../persistence/database.js';
import { environments, releaseCandidates, releaseOperations } from '../persistence/schema.js';
import type { Transaction } from '../service/access.js';
import { DomainError, parseInput } from '../service/errors.js';
import { databaseNow, parseFrozenRelease, type ReleaseCandidateService } from '../service/releases.js';

type OperationRow = typeof releaseOperations.$inferSelect;
type ObservationScope = Pick<FixtureReleaseObservation,
  'operationId' | 'fingerprint' | 'environmentId' | 'mappingSha256' | 'imageDigest' | 'runtimeConfigSha256'>;
export interface FixtureReleaseObservationReader {
  // Read-only evidence for an existing reservation. No dispatch or retries here.
  readCurrent(tx: Transaction, scope: Readonly<ObservationScope>): Promise<unknown>;
}

function present(row: OperationRow, locale: Locale) {
  return fixtureReleaseOperationSchema.parse({
    id: row.id, candidateId: row.candidateId, environmentId: row.environmentId, state: row.state,
    origin: 'trusted_fixture', releaseEligible: false, observation: row.observation,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    locale, message: translate(locale, `release.operation.${row.state}`),
  });
}

async function readOperation(tx: Transaction, id: string, lock = false) {
  const query = tx.select().from(releaseOperations).where(eq(releaseOperations.id, id));
  const [row] = await (lock ? query.for('update') : query);
  if (!row) throw new DomainError('not_found');
  return row;
}

async function readCandidate(tx: Transaction, operation: OperationRow) {
  const [candidate] = await tx.select().from(releaseCandidates).where(eq(releaseCandidates.id, operation.candidateId));
  if (!candidate || candidate.environmentId !== operation.environmentId) throw new DomainError('unavailable');
  return candidate;
}

function observationScope(operation: OperationRow, manifest: FixtureReleaseManifest, fingerprint: string): ObservationScope {
  return {
    operationId: operation.id, fingerprint, environmentId: operation.environmentId,
    mappingSha256: manifest.target.mappingSha256, imageDigest: manifest.imageDigest, runtimeConfigSha256: manifest.runtimeConfigSha256,
  };
}

async function updateState(tx: Transaction, id: string, state: ReleaseOperationState, now: Date, observation: FixtureReleaseObservation | null = null) {
  const [row] = await tx.update(releaseOperations).set({ state, updatedAt: now, observation }).where(eq(releaseOperations.id, id)).returning();
  if (!row) throw new DomainError('unavailable');
  return row;
}

// Called by trusted fixtures. Queue settlement and the live dispatcher belong to the future Worker integration.
export class ReleaseRehearsal {
  constructor(private readonly database: Database, private readonly candidates: ReleaseCandidateService,
    private readonly observations: FixtureReleaseObservationReader) {}

  async reserve(job: { id: unknown; data: unknown }, locale: Locale = 'en') {
    const id = parseInput(idSchema, job.id);
    const payload = parseInput(fixtureReleaseWakeupSchema, job.data);
    if (id !== payload.operationId) throw new DomainError('invalid_input');
    return this.database.db.transaction(async tx => {
      const initial = await readOperation(tx, id);
      if (initial.state !== 'queued') return { outcome: 'not_queued' as const, operation: present(initial, locale) };
      const candidate = await readCandidate(tx, initial);
      const approval = await this.candidates.lockFixtureApproval(tx, candidate, initial.approvalVersion);
      // The scope and approval locks precede the environment lock, just as in candidate freezing.
      const [environment] = await tx.select({ id: environments.id }).from(environments)
        .where(eq(environments.id, initial.environmentId)).for('update');
      if (!environment) throw new DomainError('unavailable');
      const operation = await readOperation(tx, id, true);
      if (operation.state !== 'queued') return { outcome: 'not_queued' as const, operation: present(operation, locale) };

      const [held] = await tx.select({ id: releaseOperations.id }).from(releaseOperations)
        .where(and(eq(releaseOperations.environmentId, environment.id), inArray(releaseOperations.state, ['dispatching', 'reconciling']))).limit(1);
      const now = await databaseNow(tx);
      if (!approval || Date.parse(approval.validUntil) <= now.getTime()) {
        const blocked = await updateState(tx, id, 'blocked', now);
        return { outcome: 'approval_invalid' as const, operation: present(blocked, locale) };
      }
      if (held) return { outcome: 'environment_busy' as const, operation: present(operation, locale) };
      const reserved = await updateState(tx, id, 'dispatching', now);
      return { outcome: 'reserved' as const, operation: present(reserved, locale), scope: observationScope(reserved, approval, candidate.fingerprint) };
    });
  }

  async reconcile(rawId: unknown, locale: Locale = 'en') {
    const id = parseInput(idSchema, rawId);
    return this.database.db.transaction(async tx => {
      const operation = await readOperation(tx, id, true);
      if (operation.state !== 'dispatching' && operation.state !== 'reconciling') return present(operation, locale);
      const candidate = await readCandidate(tx, operation);
      const scope = observationScope(operation, parseFrozenRelease(candidate), candidate.fingerprint);
      const result = fixtureReleaseObservationSchema.safeParse(await this.observations.readCurrent(tx, { ...scope }));
      const observed = result.success ? result.data : undefined;
      if (observed?.healthy && observed.accessProtected && observed.operationId === scope.operationId
        && observed.fingerprint === scope.fingerprint && observed.environmentId === scope.environmentId
        && observed.mappingSha256 === scope.mappingSha256 && observed.imageDigest === scope.imageDigest
        && observed.runtimeConfigSha256 === scope.runtimeConfigSha256) {
        return present(await updateState(tx, id, 'verified_fixture', await databaseNow(tx), observed), locale);
      }
      if (operation.state === 'reconciling') return present(operation, locale);
      return present(await updateState(tx, id, 'reconciling', await databaseNow(tx)), locale);
    });
  }
}
