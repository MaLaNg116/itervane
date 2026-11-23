import { agentText, type FormalRepairReport } from '@itervane/agent';
import { formalRepairDtoSchema, formalRepairPatchDtoSchema, formalRepairResultSchema, idSchema, qualifiedRepairResponseSchema,
  repairCommandSchema, sha256Schema, translate, type FormalRepairResult, type Locale } from '@itervane/contracts';
import { canonicalRepairCommand, sha256 } from '@itervane/runner';
import { and, eq } from 'drizzle-orm';
import type { VerifiedIdentity } from '../auth/identity.js';
import type { Database } from '../persistence/database.js';
import { formalAuditResults, formalRepairAttempts, formalRepairInputs, formalRepairOperations, formalRepairResults, formalRepairRuntime,
  runRuntime, taskRuns, tasks } from '../persistence/schema.js';
import { appendEvent, clearSlot, type ExecutionScope, type TaskRow } from '../runtime/authority.js';
import { requireActor, requireProject, type Transaction } from './access.js';
import { DomainError, parseInput } from './errors.js';
import { isRepairableAudit, prepareFormalRepairInput } from './formal-repair.js';

async function recordedCandidate(tx: Transaction, runId: string, inputSha256: string, report: FormalRepairReport) {
  const selection = report.formalRepair;
  if (!selection) throw new Error('formal_repair_candidate_missing');
  const entry = report.evidence.find(evidence => evidence.id === selection.evidenceId);
  const data = entry?.data;
  if (data?.kind !== 'repair_candidate' || data.receiptSha256 !== selection.receiptSha256
      || data.candidate.operationId !== selection.operationId || data.candidate.candidateManifestSha256 !== selection.candidateManifestSha256) {
    throw new Error('formal_repair_candidate_evidence');
  }
  const [stored] = await tx.select({ operation: formalRepairOperations, attempt: formalRepairAttempts })
    .from(formalRepairOperations).innerJoin(formalRepairAttempts, eq(formalRepairAttempts.operationId, formalRepairOperations.operationId))
    .where(and(eq(formalRepairOperations.runId, runId), eq(formalRepairOperations.operationId, selection.operationId),
      eq(formalRepairAttempts.state, 'recorded')));
  const receipt = qualifiedRepairResponseSchema.safeParse(stored?.attempt.receipt).data;
  if (!stored || receipt?.kind !== 'repair_receipt' || stored.operation.inputSha256 !== inputSha256
      || stored.attempt.receiptSha256 !== selection.receiptSha256 || sha256(JSON.stringify(receipt)) !== selection.receiptSha256
      || JSON.stringify(receipt.snapshot.candidate) !== JSON.stringify(data.candidate)
      || !report.trace.some(item => item.evidenceId === selection.evidenceId && item.tool === data.action
        && item.operationId === stored.operation.callKeySha256)) throw new Error('formal_repair_recorded_receipt_binding');
  const { operationId, patchSha256, candidateManifestSha256, changes } = receipt.snapshot.candidate;
  return { requestId: stored.attempt.requestId, candidate: { summary: selection.summary, evidenceId: selection.evidenceId, operationId,
    receiptSha256: selection.receiptSha256, patchSha256, manifestSha256: candidateManifestSha256, changes,
  } };
}

