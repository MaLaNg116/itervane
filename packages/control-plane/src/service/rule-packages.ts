import { and, desc, eq, lt, or } from 'drizzle-orm';
import { designSkillPackageSchema, idSchema, rulePackageDetailSchema, rulePackageImportResultSchema, rulePackageListQuerySchema,
  rulePackagePageSchema, rulePackageRevisionSchema, translate, type Locale } from '@itervane/contracts';
import { digest } from '@itervane/rules';
import type { VerifiedIdentity } from '../auth/identity.js';
import type { Database } from '../persistence/database.js';
import { rulePackages, rulePackageVersions } from '../persistence/schema.js';
import { requireActor, requireProject, type Transaction } from './access.js';
import { DomainError, parseInput } from './errors.js';
import { databaseNow } from './releases.js';

type Version = typeof rulePackageVersions.$inferSelect;

async function requireLibraryOwner(tx: Transaction, identity: VerifiedIdentity) {
  const actor = await requireActor(tx, identity);
  if (actor.workspaceId === null) throw new DomainError('forbidden');
  return actor;
}

function readVersion(row: Version, locale: Locale) {
  const document = designSkillPackageSchema.parse(row.document);
  const projectId = document.scope.kind === 'project' ? document.scope.projectId : null;
  if (row.packageKey !== document.packageKey || row.version !== document.version || row.projectId !== projectId
      || digest(JSON.stringify(document)) !== row.sha256) throw new Error('rule_package_version_integrity');
  const summary = rulePackageRevisionSchema.parse({
    packageId: row.packageId, versionId: row.id, packageKey: row.packageKey, version: row.version, sha256: row.sha256,
    scope: document.scope, source: document.source, text: document.text[locale], locale, kind: document.kind,
    reviewState: 'draft', reviewMessage: translate(locale, 'rule_package.draft'), createdAt: row.createdAt.toISOString(),
  });
  return { summary, document };
}

export class RulePackageService {
  constructor(private readonly database: Database) {}

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
      const view = readVersion(row, locale);
      return rulePackageImportResultSchema.parse({ version: { ...view.summary, document: view.document }, replayed: Boolean(existing) });
    });
  }

  async get(identity: VerifiedIdentity, rawPackageId: unknown, rawVersionId: unknown, locale: Locale) {
    const packageId = parseInput(idSchema, rawPackageId);
    const versionId = parseInput(idSchema, rawVersionId);
    return this.database.db.transaction(async tx => {
      const { workspaceId } = await requireLibraryOwner(tx, identity);
      const [row] = await tx.select().from(rulePackageVersions).where(and(eq(rulePackageVersions.workspaceId, workspaceId),
        eq(rulePackageVersions.packageId, packageId), eq(rulePackageVersions.id, versionId)));
      if (!row) throw new DomainError('not_found');
      const { summary, document } = readVersion(row, locale);
      return rulePackageDetailSchema.parse({ ...summary, document });
    });
  }

  async list(identity: VerifiedIdentity, rawQuery: unknown, locale: Locale) {
    const { before, limit } = parseInput(rulePackageListQuerySchema, rawQuery);
    return this.database.db.transaction(async tx => {
      const { workspaceId } = await requireLibraryOwner(tx, identity);
      const workspace = eq(rulePackageVersions.workspaceId, workspaceId);
      const [anchor] = before ? await tx.select({ id: rulePackageVersions.id, createdAt: rulePackageVersions.createdAt })
        .from(rulePackageVersions).where(and(workspace, eq(rulePackageVersions.id, before))) : [];
      if (before && !anchor) throw new DomainError('not_found');
      const page = await tx.select().from(rulePackageVersions).where(and(workspace, anchor ? or(
        lt(rulePackageVersions.createdAt, anchor.createdAt),
        and(eq(rulePackageVersions.createdAt, anchor.createdAt), lt(rulePackageVersions.id, anchor.id)),
      ) : undefined)).orderBy(desc(rulePackageVersions.createdAt), desc(rulePackageVersions.id)).limit(limit + 1);
      const items = page.slice(0, limit).map(row => readVersion(row, locale).summary);
      return rulePackagePageSchema.parse({ items, nextBefore: page.length > limit ? items.at(-1)?.versionId : null });
    });
  }
}
