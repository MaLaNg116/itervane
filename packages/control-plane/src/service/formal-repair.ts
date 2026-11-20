import { eq } from 'drizzle-orm';
import { formalAuditInputSchema, formalAuditResultSchema, formalRepairInputSchema } from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { formalAuditInputs, formalAuditResults, formalRepairInputs } from '../persistence/schema.js';
import type { ExecutionScope, TaskRow } from '../runtime/authority.js';
import type { Transaction } from './access.js';
import { DomainError } from './errors.js';

// The caller holds the current authorized execution lease for this run.
export async function prepareFormalRepairInput(tx: Transaction, task: TaskRow, scope: ExecutionScope) {
  const [current] = await tx.select({ input: formalAuditInputs, audit: formalAuditResults, stored: formalRepairInputs })
    .from(formalAuditResults).innerJoin(formalAuditInputs, eq(formalAuditInputs.runId, formalAuditResults.runId))
    .leftJoin(formalRepairInputs, eq(formalRepairInputs.runId, formalAuditResults.runId)).where(eq(formalAuditResults.runId, scope.runId));
  if (!current) throw new DomainError('unavailable');

  const input = formalAuditInputSchema.parse(current.input.document);
  const audit = formalAuditResultSchema.parse(current.audit.document);
  const checklist = audit.checklist;
  if (audit.status !== 'completed' || checklist?.coverage !== 'complete' || checklist.hypotheses.length) throw new DomainError('unavailable');
  if (task.id !== scope.taskId || scope.generation !== task.generation || audit.generation !== task.generation
    || audit.taskId !== task.id || audit.projectId !== task.projectId || audit.runId !== scope.runId || audit.locale !== task.locale
    || input.taskId !== task.id || input.projectId !== task.projectId || input.runId !== scope.runId || input.generation !== task.generation
    || input.locale !== task.locale || input.dataClass !== task.dataClass || input.source.repositoryId !== task.repositoryId || input.source.commit !== task.commit
    || current.input.sha256 !== sha256(JSON.stringify(input)) || current.audit.sha256 !== sha256(JSON.stringify(audit))
    || audit.inputSha256 !== current.input.sha256 || audit.checkpointId !== current.audit.checkpointId
    || audit.inspectionSha256 !== input.inspection.receiptSha256 || audit.snapshotSha256 !== input.inspection.snapshotSha256
    || audit.catalogSha256 !== input.catalog.sha256) throw new Error('formal_repair_audit_integrity');

  const document = formalRepairInputSchema.parse({
    version: 1, taskId: task.id, runId: scope.runId, projectId: task.projectId, generation: scope.generation,
    source: input.source, dataClass: input.dataClass, locale: input.locale, inspection: input.inspection,
    audit: { inputSha256: current.input.sha256, resultSha256: current.audit.sha256, checkpointId: audit.checkpointId },
    catalogSha256: audit.catalogSha256, findingIds: checklist.findings.map(item => item.id),
  });
  const hash = sha256(JSON.stringify(document));
  if (current.stored) {
    const previous = formalRepairInputSchema.parse(current.stored.document);
    if (current.stored.sha256 !== hash || hash !== sha256(JSON.stringify(previous))) throw new Error('formal_repair_input_integrity');
    return { sha256: hash, document: previous };
  }
  await tx.insert(formalRepairInputs).values({ runId: scope.runId, preparedFence: scope.fence, workerId: scope.workerId, sha256: hash, document });
  return { sha256: hash, document };
}
