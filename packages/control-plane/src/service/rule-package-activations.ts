import { and, desc, eq, ne } from 'drizzle-orm';
import { rulePackageActivationInputSchema, rulePackageActivationResultSchema, rulePackageActivationSchema,
  rulePackageActivationViewSchema, translate, type Locale } from '@itervane/contracts';
import { digest } from '@itervane/rules';
import type { VerifiedIdentity } from '../auth/identity.js';
import type { Database } from '../persistence/database.js';
import { rulePackageActivations, rulePackageReviews, rulePackages } from '../persistence/schema.js';
import { isHumanWorkspaceOwner, type Transaction } from './access.js';
import { DomainError, parseInput } from './errors.js';
import { databaseNow } from './releases.js';
import { lockRulePackage, readDesignSkillDocument, readDesignSkillReview, readRulePackageVersion, requireLibraryOwner } from './rule-packages.js';

type Activation = typeof rulePackageActivations.$inferSelect;

function activationView(row: Activation, locale: Locale) {
  return rulePackageActivationSchema.parse({
    sequence: row.sequence, action: row.action, versionId: row.versionId, versionSha256: row.versionSha256,
    reviewSha256: row.reviewSha256, recordedBy: row.recordedBy, recordedAt: row.createdAt.toISOString(),
    message: translate(locale, `rule_package.${row.action}`),
  });
}

async function readActivationHistory(tx: Transaction, packageId: string, locale: Locale) {
  const records = await tx.select().from(rulePackageActivations).where(eq(rulePackageActivations.packageId, packageId))
    .orderBy(desc(rulePackageActivations.sequence)).limit(50);
  const history = records.map(row => activationView(row, locale));
  const latest = history[0];
  return rulePackageActivationViewSchema.parse({ packageId, locale, sequence: latest?.sequence ?? 0,
    current: latest && latest.action !== 'withdraw' ? latest : null, history });
}

export class RulePackageActivationService {
  constructor(private readonly database: Database, private readonly portalClientId?: string) {}

  async get(identity: VerifiedIdentity, packageId: string, locale: Locale) {
    return this.database.db.transaction(async tx => {
      const actor = await requireLibraryOwner(tx, identity);
      const [pkg] = await tx.select({ id: rulePackages.id }).from(rulePackages).where(and(
        eq(rulePackages.id, packageId), eq(rulePackages.workspaceId, actor.workspaceId)));
      if (!pkg) throw new DomainError('not_found');
      return readActivationHistory(tx, pkg.id, locale);
    });
  }

  async change(identity: VerifiedIdentity, packageId: string, raw: unknown, locale: Locale) {
    const input = parseInput(rulePackageActivationInputSchema, raw);
    const requestSha256 = digest(JSON.stringify(input));
    return this.database.db.transaction(async tx => {
      const actor = await requireLibraryOwner(tx, identity);
      if (!isHumanWorkspaceOwner(identity, actor, actor.workspaceId, this.portalClientId)) throw new DomainError('forbidden');
      const pkg = await lockRulePackage(tx, actor.workspaceId, packageId);
      const recordedAt = await databaseNow(tx);
      if (recordedAt.getTime() >= identity.expiresAt * 1_000) throw new DomainError('unauthenticated');
      const [replay] = await tx.select().from(rulePackageActivations).where(and(
        eq(rulePackageActivations.packageId, pkg.id), eq(rulePackageActivations.requestKey, input.idempotencyKey)));
      if (replay) {
        if (replay.recordedBy !== actor.principalId || replay.grantId !== actor.workspaceGrantId) throw new DomainError('forbidden');
        if (replay.requestSha256 !== requestSha256) throw new DomainError('idempotency_conflict');
        return rulePackageActivationResultSchema.parse({ operation: activationView(replay, locale),
          state: await readActivationHistory(tx, pkg.id, locale), replayed: true });
      }
      const [previous] = await tx.select().from(rulePackageActivations).where(eq(rulePackageActivations.packageId, pkg.id))
        .orderBy(desc(rulePackageActivations.sequence)).limit(1);
      if (input.expectedSequence !== (previous?.sequence ?? 0)) throw new DomainError('version_conflict');
      if (input.expectedSequence === 2_147_483_647) throw new DomainError('unavailable');
      const current = previous?.action === 'withdraw' ? undefined : previous;
      const version = await readRulePackageVersion(tx, actor.workspaceId, pkg.id, input.versionId);
      if (version.sha256 !== input.versionSha256) throw new DomainError('version_conflict');
      readDesignSkillDocument(version);
      let reviewId: string | null = null;
      let reviewSha256: string | null = null;
      if (input.action === 'withdraw') {
        if (current?.versionId !== version.id) throw new DomainError('unsupported_state');
      } else {
        if (current?.versionId === version.id) throw new DomainError('unsupported_state');
        if (input.action === 'rollback') {
          const [historical] = await tx.select({ sequence: rulePackageActivations.sequence }).from(rulePackageActivations).where(and(
            eq(rulePackageActivations.packageId, pkg.id), eq(rulePackageActivations.versionId, version.id),
            ne(rulePackageActivations.action, 'withdraw'))).limit(1);
          if (!current || !historical) throw new DomainError('unsupported_state');
        }
        const [review] = await tx.select().from(rulePackageReviews).where(and(
          eq(rulePackageReviews.versionId, version.id), eq(rulePackageReviews.grantId, actor.workspaceGrantId)));
        if (!review || review.reviewedBy !== actor.principalId) throw new DomainError('unsupported_state');
        if (review.sha256 !== input.reviewSha256) throw new DomainError('version_conflict');
        if (readDesignSkillReview(review, version).outcome !== 'accepted') throw new DomainError('unsupported_state');
        reviewId = review.id;
        reviewSha256 = review.sha256;
      }
      const createdAt = await databaseNow(tx, recordedAt);
      if (createdAt.getTime() >= identity.expiresAt * 1_000) throw new DomainError('unauthenticated');
      const [row] = await tx.insert(rulePackageActivations).values({
        packageId: pkg.id, sequence: input.expectedSequence + 1, versionId: version.id, versionSha256: version.sha256,
        action: input.action, reviewId, reviewSha256, recordedBy: actor.principalId, grantId: actor.workspaceGrantId,
        requestKey: input.idempotencyKey, requestSha256, createdAt,
      }).returning();
      if (!row) throw new DomainError('unavailable');
      return rulePackageActivationResultSchema.parse({ operation: activationView(row, locale),
        state: await readActivationHistory(tx, pkg.id, locale), replayed: false });
    });
  }
}
