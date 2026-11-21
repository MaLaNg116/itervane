import { eq } from 'drizzle-orm';
import { formalRepairResultSchema, formalVerificationInputSchema, type FormalVerificationInput, type VerificationProfile } from '@itervane/contracts';
import { sha256, type canonicalVerificationCommand } from '@itervane/runner';
import { formalRepairResults, formalRepairRuntime, formalVerificationInputs } from '../persistence/schema.js';
import type { Transaction } from '../service/access.js';
import { DomainError } from '../service/errors.js';
import { inspectionCoverage } from '../service/inspection-evidence.js';
import { readPublishedRepairCommand } from '../service/repair-result.js';
import { verificationProfileFingerprint } from '../service/repair-retry.js';
import type { ExecutionScope, TaskRow } from './authority.js';
import { repairBasis } from './repair-execution.js';

type Basis = Awaited<ReturnType<typeof repairBasis>>;

type Material = { subject: FormalVerificationInput['subject']; repair: ReturnType<typeof canonicalVerificationCommand>['repair'] };

async function verificationMaterial(tx: Transaction, { input, scan }: Basis): Promise<Material> {
  const { runId, taskId, projectId, generation, locale, source, inspection, audit, findingIds } = input.document;
  if (inspectionCoverage(scan) !== 'complete') throw new DomainError('unavailable');
  const hasFindings = scan.snapshot.reports.some(report => report.findings.length !== 0);
  const [published] = await tx.select({ result: formalRepairResults, checkpointId: formalRepairRuntime.checkpointId })
    .from(formalRepairResults).innerJoin(formalRepairRuntime, eq(formalRepairRuntime.runId, formalRepairResults.runId))
    .where(eq(formalRepairResults.runId, runId));
  if (!hasFindings) {
    if (findingIds.length || published) throw new Error('verification_original_binding');
    return { subject: { kind: 'original', manifestSha256: inspection.snapshotSha256 }, repair: null };
  }
  if (!findingIds.length || !published?.result.requestId) throw new DomainError('unavailable');
  const { result: stored, checkpointId } = published;
  const result = formalRepairResultSchema.parse(stored.document);
  if (result.status !== 'candidate_ready') throw new DomainError('unavailable');
  if (result.runId !== runId || result.taskId !== taskId || result.projectId !== projectId || result.generation !== generation
      || result.locale !== locale || result.checkpointId !== checkpointId || result.checkpointId !== stored.checkpointId
      || result.inputSha256 !== input.sha256 || result.auditResultSha256 !== audit.resultSha256
      || result.baseSnapshotSha256 !== inspection.snapshotSha256 || sha256(JSON.stringify(result)) !== stored.sha256) {
    throw new Error('verification_repair_result_binding');
  }
  const { command, receipt } = await readPublishedRepairCommand(tx, result, published.result.requestId);
  if (receipt.scope.repositoryId !== source.repositoryId || receipt.scope.commit !== source.commit
      || command.workspace.source.repositoryId !== source.repositoryId || command.workspace.source.commit !== source.commit
      || receipt.originSha256 !== scan.originSha256 || receipt.commitSha256 !== scan.commitSha256
      || receipt.snapshot.tree !== scan.snapshot.tree || receipt.snapshot.files !== scan.snapshot.files) {
    throw new Error('verification_repair_source_binding');
  }
  const { operationId, receiptSha256, manifestSha256, patchSha256 } = result.candidate;
  return {
    subject: { kind: 'repair', operationId, requestId: published.result.requestId, inputSha256: result.inputSha256,
      resultSha256: stored.sha256, checkpointId, receiptSha256, manifestSha256, patchSha256, commandSha256: receipt.scope.commandSha256 },
    repair: { workspace: command.workspace, patch: command.patch },
  };
}

// The Worker supplies the trusted profile and holds the current authorized lease in this transaction.
export async function prepareFormalVerificationInput(tx: Transaction, task: TaskRow, scope: ExecutionScope, profile: VerificationProfile) {
  const basis = await repairBasis(tx, task, scope);
  if (basis.input.retry && basis.input.retry.verificationProfileSha256 !== verificationProfileFingerprint(profile)) throw new DomainError('conflict');
  const { subject, repair } = await verificationMaterial(tx, basis);
  const { findingIds: _findingIds, ...base } = basis.input.document;
  const document = formalVerificationInputSchema.parse({ ...base, profile, subject });
  const hash = sha256(JSON.stringify(document));
  const [stored] = await tx.select().from(formalVerificationInputs).where(eq(formalVerificationInputs.runId, scope.runId));
  if (stored) {
    if (stored.sha256 !== hash || sha256(JSON.stringify(formalVerificationInputSchema.parse(stored.document))) !== hash) {
      throw new DomainError('conflict');
    }
  } else {
    await tx.insert(formalVerificationInputs).values({ runId: scope.runId, preparedFence: scope.fence,
      workerId: scope.workerId, sha256: hash, document });
  }
  return { sha256: hash, document, repair, origin: basis.origin, scan: basis.scan };
}
