import { idSchema, ruleExtractionInputSchema, ruleExtractionResultRecordSchema, ruleExtractionViewSchema,
  startRuleExtractionSchema, taskEventReasonSchema, eventReasonMessages, translate, type Locale } from '@itervane/contracts';
import { learningCandidateSemanticSha256, sha256 } from '@itervane/agent';
import { and, eq } from 'drizzle-orm';
import type { VerifiedIdentity } from '../auth/identity.js';
import type { Database } from '../persistence/database.js';
import { ruleExtractionAdmissions, ruleExtractionInputs, ruleExtractionResults, ruleExtractionRuntime, runRuntime, taskRuns, tasks } from '../persistence/schema.js';
import type { TaskRow } from '../runtime/authority.js';
import { requireActor, requireProjectAccess, type Transaction } from './access.js';
import { DomainError, parseInput } from './errors.js';
import { readLearningCase, readScopedLearningCase } from './learning-cases.js';
import { databaseNow } from './releases.js';
import { TaskService } from './tasks.js';

export type ExtractionAdmission = typeof ruleExtractionAdmissions.$inferSelect;
type ExtractionInput = typeof ruleExtractionInputs.$inferSelect;
type ExtractionResult = typeof ruleExtractionResults.$inferSelect;

export async function requireRuleExtractionAdmission(tx: Transaction, task: TaskRow, runId: string, grantId?: string) {
  const [row] = await tx.select().from(ruleExtractionAdmissions).where(and(eq(ruleExtractionAdmissions.taskId, task.id),
    eq(ruleExtractionAdmissions.projectId, task.projectId), eq(ruleExtractionAdmissions.runId, runId)));
  if (!row || task.generation !== 1 || (grantId && grantId !== row.grantId)) throw new DomainError('forbidden');
  return row;
}

export function readRuleExtractionInput(row: ExtractionInput, admission: ExtractionAdmission) {
  const document = ruleExtractionInputSchema.parse(row.document);
  if (document.taskId !== admission.taskId || document.runId !== admission.runId || document.projectId !== admission.projectId
      || document.source.caseId !== admission.caseId || document.source.sha256 !== admission.caseSha256
      || document.providerSha256 !== admission.providerSha256 || sha256(JSON.stringify(document.knowledge)) !== document.knowledgeSha256
      || sha256(JSON.stringify(document)) !== row.sha256) throw new Error('rule_extraction_input_integrity');
  return document;
}

export function readRuleExtractionResult(row: ExtractionResult) {
  const document = ruleExtractionResultRecordSchema.parse(row.document);
  const outcome = document.extraction.result;
  const semantic = outcome.outcome === 'candidate' ? learningCandidateSemanticSha256(outcome.candidate) : null;
  if (document.runId !== row.runId || document.projectId !== row.projectId || document.inputSha256 !== row.inputSha256
      || document.checkpointId !== row.checkpointId || sha256(JSON.stringify(document)) !== row.sha256
      || document.candidateSemanticSha256 !== semantic || row.candidateSemanticSha256 !== semantic
      || (outcome.outcome === 'candidate' && (outcome.candidate.key !== row.candidateKey || outcome.candidate.kind !== row.candidateKind))) {
    throw new Error('rule_extraction_result_integrity');
  }
  return document;
}

export class RuleExtractionService {
  private readonly tasks: TaskService;
  constructor(private readonly database: Database, private readonly providerSha256?: string) { this.tasks = new TaskService(database); }

  async admit(identity: VerifiedIdentity, projectId: string, caseId: string, raw: unknown) {
    const input = parseInput(startRuleExtractionSchema, raw);
    return this.database.db.transaction(async tx => {
      const actor = await requireActor(tx, identity);
      const { grantId } = await requireProjectAccess(tx, actor, projectId, true);
      const row = await readScopedLearningCase(tx, projectId, caseId);
      const document = readLearningCase(row);
      if (row.sha256 !== input.caseSha256) throw new DomainError('version_conflict');
      const providerSha256 = this.providerSha256;
      if (!providerSha256) throw new DomainError('unavailable');
      const [source] = await tx.select({ repositoryId: tasks.repositoryId, commit: tasks.commit }).from(tasks)
        .where(and(eq(tasks.id, document.taskId), eq(tasks.projectId, projectId)));
      if (!source) throw new DomainError('not_found');
      if ((await databaseNow(tx)).getTime() >= identity.expiresAt * 1_000) throw new DomainError('unauthenticated');
      const requestHash = sha256(JSON.stringify({ workflow: 'rule-extraction', caseId: row.id, caseSha256: row.sha256,
        providerSha256, locale: input.locale, grantId }));
      return this.tasks.insertAuthorizedTask(tx, { ...source, projectId, requestedBy: actor.principalId, dataClass: document.dataClass,
        purpose: translate(input.locale, 'rule_extraction.purpose'), locale: input.locale, requestKey: input.idempotencyKey, requestHash },
      { caseId: row.id, caseSha256: row.sha256, providerSha256, grantId });
    });
  }

  async get(identity: VerifiedIdentity, rawTaskId: unknown, locale: Locale) {
    const taskId = parseInput(idSchema, rawTaskId);
    return this.database.db.transaction(async tx => {
      const actor = await requireActor(tx, identity);
      const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for('share');
      if (!task) throw new DomainError('not_found');
      await requireProjectAccess(tx, actor, task.projectId);
      const [bound] = await tx.select({ run: taskRuns, reason: runRuntime.reason }).from(taskRuns)
        .innerJoin(runRuntime, eq(runRuntime.runId, taskRuns.id))
        .where(and(eq(taskRuns.taskId, task.id), eq(taskRuns.generation, task.generation), eq(taskRuns.role, 'rule-extraction')));
      if (!bound) throw new DomainError('not_found');
      const admission = await requireRuleExtractionAdmission(tx, task, bound.run.id);
      const [value] = await tx.select({ result: ruleExtractionResults, input: ruleExtractionInputs, pointer: ruleExtractionRuntime })
        .from(ruleExtractionResults).innerJoin(ruleExtractionInputs, eq(ruleExtractionInputs.runId, ruleExtractionResults.runId))
        .innerJoin(ruleExtractionRuntime, eq(ruleExtractionRuntime.runId, ruleExtractionResults.runId))
        .where(eq(ruleExtractionResults.runId, admission.runId));
      let result = null;
      if (value) {
        const { result: row, input, pointer } = value;
        const document = readRuleExtractionResult(row);
        const prepared = readRuleExtractionInput(input, admission);
        if (document.taskId !== task.id || document.inputSha256 !== input.sha256 || pointer.inputSha256 !== input.sha256
            || document.checkpointId !== pointer.checkpointId || document.extraction.caseId !== admission.caseId
            || document.extraction.caseSha256 !== admission.caseSha256 || document.extraction.knowledgeSha256 !== prepared.knowledgeSha256) {
          throw new Error('rule_extraction_result_origin');
        }
        result = { id: row.id, sha256: row.sha256, document, recordedAt: row.createdAt.toISOString() };
      }
      const reason = taskEventReasonSchema.safeParse(bound.reason);
      return ruleExtractionViewSchema.parse({ taskId, runId: admission.runId, locale, state: task.state, result,
        source: { caseId: admission.caseId, sha256: admission.caseSha256 },
        message: translate(locale, result ? `rule_extraction.${result.document.extraction.result.outcome}`
          : reason.success ? eventReasonMessages[reason.data] : `state.${task.state}`),
      });
    });
  }
}
