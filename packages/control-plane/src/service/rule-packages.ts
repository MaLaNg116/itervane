import { and, desc, eq, lt, or } from 'drizzle-orm';
import { designSkillPackageSchema, idSchema, rulePackageDetailSchema, rulePackageImportResultSchema, rulePackageListQuerySchema,
  rulePackagePageSchema, rulePackageReviewDtoSchema, rulePackageReviewInputSchema, rulePackageReviewRecordSchema,
  rulePackageRevisionSchema, translate, type Locale } from '@itervane/contracts';
import { digest } from '@itervane/rules';
import type { VerifiedIdentity } from '../auth/identity.js';
import type { Database } from '../persistence/database.js';
import { rulePackages, rulePackageReviews, rulePackageVersions } from '../persistence/schema.js';
import { isHumanWorkspaceOwner, requireActor, requireProject, type Transaction } from './access.js';
import { DomainError, parseInput } from './errors.js';
import { databaseNow } from './releases.js';

type Version = typeof rulePackageVersions.$inferSelect;
type Review = typeof rulePackageReviews.$inferSelect;

export async function requireLibraryOwner(tx: Transaction, identity: VerifiedIdentity) {
  const actor = await requireActor(tx, identity);
  if (actor.workspaceId === null) throw new DomainError('forbidden');
  return actor;
}

export async function lockRulePackage(tx: Transaction, workspaceId: string, packageId: string) {
  const [row] = await tx.select().from(rulePackages).where(and(
    eq(rulePackages.id, packageId), eq(rulePackages.workspaceId, workspaceId))).for('update');
  if (!row) throw new DomainError('not_found');
  return row;
}

export async function readRulePackageVersion(tx: Transaction, workspaceId: string, packageId: string, versionId: string) {
  const [row] = await tx.select().from(rulePackageVersions).where(and(eq(rulePackageVersions.workspaceId, workspaceId),
    eq(rulePackageVersions.packageId, packageId), eq(rulePackageVersions.id, versionId)));
  if (!row) throw new DomainError('not_found');
  return row;
}

export function readDesignSkillDocument(row: Version) {
  const document = designSkillPackageSchema.parse(row.document);
  const projectId = document.scope.kind === 'project' ? document.scope.projectId : null;
  if (row.packageKey !== document.packageKey || row.version !== document.version || row.projectId !== projectId
      || digest(JSON.stringify(document)) !== row.sha256) throw new Error('rule_package_version_integrity');
  return document;
}

export function readDesignSkillReview(row: Review, version: Version) {
  const document = rulePackageReviewRecordSchema.parse(row.document);
  if (document.versionId !== version.id || document.versionId !== row.versionId
      || document.versionSha256 !== version.sha256 || document.versionSha256 !== row.versionSha256
      || document.reviewedBy !== row.reviewedBy || document.grantId !== row.grantId || document.outcome !== row.outcome
      || digest(JSON.stringify(document)) !== row.sha256) throw new Error('rule_package_review_integrity');
  return document;
}

async function currentReview(tx: Transaction, versionId: string, grantId: string) {
  const [row] = await tx.select().from(rulePackageReviews).where(and(
    eq(rulePackageReviews.versionId, versionId), eq(rulePackageReviews.grantId, grantId)));
  return row;
}

function presentVersion(row: Version, locale: Locale, review?: Review) {
  const document = readDesignSkillDocument(row);
  const reviewRecord = review && readDesignSkillReview(review, row);
  const reviewState = reviewRecord?.outcome ?? 'draft';
  const summary = rulePackageRevisionSchema.parse({
    packageId: row.packageId, versionId: row.id, packageKey: row.packageKey, version: row.version, sha256: row.sha256,
    scope: document.scope, source: document.source, text: document.text[locale], locale, kind: document.kind,
    reviewState, reviewMessage: translate(locale, `rule_package.${reviewState}`), createdAt: row.createdAt.toISOString(),
  });
  return { summary, document, review: review && reviewRecord ? rulePackageReviewDtoSchema.parse({
    id: review.id, sha256: review.sha256, versionSha256: reviewRecord.versionSha256, checks: reviewRecord.checks,
    outcome: reviewRecord.outcome, note: reviewRecord.note, reviewedAt: review.createdAt.toISOString(),
  }) : null };
}

export class RulePackageService {
  constructor(private readonly database: Database, private readonly portalClientId?: string) {}

