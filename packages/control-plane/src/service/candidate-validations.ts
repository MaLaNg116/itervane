import { candidateValidationPlanSchema, candidateValidationRecordSchema, candidateValidationViewSchema, eventReasonMessages,
  idSchema, startCandidateValidationSchema, taskEventReasonSchema, translate, type Locale } from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { and, eq } from 'drizzle-orm';
import type { VerifiedIdentity } from '../auth/identity.js';
import type { CandidateValidationInstallation } from '../config.js';
import type { Database } from '../persistence/database.js';
import { candidateValidationAdmissions, candidateValidationResults, ruleExtractionResults, runRuntime, taskRuns, tasks } from '../persistence/schema.js';
import type { TaskRow } from '../runtime/authority.js';
import { requireActor, requireProjectAccess, type Transaction } from './access.js';
import { DomainError, parseInput } from './errors.js';
import { databaseNow } from './releases.js';
import { readRuleExtractionResult } from './rule-extraction.js';
import { TaskService } from './tasks.js';

type Admission = typeof candidateValidationAdmissions.$inferSelect;
type Result = typeof candidateValidationResults.$inferSelect;

export async function readCandidateForValidation(tx: Transaction, projectId: string, candidateId: string) {
  const [row] = await tx.select().from(ruleExtractionResults).where(and(
    eq(ruleExtractionResults.projectId, projectId), eq(ruleExtractionResults.id, candidateId)));
  if (!row) throw new DomainError('not_found');
  const document = readRuleExtractionResult(row);
  const outcome = document.extraction.result;
  if (outcome.outcome !== 'candidate') throw new DomainError('unsupported_state');
  return { row, document, candidate: outcome.candidate };
}

export async function requireCandidateValidationAdmission(tx: Transaction, task: TaskRow, runId: string, grantId?: string) {
  const [admission] = await tx.select().from(candidateValidationAdmissions).where(and(eq(candidateValidationAdmissions.taskId, task.id),
    eq(candidateValidationAdmissions.runId, runId), eq(candidateValidationAdmissions.projectId, task.projectId)));
  if (!admission || task.generation !== 1 || (grantId && admission.grantId !== grantId)) throw new DomainError('forbidden');
  const plan = candidateValidationPlanSchema.parse(admission.plan);
  if (plan.candidateId !== admission.candidateId || sha256(JSON.stringify(plan)) !== admission.planSha256) {
    throw new Error('candidate_validation_plan_integrity');
  }
  return { ...admission, plan };
}

export function readCandidateValidationRecord(row: Result, admission: Admission) {
  const record = candidateValidationRecordSchema.parse(row.document);
  const plan = candidateValidationPlanSchema.parse(admission.plan);
  const expectedRequestId = record.evidence.kind === 'code_rule' ? record.evidence.receipt.scope.requestId : null;
  if (record.taskId !== admission.taskId || record.runId !== admission.runId || record.projectId !== admission.projectId
      || record.runId !== row.runId || record.projectId !== row.projectId || record.candidateId !== admission.candidateId
      || record.candidateId !== row.candidateId || record.planSha256 !== admission.planSha256 || record.planSha256 !== row.planSha256
      || record.candidateSha256 !== plan.candidateSha256 || record.extractionResultSha256 !== plan.extractionResultSha256
      || record.evidence.kind !== plan.kind || expectedRequestId !== row.requestId || plan.candidateId !== admission.candidateId
      || sha256(JSON.stringify(plan)) !== admission.planSha256
      || sha256(JSON.stringify(record)) !== row.sha256) throw new Error('candidate_validation_record_integrity');
  return record;
}

export async function readPassedCandidateValidation(tx: Transaction, projectId: string, candidateId: string, validationId: string) {
  const [stored] = await tx.select({ result: candidateValidationResults, admission: candidateValidationAdmissions, state: tasks.state })
    .from(candidateValidationResults).innerJoin(candidateValidationAdmissions, eq(candidateValidationAdmissions.runId, candidateValidationResults.runId))
    .innerJoin(tasks, eq(tasks.id, candidateValidationAdmissions.taskId))
    .where(and(eq(candidateValidationResults.id, validationId), eq(candidateValidationResults.candidateId, candidateId),
      eq(candidateValidationResults.projectId, projectId)));
  if (!stored) throw new DomainError('not_found');
  const record = readCandidateValidationRecord(stored.result, stored.admission);
  if (record.status !== 'passed' || stored.state !== 'succeeded') throw new DomainError('unsupported_state');
  const { row, candidate } = await readCandidateForValidation(tx, projectId, candidateId);
  if (row.sha256 !== record.extractionResultSha256 || candidate.kind !== record.evidence.kind
      || sha256(JSON.stringify(candidate)) !== record.candidateSha256) throw new Error('candidate_validation_source_integrity');
  return { candidate, record, validation: { id: stored.result.id, sha256: stored.result.sha256, taskId: record.taskId, projectId: record.projectId,
    candidateId: record.candidateId, candidateSha256: record.candidateSha256, extractionResultSha256: record.extractionResultSha256,
    planSha256: record.planSha256 } };
}

