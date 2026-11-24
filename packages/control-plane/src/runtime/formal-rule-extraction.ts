import { createFormalRuleExtraction, finishRuleExtraction, learningCandidateSemanticSha256, sha256, type FormalRuleExtractionReport } from '@itervane/agent';
import { learningKnowledgeSchema, localeSchema, ruleExtractionInputSchema, ruleExtractionResultRecordSchema } from '@itervane/contracts';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { and, desc, eq, ne, or } from 'drizzle-orm';
import { learningCases, ruleExtractionInputs, ruleExtractionResults, ruleExtractionRuntime, runRuntime } from '../persistence/schema.js';
import type { Transaction } from '../service/access.js';
import { DomainError } from '../service/errors.js';
import { readLearningCase, readScopedLearningCase } from '../service/learning-cases.js';
import { readRuleExtractionInput, readRuleExtractionResult, requireRuleExtractionAdmission } from '../service/rule-extraction.js';
import { appendEvent, clearSlot, type ExecutionScope, type TaskRow } from './authority.js';
import { GuardedCheckpointer } from './checkpointer.js';
import type { ExecutionCoordinator } from './coordinator.js';
import type { AuditModel } from './formal-audit.js';

async function prepare(tx: Transaction, task: TaskRow, scope: ExecutionScope) {
  const admission = await requireRuleExtractionAdmission(tx, task, scope.runId);
  const record = await readScopedLearningCase(tx, task.projectId, admission.caseId);
  const document = readLearningCase(record);
  if (admission.caseSha256 !== record.sha256) throw new Error('rule_extraction_case_binding');
  const caseRecord = { caseId: record.id, sha256: record.sha256, document };
  const [prior] = await tx.select().from(ruleExtractionInputs).where(eq(ruleExtractionInputs.runId, scope.runId));
  if (prior) return { caseRecord, document: readRuleExtractionInput(prior, admission), sha256: prior.sha256 };
  const { category } = document.facts;
  const kind = category === 'recovered_stopped_instance' ? 'runbook' : 'code_rule';
  const cases = await tx.select({ caseId: learningCases.id, sha256: learningCases.sha256 }).from(learningCases)
    .where(and(eq(learningCases.projectId, task.projectId), eq(learningCases.category, category), ne(learningCases.id, record.id)))
    .orderBy(desc(learningCases.createdAt), desc(learningCases.id)).limit(10);
  const related = await tx.select().from(ruleExtractionResults).where(and(eq(ruleExtractionResults.projectId, task.projectId),
    eq(ruleExtractionResults.candidateKind, kind))).orderBy(desc(ruleExtractionResults.createdAt), desc(ruleExtractionResults.id)).limit(12);
  const candidates = related.map(row => {
    const selected = readRuleExtractionResult(row);
    const outcome = selected.extraction.result;
    if (outcome.outcome !== 'candidate' || !selected.candidateSemanticSha256) throw new Error('rule_extraction_candidate_index_integrity');
    return { id: row.id, key: outcome.candidate.key, kind: outcome.candidate.kind, semanticSha256: selected.candidateSemanticSha256 };
  });
  const knowledge = learningKnowledgeSchema.parse({ category, cases, candidates });
  const input = ruleExtractionInputSchema.parse({ version: 1, taskId: task.id, runId: scope.runId, projectId: task.projectId,
    generation: task.generation, source: { caseId: record.id, sha256: record.sha256 }, knowledge,
    knowledgeSha256: sha256(JSON.stringify(knowledge)), providerSha256: admission.providerSha256 });
  const digest = sha256(JSON.stringify(input));
  await tx.insert(ruleExtractionInputs).values({ runId: scope.runId, document: input, sha256: digest, preparedFence: scope.fence, workerId: scope.workerId });
  return { caseRecord, document: input, sha256: digest };
}

