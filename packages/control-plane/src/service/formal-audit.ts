import { and, eq } from 'drizzle-orm';
import { agentText, type FormalAuditReport } from '@itervane/agent';
import { formalAuditDtoSchema, formalAuditInputSchema, formalAuditResultSchema, idSchema, translate,
  type FormalAuditResult, type Locale } from '@itervane/contracts';
import { catalogSnapshot, validCatalog } from '@itervane/rules';
import { sha256 } from '@itervane/runner';
import type { VerifiedIdentity } from '../auth/identity.js';
import type { Database } from '../persistence/database.js';
import { formalAuditInputs, formalAuditResults, formalAuditRuntime, runRuntime, taskRuns, tasks } from '../persistence/schema.js';
import { appendEvent, clearSlot, type ExecutionScope, type TaskRow } from '../runtime/authority.js';
import { requireActor, requireProject, type Transaction } from './access.js';
import { DomainError, parseInput } from './errors.js';
import { prepareFormalRepairInput } from './formal-repair.js';
import { currentInspectionAttempt, inspectionCoverage, readInspectionEvidence } from './inspection-evidence.js';
import { readInspectionPlan } from './inspections.js';
import { matchesLinkedRepairSource, readLinkedHealthBasis, readLinkedOperationsRepair, requireCurrentLinkedHealthRepair }
  from './operations-repair-proposals.js';
import { readRepairRetry } from './repair-retry.js';

// The current Worker calls this under its authorized lease before yielding to the audit stage.
export async function prepareFormalAuditInput(tx: Transaction, task: TaskRow, scope: ExecutionScope) {
  const plan = await readInspectionPlan(tx, task, scope.runId);
  const attempt = await currentInspectionAttempt(tx, scope.runId);
  if (!plan || attempt?.state !== 'recorded' || !attempt.workspaceSha256) throw new DomainError('unavailable');
  const evidence = readInspectionEvidence(attempt, plan);
  if (inspectionCoverage(evidence.receipt) !== 'complete') throw new DomainError('unavailable');
  const linked = await readLinkedOperationsRepair(tx, task);
  if (linked && !matchesLinkedRepairSource(linked.frozen, evidence.receipt)) throw new DomainError('version_conflict');

  const [stored] = await tx.select().from(formalAuditInputs).where(eq(formalAuditInputs.runId, scope.runId));
  const previous = stored ? formalAuditInputSchema.parse(stored.document) : null;
  const catalog = previous?.catalog ?? catalogSnapshot();
  if (!validCatalog(catalog)) throw new Error('formal_audit_catalog_integrity');
  const retry = await readRepairRetry(tx, task, scope);
  if (retry && (retry.baseSnapshotSha256 !== evidence.receipt.snapshot.manifestSha256 || retry.catalogSha256 !== catalog.sha256)) {
    throw new DomainError('conflict');
  }
  const continuation = retry && 'kind' in retry ? retry : undefined;
  if (continuation) await requireCurrentLinkedHealthRepair(tx, task, continuation);
  const document = formalAuditInputSchema.parse({
    version: 1, taskId: task.id, runId: scope.runId, projectId: task.projectId, generation: scope.generation,
    source: { repositoryId: task.repositoryId, commit: task.commit }, dataClass: task.dataClass, locale: task.locale,
    purposeSha256: sha256(task.purpose), catalog,
    inspection: { requestId: attempt.requestId, receiptSha256: evidence.sha256, planSha256: plan.sha256,
      snapshotSha256: evidence.receipt.snapshot.manifestSha256 },
    ...(continuation ? { healthReproduction: continuation.previous } : {}),
  });
  const hash = sha256(JSON.stringify(document));
  if (stored && previous) {
    if (stored.sha256 !== hash || stored.sha256 !== sha256(JSON.stringify(previous))) throw new Error('formal_audit_input_integrity');
    return { sha256: stored.sha256, document: previous, inspection: evidence.receipt, continuation };
  }
  await tx.insert(formalAuditInputs).values({ runId: scope.runId, taskId: task.id, projectId: task.projectId,
    inspectionRequestId: attempt.requestId, preparedFence: scope.fence, workerId: scope.workerId, sha256: hash, document });
  return { sha256: hash, document, inspection: evidence.receipt, continuation };
}

type PreparedAudit = Awaited<ReturnType<typeof prepareFormalAuditInput>>;

function auditResult(prepared: PreparedAudit, report: FormalAuditReport, provider: FormalAuditResult['provider']) {
  const { document, inspection } = prepared;
  const observed = new Map(inspection.snapshot.reports.flatMap(scan =>
    scan.findings.map(finding => [finding.id, { ...finding, scanner: scan.scanner }] as const)));
  const evidence = report.evidence.map(({ id, data }) => {
    if (data.kind === 'scan') {
      const { scanner, version, policySha256, databaseSha256, totalFindings, findings } = data;
      return { id, kind: data.kind, scanner, version, policySha256, databaseSha256, totalFindings, findingIds: findings.map(item => item.id) };
    }
    if (data.kind === 'rule') return { id, kind: data.kind, ruleId: data.ruleId, sha256: data.sha256 };
    if (data.kind === 'health_reproduction' && document.healthReproduction
        && JSON.stringify(data.reproduction) === JSON.stringify(document.healthReproduction)) {
      return { id, kind: data.kind, reproduction: data.reproduction };
    }
    throw new Error('formal_audit_evidence_origin');
  });
  const admitted = new Map(evidence.map(item => [item.id, item]));
  if (report.runId !== document.runId || report.role !== 'audit' || report.trace.length !== admitted.size
    || new Set(report.trace.map(item => item.evidenceId)).size !== admitted.size
    || report.trace.some(item => {
      const kind = admitted.get(item.evidenceId)?.kind;
      return item.role !== 'audit' || !kind || item.tool !== (kind === 'scan' ? 'read_scan' : kind === 'rule' ? 'read_rule' : 'read_health_reproduction');
    })) throw new Error('formal_audit_checkpoint_trace');
  const checklist = report.audit ? {
    ...report.audit,
    findings: report.audit.findings.map(({ id, certainty, impact, suggestion }) => {
      const finding = observed.get(id);
      if (!finding) throw new Error('formal_audit_finding_binding');
      return { ...finding, certainty, impact, suggestion };
    }),
  } : null;
  return formalAuditResultSchema.parse({
    version: 1, taskId: document.taskId, runId: document.runId, projectId: document.projectId, generation: document.generation,
    locale: document.locale, inputSha256: prepared.sha256, checkpointId: report.checkpointId,
    inspectionSha256: document.inspection.receiptSha256, snapshotSha256: document.inspection.snapshotSha256,
    catalogSha256: document.catalog.sha256, provider, status: report.status, reason: report.reason, usage: report.usage,
    evidence, trace: report.trace.map(({ operationId, tool, evidenceId }) => ({ operationId, tool, evidenceId })), checklist,
  });
}

