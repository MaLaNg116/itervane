import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { catalogDtoSchema, idSchema, listQuerySchema, preauditDtoSchema, preauditInputSchema, preauditRecordSchema, preauditSummaryDtoSchema,
  ruleIdSchema, ruleQuerySchema, translate, type Locale, type PreauditRecord } from '@itervane/contracts';
import { catalogSnapshot, evaluateText, inputHash, InvalidTextDiff, recordHash, RuleCatalogMismatch, ruleView, validCatalog } from '@itervane/rules';
import type { VerifiedIdentity } from '../auth/identity.js';
import type { Database } from '../persistence/database.js';
import { preaudits } from '../persistence/schema.js';
import { requireActor, requireProject } from './access.js';
import { DomainError, parseInput } from './errors.js';

type Row = typeof preaudits.$inferSelect;
function stored(row: Row) {
  const document = preauditRecordSchema.parse(row.document);
  if (document.id !== row.id || document.projectId !== row.projectId || document.requestedBy !== row.requestedBy
    || recordHash(document) !== row.reportSha256 || !validCatalog(document.evaluation.catalog)) throw new Error('preaudit_integrity');
  return document;
}
function summary(row: Row, document = stored(row)) {
  return preauditSummaryDtoSchema.parse({ id: row.id, projectId: row.projectId, requestedBy: row.requestedBy, submittedVia: document.submittedVia,
    createdAt: row.createdAt.toISOString(), input: document.evaluation.input, outcome: document.evaluation.outcome,
    catalogSha256: document.evaluation.catalog.sha256, reportSha256: row.reportSha256 });
}
function present(row: Row, locale: Locale) {
  const document = stored(row); const result = document.evaluation;
  const material = (id: string) => { const rule = result.catalog.rules.find(value => value.material.id === id); if (!rule) throw new Error('preaudit_rule_binding'); return rule; };
  return preauditDtoSchema.parse({ ...summary(row, document), locale, catalogVersion: result.catalog.version, engineVersion: result.catalog.engineVersion,
    observations: result.observations.map(observation => { const rule = material(observation.ruleId); return { ...observation,
      ruleVersion: rule.material.version, ruleSha256: rule.sha256, ...rule.material.text[locale] }; }),
    coverage: result.coverage.map(coverage => ({ ...coverage, title: material(coverage.ruleId).material.text[locale].title })),
    uncovered: result.uncovered.map(code => ({ code, message: translate(locale, `preaudit.uncovered.${code}`) })), formalScan: false, releaseEligible: false });
}

export class RuleService {
  constructor(private readonly database: Database) {}
  async list(identity: VerifiedIdentity, projectId: string, raw: unknown, locale: Locale) {
    parseInput(idSchema, projectId); const query = parseInput(ruleQuerySchema, raw);
    return this.database.db.transaction(async tx => {
      await requireProject(tx, await requireActor(tx, identity), projectId);
      const catalog = catalogSnapshot();
      if (query.catalogSha256 && query.catalogSha256 !== catalog.sha256) throw new DomainError('conflict');
      return catalogDtoSchema.parse({ version: catalog.version, engineVersion: catalog.engineVersion, sha256: catalog.sha256, locale,
        items: catalog.rules.filter(rule => !query.language || rule.material.languages.includes(query.language)).map(rule => ruleView(rule, locale)) });
    });
  }
  async get(identity: VerifiedIdentity, projectId: string, ruleId: string, raw: unknown, locale: Locale) {
    parseInput(ruleIdSchema, ruleId); const catalog = await this.list(identity, projectId, raw, locale);
    const rule = catalog.items.find(value => value.id === ruleId); if (!rule) throw new DomainError('not_found'); return rule;
  }
}

export class PreauditService {
  constructor(private readonly database: Database) {}
  async create(identity: VerifiedIdentity, raw: unknown, submittedVia: 'http' | 'mcp', locale: Locale) {
    const input = parseInput(preauditInputSchema, raw); const hash = inputHash(input);
    return this.database.db.transaction(async tx => {
      const actor = await requireActor(tx, identity); await requireProject(tx, actor, input.projectId, true);
      const key = and(eq(preaudits.projectId, input.projectId), eq(preaudits.requestedBy, actor.principalId), eq(preaudits.requestKey, input.idempotencyKey));
      const [existing] = await tx.select().from(preaudits).where(key);
      if (existing) { if (existing.requestHash !== hash) throw new DomainError('idempotency_conflict'); return { report: present(existing, locale), replayed: true }; }
      let evaluation;
      try { evaluation = evaluateText(input); }
      catch (error) { if (error instanceof InvalidTextDiff) throw new DomainError('invalid_input'); if (error instanceof RuleCatalogMismatch) throw new DomainError('conflict'); throw error; }
      const id = randomUUID(); const document: PreauditRecord = { id, projectId: input.projectId, requestedBy: actor.principalId, submittedVia, evaluation };
      const [created] = await tx.insert(preaudits).values({ id, projectId: input.projectId, requestedBy: actor.principalId,
        requestKey: input.idempotencyKey, requestHash: hash, reportSha256: recordHash(document), document })
        .onConflictDoNothing({ target: [preaudits.projectId, preaudits.requestedBy, preaudits.requestKey] }).returning();
      if (created) return { report: present(created, locale), replayed: false };
      const [raced] = await tx.select().from(preaudits).where(key);
      if (!raced || raced.requestHash !== hash) throw new DomainError('idempotency_conflict');
      return { report: present(raced, locale), replayed: true };
    });
  }
  async get(identity: VerifiedIdentity, id: string, locale: Locale) {
    parseInput(idSchema, id);
    return this.database.db.transaction(async tx => {
      const actor = await requireActor(tx, identity); const [row] = await tx.select().from(preaudits).where(eq(preaudits.id, id));
      if (!row) throw new DomainError('not_found'); await requireProject(tx, actor, row.projectId); return present(row, locale);
    });
  }
  async list(identity: VerifiedIdentity, projectId: string, limit: number) {
    parseInput(idSchema, projectId); limit = parseInput(listQuerySchema, { limit }).limit;
    return this.database.db.transaction(async tx => {
      await requireProject(tx, await requireActor(tx, identity), projectId);
      return (await tx.select().from(preaudits).where(eq(preaudits.projectId, projectId)).orderBy(desc(preaudits.createdAt), desc(preaudits.id)).limit(limit)).map(row => summary(row));
    });
  }
}