async function publish(tx: Transaction, task: TaskRow, scope: ExecutionScope, input: Awaited<ReturnType<typeof prepare>>,
  report: FormalRuleExtractionReport, model: AuditModel) {
  const [pointer] = await tx.select().from(ruleExtractionRuntime).where(eq(ruleExtractionRuntime.runId, scope.runId));
  const extraction = finishRuleExtraction(report.evidence, report.formalRuleExtraction?.result);
  const { document } = input;
  if (!pointer || !extraction || !report.checkpointId || pointer.checkpointId !== report.checkpointId || pointer.inputSha256 !== input.sha256
      || report.role !== 'rule-extraction' || report.runId !== scope.runId || report.trace.length !== 2
      || JSON.stringify(extraction) !== JSON.stringify(report.formalRuleExtraction)
      || extraction.caseId !== document.source.caseId || extraction.caseSha256 !== document.source.sha256
      || extraction.knowledgeSha256 !== document.knowledgeSha256
      || report.trace.some((entry, index) => entry.operationId !== sha256(`${report.bindingSha256}:${index + 1}`)
        || entry.evidenceId !== report.evidence[index]?.id)) throw new Error('rule_extraction_settlement_integrity');
  const outcome = extraction.result;
  const candidate = outcome.outcome === 'candidate' ? outcome.candidate : null;
  const candidateSemanticSha256 = candidate ? learningCandidateSemanticSha256(candidate) : null;
  if (candidate && candidateSemanticSha256) {
    const [collision] = await tx.select({ id: ruleExtractionResults.id }).from(ruleExtractionResults)
      .where(and(eq(ruleExtractionResults.projectId, task.projectId), or(eq(ruleExtractionResults.candidateKey, candidate.key),
        eq(ruleExtractionResults.candidateSemanticSha256, candidateSemanticSha256)))).limit(1);
    if (collision) return false;
  }
  const recorded = ruleExtractionResultRecordSchema.parse({
    version: 1, taskId: task.id, runId: scope.runId, projectId: task.projectId, generation: scope.generation,
    checkpointId: report.checkpointId, inputSha256: input.sha256, provider: model.adapter.protocol,
    extraction, usage: report.usage, candidateSemanticSha256,
  });
  const digest = sha256(JSON.stringify(recorded));
  const [row] = await tx.insert(ruleExtractionResults).values({ runId: scope.runId, projectId: task.projectId,
    inputSha256: input.sha256, checkpointId: report.checkpointId, finalizedFence: scope.fence, workerId: scope.workerId,
    sha256: digest, candidateKey: candidate?.key ?? null, candidateKind: candidate?.kind ?? null, candidateSemanticSha256, document: recorded,
  }).returning({ id: ruleExtractionResults.id });
  if (!row) throw new Error('rule_extraction_settlement_missing');
  await tx.update(runRuntime).set({ reason: null, resumePending: false, waitingForTaskId: null, toolsUsed: report.usage.toolCalls })
    .where(eq(runRuntime.runId, scope.runId));
  await appendEvent(tx, task, 'task.rule_extraction_recorded', 'succeeded', {
    workerId: scope.workerId, ruleExtraction: { runId: scope.runId, resultId: row.id, resultSha256: digest },
  });
  await clearSlot(tx);
  return true;
}

export async function runFormalRuleExtraction(coordinator: ExecutionCoordinator, scope: ExecutionScope, saver: PostgresSaver,
  model: AuditModel | undefined, signal: AbortSignal) {
  if (!model) return coordinator.stop(scope, 'rule_extraction_model_changed');
  const prepared = await coordinator.withLease(scope, async (tx, { task, run }) => {
    if (run.role !== 'rule-extraction') throw new DomainError('forbidden');
    const admission = await requireRuleExtractionAdmission(tx, task, scope.runId);
    if (admission.providerSha256 !== model.providerSha256) return;
    return { ...(await prepare(tx, task, scope)), coordinates: { taskId: task.id, runId: scope.runId, projectId: task.projectId,
      generation: scope.generation, locale: localeSchema.parse(task.locale), source: { repositoryId: task.repositoryId, commit: task.commit } } };
  });
  if (!prepared) return coordinator.stop(scope, 'rule_extraction_model_changed');
  const { knowledge, knowledgeSha256 } = prepared.document;
  const checkpointer = new GuardedCheckpointer(coordinator, scope, saver, { ruleExtractionInputSha256: prepared.sha256, signal });
  const agent = createFormalRuleExtraction({ caseRecord: prepared.caseRecord, knowledge, knowledgeSha256, model: model.adapter,
    coordinates: prepared.coordinates, checkpointer, providerSha256: model.providerSha256,
    authorize: (_scope, active) => coordinator.withLease(scope, async () => !active.aborted),
  });
  const report = await agent.run({ signal });
  signal.throwIfAborted();
  if (report.reason === 'permission_denied') throw new DomainError('forbidden');
  if (report.status !== 'completed') return coordinator.stop(scope, 'rule_extraction_needs_human');
  const settled = await coordinator.withLease(scope, (tx, { task }) => {
    signal.throwIfAborted();
    return publish(tx, task, scope, prepared, report, model);
  });
  if (!settled) return coordinator.stop(scope, 'rule_extraction_needs_human');
}