export async function publishFormalAudit(tx: Transaction, task: TaskRow, scope: ExecutionScope, prepared: PreparedAudit,
  report: FormalAuditReport, provider: FormalAuditResult['provider'], signal: AbortSignal, allowRepair: boolean, allowVerification: boolean) {
  signal.throwIfAborted();
  const [pointer] = await tx.select().from(formalAuditRuntime).where(eq(formalAuditRuntime.runId, scope.runId));
  if (!pointer || pointer.checkpointId !== report.checkpointId || pointer.inputSha256 !== prepared.sha256) throw new DomainError('unavailable');
  if (prepared.continuation) await requireCurrentLinkedHealthRepair(tx, task, prepared.continuation);
  const document = auditResult(prepared, report, provider);
  const hash = sha256(JSON.stringify(document));
  await tx.insert(formalAuditResults).values({ runId: scope.runId, inputSha256: prepared.sha256, checkpointId: pointer.checkpointId,
    finalizedFence: scope.fence, workerId: scope.workerId, sha256: hash, document });
  const completed = document.status === 'completed';
  const blockedReproduction = completed && Boolean(document.checklist?.findings.length) && Boolean(await readLinkedHealthBasis(tx, task));
  const handoff = completed && !blockedReproduction ? await prepareFormalRepairInput(tx, task, scope) : undefined;
  const findings = handoff?.document.findingIds.length ?? 0;
  const next = allowRepair && findings > 0 ? 'repair_pending'
    : allowVerification && completed && findings === 0 && !blockedReproduction ? 'verification_pending' : null;
  const reason = next ?? (blockedReproduction ? 'operations_reproduction_unavailable' : completed ? 'audit_ready' : 'audit_needs_human');
  await tx.update(runRuntime).set({ reason, resumePending: false, waitingForTaskId: null }).where(eq(runRuntime.runId, scope.runId));
  await appendEvent(tx, task, 'task.audit_recorded', next ? 'running' : completed && !blockedReproduction ? 'waiting_input' : 'needs_human', {
    workerId: scope.workerId, reason, audit: { runId: scope.runId, auditResultSha256: hash },
  });
  if (!next) await clearSlot(tx);
  signal.throwIfAborted();
  return next ?? 'settled';
}

export class FormalAuditService {
  constructor(private readonly database: Database) {}

  async get(identity: VerifiedIdentity, taskId: string, locale: Locale) {
    parseInput(idSchema, taskId);
    return this.database.db.transaction(async tx => {
      const actor = await requireActor(tx, identity);
      const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for('share');
      if (!task) throw new DomainError('not_found');
      await requireProject(tx, actor, task.projectId);
      const [current] = await tx.select({ runId: taskRuns.id, runtimeReason: runRuntime.reason,
        inputSha256: formalAuditInputs.sha256, pointerId: formalAuditRuntime.checkpointId, row: formalAuditResults }).from(taskRuns)
        .innerJoin(runRuntime, eq(runRuntime.runId, taskRuns.id))
        .leftJoin(formalAuditInputs, eq(formalAuditInputs.runId, taskRuns.id))
        .leftJoin(formalAuditRuntime, eq(formalAuditRuntime.runId, taskRuns.id))
        .leftJoin(formalAuditResults, eq(formalAuditResults.runId, taskRuns.id))
        .where(and(eq(taskRuns.taskId, taskId), eq(taskRuns.generation, task.generation)));
      if (!current) throw new DomainError('unavailable');
      const base = { taskId, runId: current.runId, locale };
      const { row } = current;
      if (!row) {
        const unavailable = current.runtimeReason === 'audit_failed';
        return formalAuditDtoSchema.parse({ ...base, status: unavailable ? 'unavailable' : 'pending', result: null,
          message: translate(locale, unavailable ? 'reason.audit_failed' : 'audit.pending') });
      }
      const result = formalAuditResultSchema.parse(row.document);
      if (result.taskId !== taskId || result.runId !== current.runId || result.projectId !== task.projectId || result.generation !== task.generation
        || result.inputSha256 !== current.inputSha256 || result.checkpointId !== current.pointerId || sha256(JSON.stringify(result)) !== row.sha256) {
        throw new Error('formal_audit_result_integrity');
      }
      return formalAuditDtoSchema.parse({ ...base, status: 'recorded', sha256: row.sha256, recordedAt: row.createdAt.toISOString(), result,
        message: agentText(locale).reason[result.reason] });
    });
  }
}