  async importDraft(identity: VerifiedIdentity, raw: unknown, locale: Locale) {
    const document = parseInput(designSkillPackageSchema, raw);
    const sha256 = digest(JSON.stringify(document));
    return this.database.db.transaction(async tx => {
      const actor = await requireLibraryOwner(tx, identity);
      const projectId = document.scope.kind === 'project' ? document.scope.projectId : null;
      if (projectId && (await requireProject(tx, actor, projectId, true)).workspaceId !== actor.workspaceId) throw new DomainError('not_found');
      await tx.insert(rulePackages).values({ workspaceId: actor.workspaceId, key: document.packageKey })
        .onConflictDoNothing({ target: [rulePackages.workspaceId, rulePackages.key] });
      // A single package lock also gives later publication and rollback one ordering.
      const [pkg] = await tx.select().from(rulePackages).where(and(eq(rulePackages.workspaceId, actor.workspaceId),
        eq(rulePackages.key, document.packageKey))).for('update');
      if (!pkg) throw new DomainError('unavailable');
      const createdAt = await databaseNow(tx);
      if (createdAt.getTime() >= identity.expiresAt * 1_000) throw new DomainError('unauthenticated');
      const [existing] = await tx.select().from(rulePackageVersions).where(and(
        eq(rulePackageVersions.packageId, pkg.id), eq(rulePackageVersions.version, document.version)));
      if (existing && existing.sha256 !== sha256) throw new DomainError('version_conflict');
      const row = existing ?? (await tx.insert(rulePackageVersions).values({
        packageId: pkg.id, workspaceId: actor.workspaceId, packageKey: pkg.key, projectId, version: document.version,
        sha256, document, submittedBy: actor.principalId, grantId: actor.workspaceGrantId, createdAt,
      }).returning())[0];
      if (!row) throw new DomainError('unavailable');
      const view = presentVersion(row, locale, existing ? await currentReview(tx, row.id, actor.workspaceGrantId) : undefined);
      return rulePackageImportResultSchema.parse({ version: { ...view.summary, document: view.document, review: view.review }, replayed: Boolean(existing) });
    });
  }

  async get(identity: VerifiedIdentity, rawPackageId: unknown, rawVersionId: unknown, locale: Locale) {
    const packageId = parseInput(idSchema, rawPackageId);
    const versionId = parseInput(idSchema, rawVersionId);
    return this.database.db.transaction(async tx => {
      const { workspaceId, workspaceGrantId } = await requireLibraryOwner(tx, identity);
      const row = await readRulePackageVersion(tx, workspaceId, packageId, versionId);
      const { summary, document, review } = presentVersion(row, locale, await currentReview(tx, row.id, workspaceGrantId));
      return rulePackageDetailSchema.parse({ ...summary, document, review });
    });
  }

  async list(identity: VerifiedIdentity, rawQuery: unknown, locale: Locale) {
    const { before, limit } = parseInput(rulePackageListQuerySchema, rawQuery);
    return this.database.db.transaction(async tx => {
      const { workspaceId, workspaceGrantId } = await requireLibraryOwner(tx, identity);
      const workspace = eq(rulePackageVersions.workspaceId, workspaceId);
      const [anchor] = before ? await tx.select({ id: rulePackageVersions.id, createdAt: rulePackageVersions.createdAt })
        .from(rulePackageVersions).where(and(workspace, eq(rulePackageVersions.id, before))) : [];
      if (before && !anchor) throw new DomainError('not_found');
      const page = await tx.select({ version: rulePackageVersions, review: rulePackageReviews }).from(rulePackageVersions)
        .leftJoin(rulePackageReviews, and(eq(rulePackageReviews.versionId, rulePackageVersions.id),
          eq(rulePackageReviews.grantId, workspaceGrantId))).where(and(workspace, anchor ? or(
        lt(rulePackageVersions.createdAt, anchor.createdAt),
        and(eq(rulePackageVersions.createdAt, anchor.createdAt), lt(rulePackageVersions.id, anchor.id)),
      ) : undefined)).orderBy(desc(rulePackageVersions.createdAt), desc(rulePackageVersions.id)).limit(limit + 1);
      const items = page.slice(0, limit).map(({ version, review }) => presentVersion(version, locale, review ?? undefined).summary);
      return rulePackagePageSchema.parse({ items, nextBefore: page.length > limit ? items.at(-1)?.versionId : null });
    });
  }

  async review(identity: VerifiedIdentity, packageId: string, versionId: string, raw: unknown, locale: Locale) {
    const input = parseInput(rulePackageReviewInputSchema, raw);
    return this.database.db.transaction(async tx => {
      const actor = await requireLibraryOwner(tx, identity);
      if (!isHumanWorkspaceOwner(identity, actor, actor.workspaceId, this.portalClientId)) throw new DomainError('forbidden');
      await lockRulePackage(tx, actor.workspaceId, packageId);
      const version = await readRulePackageVersion(tx, actor.workspaceId, packageId, versionId);
      if (version.sha256 !== input.versionSha256) throw new DomainError('version_conflict');
      const createdAt = await databaseNow(tx, version.createdAt);
      if (createdAt.getTime() >= identity.expiresAt * 1_000) throw new DomainError('unauthenticated');
      const document = rulePackageReviewRecordSchema.parse({
        ...input, formatVersion: 1, kind: 'design_review', versionId: version.id, reviewedBy: actor.principalId, grantId: actor.workspaceGrantId,
        outcome: Object.values(input.checks).every(Boolean) ? 'accepted' : 'changes_requested',
      });
      const sha256 = digest(JSON.stringify(document));
      const existing = await currentReview(tx, version.id, actor.workspaceGrantId);
      if (existing && existing.sha256 !== sha256) throw new DomainError('idempotency_conflict');
      const row = existing ?? (await tx.insert(rulePackageReviews).values({
        versionId: version.id, versionSha256: version.sha256, reviewedBy: actor.principalId, grantId: actor.workspaceGrantId,
        outcome: document.outcome, sha256, document, createdAt,
      }).returning())[0];
      if (!row) throw new DomainError('unavailable');
      const view = presentVersion(version, locale, row);
      return rulePackageImportResultSchema.parse({ version: { ...view.summary, document: view.document, review: view.review }, replayed: Boolean(existing) });
    });
  }
}
