import { and, eq, ne } from 'drizzle-orm';
import {
  qualifiedInspectionJobScopeSchema, qualifiedInspectionResponseSchema,
  type InspectionPlan, type QualifiedInspectionReceipt,
} from '@itervane/contracts';
import { sha256, verifyQualifiedInspectionReceipt } from '@itervane/runner';
import { inspectionAttempts } from '../persistence/schema.js';
import type { Transaction } from './access.js';

export type InspectionAttempt = typeof inspectionAttempts.$inferSelect;

export async function currentInspectionAttempt(tx: Transaction, runId: string) {
  const [attempt] = await tx.select().from(inspectionAttempts)
    .where(and(eq(inspectionAttempts.runId, runId), ne(inspectionAttempts.state, 'closed')));
  return attempt;
}

export function inspectionScope(attempt: InspectionAttempt) {
  return qualifiedInspectionJobScopeSchema.parse({
    version: 1, requestId: attempt.requestId, taskId: attempt.taskId, runId: attempt.runId,
    projectId: attempt.projectId, repositoryId: attempt.repositoryId, generation: attempt.generation,
    fence: attempt.fence, planSha256: attempt.planSha256, workspaceSha256: attempt.workspaceSha256, commit: attempt.commit,
    ...(attempt.materializedFrom ? { materializedFrom: attempt.materializedFrom } : {}),
  });
}

export function verifyInspectionEvidence(raw: unknown, attempt: InspectionAttempt, plan: InspectionPlan) {
  const receipt = qualifiedInspectionResponseSchema.parse(raw);
  if (receipt.kind !== 'receipt') throw new Error('inspection_receipt_missing');
  verifyQualifiedInspectionReceipt(receipt, inspectionScope(attempt), attempt, plan.scanners);
  return { receipt, sha256: sha256(JSON.stringify(receipt)) };
}

export function readInspectionEvidence(attempt: InspectionAttempt, plan: { sha256: string; document: InspectionPlan }) {
  if (attempt.state !== 'recorded' || attempt.planSha256 !== plan.sha256) throw new Error('inspection_evidence_binding');
  const evidence = verifyInspectionEvidence(attempt.receipt, attempt, plan.document);
  if (evidence.sha256 !== attempt.receiptSha256) throw new Error('inspection_evidence_integrity');
  return evidence;
}

export function inspectionCoverage(receipt: QualifiedInspectionReceipt) {
  return receipt.snapshot.reports.every(report => report.status === 'completed') ? 'complete' as const : 'incomplete' as const;
}