export class CandidateValidationService {
  private readonly tasks: TaskService;
  constructor(private readonly database: Database, private readonly installation?: CandidateValidationInstallation) {
    this.tasks = new TaskService(database);
  }

  async admit(identity: VerifiedIdentity, projectId: string, candidateId: string, raw: unknown) {
    const input = parseInput(startCandidateValidationSchema, raw);
    return this.database.db.transaction(async tx => {
      const actor = await requireActor(tx, identity);
      const { grantId } = await requireProjectAccess(tx, actor, projectId, true);
      const { row, document, candidate } = await readCandidateForValidation(tx, projectId, candidateId);
      if (input.extractionResultSha256 !== row.sha256) throw new DomainError('version_conflict');
      const installation = this.installation;
      if (!installation || (candidate.kind === 'code_rule' && !installation.profile)) throw new DomainError('unavailable');
      const [source] = await tx.select({ repositoryId: tasks.repositoryId, commit: tasks.commit, dataClass: tasks.dataClass })
        .from(tasks).where(and(eq(tasks.id, document.taskId), eq(tasks.projectId, projectId), eq(tasks.state, 'succeeded')));
      if (!source) throw new DomainError('unsupported_state');
      if ((await databaseNow(tx)).getTime() >= identity.expiresAt * 1_000) throw new DomainError('unauthenticated');
      const plan = candidateValidationPlanSchema.parse({
        version: 1, kind: candidate.kind, candidateId: row.id, extractionResultSha256: row.sha256, candidateSha256: sha256(JSON.stringify(candidate)),
        ...(candidate.kind === 'code_rule' ? { profile: installation.profile } : { evaluatorVersion: 1 }),
      });
      const planSha256 = sha256(JSON.stringify(plan));
      const requestHash = sha256(JSON.stringify({ workflow: 'rule-validation', planSha256, locale: input.locale, grantId }));
      return this.tasks.insertAuthorizedTask(tx, { ...source, projectId, requestedBy: actor.principalId, locale: input.locale,
        purpose: translate(input.locale, 'candidate_validation.purpose'), requestKey: input.idempotencyKey, requestHash },
      { candidateId: row.id, plan, planSha256, grantId });
    });
  }

  async get(identity: VerifiedIdentity, rawTaskId: unknown, locale: Locale) {
    const taskId = parseInput(idSchema, rawTaskId);
    return this.database.db.transaction(async tx => {
      const actor = await requireActor(tx, identity);
      const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for('share');
      if (!task) throw new DomainError('not_found');
      await requireProjectAccess(tx, actor, task.projectId);
      const [current] = await tx.select({ runId: taskRuns.id, reason: runRuntime.reason }).from(taskRuns)
        .innerJoin(runRuntime, eq(runRuntime.runId, taskRuns.id))
        .where(and(eq(taskRuns.taskId, task.id), eq(taskRuns.generation, task.generation), eq(taskRuns.role, 'verify')));
      if (!current) throw new DomainError('not_found');
      const admission = await requireCandidateValidationAdmission(tx, task, current.runId);
      const [record] = await tx.select().from(candidateValidationResults).where(eq(candidateValidationResults.runId, current.runId));
      const result = record ? { id: record.id, sha256: record.sha256, document: readCandidateValidationRecord(record, admission),
        recordedAt: record.createdAt.toISOString() } : null;
      const reason = taskEventReasonSchema.safeParse(current.reason);
      return candidateValidationViewSchema.parse({ taskId, runId: current.runId, plan: admission.plan, planSha256: admission.planSha256,
        state: task.state, locale, result, message: translate(locale, result ? `candidate_validation.${result.document.status}`
          : reason.success ? eventReasonMessages[reason.data] : `state.${task.state}`),
      });
    });
  }
}
