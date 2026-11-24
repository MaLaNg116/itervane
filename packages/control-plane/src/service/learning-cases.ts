import { captureLearningCaseSchema, idSchema, learningCaseCaptureResultSchema, learningCaseDocumentSchema, learningCaseQuerySchema,
  learningCasesViewSchema, learningCaseViewSchema, translate, type Locale } from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { and, desc, eq, lt, or } from 'drizzle-orm';
import type { VerifiedIdentity } from '../auth/identity.js';
import type { Database } from '../persistence/database.js';
import { learningCases, taskRuns, tasks } from '../persistence/schema.js';
import { requireActor, requireProjectAccess, type Transaction } from './access.js';
import { DomainError, parseInput } from './errors.js';
import { readDeliveryCaseEvidence, readRestartCaseEvidence } from './learning-case-evidence.js';
import { databaseNow } from './releases.js';

type CaseRow = typeof learningCases.$inferSelect;

export function readLearningCase(row: CaseRow) {
  const document = learningCaseDocumentSchema.parse(row.document);
  if (document.projectId !== row.projectId || document.taskId !== row.taskId || document.runId !== row.runId
      || document.evidenceSha256 !== row.evidenceSha256 || document.facts.category !== row.category
      || sha256(JSON.stringify(document)) !== row.sha256) throw new Error('learning_case_integrity');
  return document;
}

function caseView(row: CaseRow, locale: Locale) {
  return learningCaseViewSchema.parse({ id: row.id, sha256: row.sha256, document: readLearningCase(row), locale,
    title: translate(locale, `learning_case.${row.category}`), capturedAt: row.createdAt.toISOString() });
}

export async function readScopedLearningCase(tx: Transaction, projectId: string, caseId: string) {
  const [row] = await tx.select().from(learningCases).where(and(eq(learningCases.projectId, projectId), eq(learningCases.id, caseId)));
  if (!row) throw new DomainError('not_found');
  return row;
}

export class LearningCaseService {
  constructor(private readonly database: Database) {}

  async capture(identity: VerifiedIdentity, rawTaskId: unknown, rawInput: unknown, locale: Locale) {
    const taskId = parseInput(idSchema, rawTaskId);
    const input = parseInput(captureLearningCaseSchema, rawInput);
    return this.database.db.transaction(async tx => {
      const actor = await requireActor(tx, identity);
      const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for('share');
      if (!task) throw new DomainError('not_found');
      const { grantId } = await requireProjectAccess(tx, actor, task.projectId, true);
      const [run] = await tx.select().from(taskRuns).where(and(eq(taskRuns.id, input.runId),
        eq(taskRuns.taskId, task.id), eq(taskRuns.generation, task.generation)));
      if (!run) throw new DomainError('version_conflict');
      const existing = async () => (await tx.select().from(learningCases).where(eq(learningCases.runId, run.id)))[0];
      const requireLiveIdentity = async () => {
        const now = await databaseNow(tx);
        if (now.getTime() >= identity.expiresAt * 1_000) throw new DomainError('unauthenticated');
        return now;
      };
      const replay = (row: CaseRow) => {
        if (row.evidenceSha256 !== input.evidenceSha256) throw new DomainError('version_conflict');
        return learningCaseCaptureResultSchema.parse({ item: caseView(row, locale), replayed: true });
      };
      const recorded = await existing();
      if (recorded) { await requireLiveIdentity(); return replay(recorded); }
      const evidence = run.role === 'operations' ? await readRestartCaseEvidence(tx, task) : await readDeliveryCaseEvidence(tx, task, run.id);
      if (input.evidenceSha256 !== evidence.evidenceSha256) throw new DomainError('version_conflict');
      const document = learningCaseDocumentSchema.parse({
        version: 1, projectId: task.projectId, taskId: task.id, runId: run.id, generation: run.generation,
        dataClass: task.dataClass, evidenceSha256: evidence.evidenceSha256, recordedAt: evidence.recordedAt.toISOString(), facts: evidence.facts,
      });
      const createdAt = await requireLiveIdentity();
      const [inserted] = await tx.insert(learningCases).values({
        projectId: task.projectId, taskId: task.id, runId: run.id, category: document.facts.category, evidenceSha256: document.evidenceSha256,
        sha256: sha256(JSON.stringify(document)), capturedBy: actor.principalId, grantId, document, createdAt,
      }).onConflictDoNothing({ target: learningCases.runId }).returning();
      if (inserted) return learningCaseCaptureResultSchema.parse({ item: caseView(inserted, locale), replayed: false });
      const prior = await existing();
      if (!prior) throw new DomainError('unavailable');
      await requireLiveIdentity();
      return replay(prior);
    });
  }

  async get(identity: VerifiedIdentity, projectId: string, caseId: string, locale: Locale) {
    return this.database.db.transaction(async tx => {
      await requireProjectAccess(tx, await requireActor(tx, identity), projectId);
      return caseView(await readScopedLearningCase(tx, projectId, caseId), locale);
    });
  }

  async list(identity: VerifiedIdentity, projectId: string, rawQuery: unknown, locale: Locale) {
    const { limit, before, category } = parseInput(learningCaseQuerySchema, rawQuery);
    return this.database.db.transaction(async tx => {
      await requireProjectAccess(tx, await requireActor(tx, identity), projectId);
      const anchor = before ? await readScopedLearningCase(tx, projectId, before) : undefined;
      if (anchor && category && anchor.category !== category) throw new DomainError('not_found');
      const page = await tx.select().from(learningCases).where(and(eq(learningCases.projectId, projectId),
        category ? eq(learningCases.category, category) : undefined, anchor ? or(
          lt(learningCases.createdAt, anchor.createdAt),
          and(eq(learningCases.createdAt, anchor.createdAt), lt(learningCases.id, anchor.id)),
        ) : undefined)).orderBy(desc(learningCases.createdAt), desc(learningCases.id)).limit(limit + 1);
      const items = page.slice(0, limit).map(row => caseView(row, locale));
      return learningCasesViewSchema.parse({ items, nextBefore: page.length > limit ? items.at(-1)?.id : null });
    });
  }
}