export async function publishFormalRepair(tx: Transaction, task: TaskRow, scope: ExecutionScope, report: FormalRepairReport,
  provider: FormalRepairResult['provider'], signal: AbortSignal, allowVerification = false) {
  signal.throwIfAborted();
  const input = await prepareFormalRepairInput(tx, task, scope);
  const [pointer] = await tx.select().from(formalRepairRuntime).where(eq(formalRepairRuntime.runId, scope.runId));
  if (!pointer || pointer.checkpointId !== report.checkpointId || pointer.inputSha256 !== input.sha256
      || report.runId !== scope.runId || report.origin !== 'formal_repair' || report.role !== 'repair'
      || (report.status !== 'completed' && report.status !== 'requires_human')) throw new DomainError('unavailable');
  const candidate = report.status === 'completed' ? await recordedCandidate(tx, scope.runId, input.sha256, report) : null;
  const previous = input.retry?.previous;
  const repeated = candidate && previous && 'candidateManifestSha256' in previous
    && candidate.candidate.manifestSha256 === previous.candidateManifestSha256;
  const result = repeated ? null : candidate;
  const document = formalRepairResultSchema.parse({
    version: 1, taskId: task.id, runId: scope.runId, projectId: task.projectId, generation: scope.generation, locale: task.locale,
    inputSha256: input.sha256, checkpointId: pointer.checkpointId, auditResultSha256: input.document.audit.resultSha256,
    baseSnapshotSha256: input.document.inspection.snapshotSha256, provider, releaseEligible: report.releaseEligible, usage: report.usage,
    status: result ? 'candidate_ready' : 'requires_human', reason: repeated ? 'repair_no_progress' : report.reason, candidate: result?.candidate ?? null,
  });
  const hash = sha256(JSON.stringify(document));
  await tx.insert(formalRepairResults).values({ runId: scope.runId, inputSha256: input.sha256, checkpointId: pointer.checkpointId,
    requestId: result?.requestId ?? null, finalizedFence: scope.fence, workerId: scope.workerId, sha256: hash, document });
  const next = result && allowVerification ? 'verification_pending' as const : 'settled' as const;
  const reason = next === 'verification_pending' ? next
    : result ? 'repair_ready' : document.reason === 'repair_reconciling' ? 'repair_reconciling' : 'repair_needs_human';
  await tx.update(runRuntime).set({ reason, resumePending: false, waitingForTaskId: null }).where(eq(runRuntime.runId, scope.runId));
  await appendEvent(tx, task, 'task.repair_recorded', next === 'verification_pending' ? 'running' : result ? 'waiting_input' : 'needs_human', {
    workerId: scope.workerId, reason, repair: { runId: scope.runId, repairResultSha256: hash },
  });
  if (next === 'settled') await clearSlot(tx);
  signal.throwIfAborted();
  return { document, sha256: hash, next };
}

export async function readPublishedRepairCommand(tx: Transaction, result: Extract<FormalRepairResult, { status: 'candidate_ready' }>, requestId: string) {
  const [entry] = await tx.select({ operation: formalRepairOperations, attempt: formalRepairAttempts })
    .from(formalRepairAttempts).innerJoin(formalRepairOperations, eq(formalRepairAttempts.operationId, formalRepairOperations.operationId))
    .where(and(eq(formalRepairAttempts.requestId, requestId), eq(formalRepairAttempts.state, 'recorded'),
      eq(formalRepairOperations.runId, result.runId)));
  const receipt = qualifiedRepairResponseSchema.safeParse(entry?.attempt.receipt).data;
  const candidate = result.candidate;
  if (!entry || receipt?.kind !== 'repair_receipt' || entry.operation.operationId !== candidate.operationId
      || entry.operation.inputSha256 !== result.inputSha256 || entry.attempt.receiptSha256 !== candidate.receiptSha256
      || sha256(JSON.stringify(receipt)) !== candidate.receiptSha256) throw new Error('formal_repair_export_receipt');
  const { workspace, patch } = repairCommandSchema.parse(JSON.parse(entry.operation.command));
  const command = canonicalRepairCommand(workspace, patch);
  const { scope, snapshot } = receipt;
  const fact = snapshot.candidate;
  if (command.bytes.toString('utf8') !== entry.operation.command || sha256(command.bytes) !== entry.operation.commandSha256
      || scope.commandSha256 !== entry.operation.commandSha256 || scope.commandBytes !== command.bytes.length
      || scope.requestId !== requestId || scope.operationId !== candidate.operationId || scope.repairInputSha256 !== result.inputSha256
      || scope.runId !== result.runId || scope.taskId !== result.taskId || scope.projectId !== result.projectId || scope.generation !== result.generation
      || command.patchSha256 !== candidate.patchSha256 || command.workspaceSha256 !== fact.workspaceSha256
      || fact.patchSha256 !== candidate.patchSha256 || fact.candidateManifestSha256 !== candidate.manifestSha256
      || JSON.stringify(fact.changes) !== JSON.stringify(candidate.changes)
      || command.patch.baseSnapshotSha256 !== result.baseSnapshotSha256 || snapshot.manifestSha256 !== result.baseSnapshotSha256) {
    throw new Error('formal_repair_export_integrity');
  }
  return { command, receipt };
}

