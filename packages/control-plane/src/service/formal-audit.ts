import { eq } from 'drizzle-orm';
import { formalAuditInputSchema } from '@itervane/contracts';
import { catalogSnapshot, validCatalog } from '@itervane/rules';
import { sha256 } from '@itervane/runner';
import { formalAuditInputs } from '../persistence/schema.js';
import type { ExecutionScope, TaskRow } from '../runtime/authority.js';
import type { Transaction } from './access.js';
import { DomainError } from './errors.js';
import { currentInspectionAttempt, inspectionCoverage, readInspectionEvidence } from './inspection-evidence.js';
import { readInspectionPlan } from './inspections.js';

// The current Worker calls this under its authorized lease before yielding to the audit stage.
export async function prepareFormalAuditInput(tx: Transaction, task: TaskRow, scope: ExecutionScope) {
  const plan = await readInspectionPlan(tx, task, scope.runId);
  const attempt = await currentInspectionAttempt(tx, scope.runId);
  if (!plan || attempt?.state !== 'recorded' || !attempt.workspaceSha256) throw new DomainError('unavailable');
  const evidence = readInspectionEvidence(attempt, plan);
  if (inspectionCoverage(evidence.receipt) !== 'complete') throw new DomainError('unavailable');

  const [stored] = await tx.select().from(formalAuditInputs).where(eq(formalAuditInputs.runId, scope.runId));
  const previous = stored ? formalAuditInputSchema.parse(stored.document) : null;
  const catalog = previous?.catalog ?? catalogSnapshot();
  if (!validCatalog(catalog)) throw new Error('formal_audit_catalog_integrity');
  const document = formalAuditInputSchema.parse({
    version: 1, taskId: task.id, runId: scope.runId, projectId: task.projectId, generation: scope.generation,
    source: { repositoryId: task.repositoryId, commit: task.commit }, dataClass: task.dataClass, locale: task.locale,
    purposeSha256: sha256(task.purpose), catalog,
    inspection: { requestId: attempt.requestId, receiptSha256: evidence.sha256, planSha256: plan.sha256,
      snapshotSha256: evidence.receipt.snapshot.manifestSha256 },
  });
  const hash = sha256(JSON.stringify(document));
  if (stored && previous) {
    if (stored.sha256 !== hash || stored.sha256 !== sha256(JSON.stringify(previous))) throw new Error('formal_audit_input_integrity');
    return { sha256: stored.sha256, document: previous };
  }
  await tx.insert(formalAuditInputs).values({ runId: scope.runId, taskId: task.id, projectId: task.projectId,
    inspectionRequestId: attempt.requestId, preparedFence: scope.fence, workerId: scope.workerId, sha256: hash, document });
  return { sha256: hash, document };
}