export class FormalRepairService {
  constructor(private readonly database: Database) {}

  private async current(tx: Transaction, identity: VerifiedIdentity, taskId: string, write = false) {
    const actor = await requireActor(tx, identity);
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for('share');
    if (!task) throw new DomainError('not_found');
    await requireProject(tx, actor, task.projectId, write);
    const [current] = await tx.select({ runId: taskRuns.id, reason: runRuntime.reason, input: formalRepairInputs.document,
      inputSha256: formalRepairInputs.sha256, audit: formalAuditResults.document, checkpointId: formalRepairRuntime.checkpointId, row: formalRepairResults })
      .from(taskRuns).innerJoin(runRuntime, eq(runRuntime.runId, taskRuns.id))
      .leftJoin(formalRepairInputs, eq(formalRepairInputs.runId, taskRuns.id))
      .leftJoin(formalAuditResults, eq(formalAuditResults.runId, taskRuns.id))
      .leftJoin(formalRepairRuntime, eq(formalRepairRuntime.runId, taskRuns.id))
      .leftJoin(formalRepairResults, eq(formalRepairResults.runId, taskRuns.id))
      .where(and(eq(taskRuns.taskId, taskId), eq(taskRuns.generation, task.generation)));
    if (!current) throw new DomainError('unavailable');
    const { row } = current;
    const result = row ? formalRepairResultSchema.parse(row.document) : null;
    if (row && result && (result.taskId !== taskId || result.runId !== current.runId || result.projectId !== task.projectId
      || result.generation !== task.generation || result.locale !== task.locale || result.inputSha256 !== current.inputSha256
      || result.checkpointId !== current.checkpointId || result.auditResultSha256 !== current.input?.audit.resultSha256
      || result.baseSnapshotSha256 !== current.input?.inspection.snapshotSha256 || sha256(JSON.stringify(result)) !== row.sha256)) {
      throw new Error('formal_repair_result_integrity');
    }
    return { task, current, result };
  }

  async get(identity: VerifiedIdentity, taskId: string, locale: Locale) {
    parseInput(idSchema, taskId);
    return this.database.db.transaction(async tx => {
      const { task, current, result } = await this.current(tx, identity, taskId);
      const base = { taskId, runId: current.runId, locale };
      if (result && current.row) return formalRepairDtoSchema.parse({ ...base, status: 'recorded', resumeAvailable: false,
        result, sha256: current.row.sha256, recordedAt: current.row.createdAt.toISOString(), message: agentText(locale).reason[result.reason],
      });
      const { reason } = current;
      const resumeAvailable = task.state === 'waiting_input' && (reason === 'audit_ready' || reason === 'repair_deferred')
        && isRepairableAudit(current.audit);
      const message = reason === 'repair_failed' ? 'reason.repair_failed' : reason === 'repair_deferred' ? 'reason.repair_deferred'
        : reason === 'repair_pending' ? 'reason.repair_pending' : 'repair.pending';
      return formalRepairDtoSchema.parse({ ...base, status: reason === 'repair_failed' || reason === 'repair_deferred' ? 'unavailable' : 'pending',
        resumeAvailable, result: null, message: translate(locale, message),
      });
    });
  }

  async exportPatch(identity: VerifiedIdentity, taskId: string, rawExpectedSha256: unknown) {
    parseInput(idSchema, taskId);
    const expectedSha256 = parseInput(sha256Schema, rawExpectedSha256);
    return this.database.db.transaction(async tx => {
      const { current, result } = await this.current(tx, identity, taskId, true);
      if (result?.status !== 'candidate_ready' || !current.row?.requestId) throw new DomainError('unsupported_state');
      if (current.row.sha256 !== expectedSha256) throw new DomainError('conflict');
      const { command } = await readPublishedRepairCommand(tx, result, current.row.requestId);
      return formalRepairPatchDtoSchema.parse({ taskId, runId: result.runId, resultSha256: current.row.sha256,
        patchSha256: command.patchSha256, patch: command.patch,
      });
    });
  }
}
