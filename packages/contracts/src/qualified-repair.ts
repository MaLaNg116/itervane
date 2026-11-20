import { z } from 'zod';
import { repairCandidateReceiptSchema, repairCommandByteLimit } from './formal-repair.js';
import { sha256Schema, sourceContentLimits } from './inspection.js';
import { qualifiedInspectionScopeSchema, qualifiedRunnerRejectionSchema } from './qualified-inspection.js';

const uuid = z.uuidv4();
const gitId = z.string().regex(/^[a-f0-9]{40}$/);
export const qualifiedRepairScopeSchema = qualifiedInspectionScopeSchema.omit({ planSha256: true }).extend({
  operation: z.literal('apply_repair'), operationId: uuid,
  repairInputSha256: sha256Schema, baseSnapshotSha256: sha256Schema, commandSha256: sha256Schema,
  commandBytes: z.int().positive().max(repairCommandByteLimit),
});
export const qualifiedRepairRequestSchema = qualifiedRepairScopeSchema.extend({ origin: z.string().min(1).max(768) });
export const qualifiedGuestRepairIssueSchema = z.enum(['repair-base', 'repair-scope', 'repair-precondition', 'repair-invalid', 'repair-integrity']);
export const qualifiedGuestRepairProofSchema = z.strictObject({
  runId: uuid, repositoryId: uuid, commit: gitId, tree: gitId, manifestSha256: sha256Schema,
  files: z.int().min(1).max(sourceContentLimits.maxFiles), commandSha256: sha256Schema,
  readOnly: z.literal(true), offline: z.literal(true), candidate: repairCandidateReceiptSchema,
}).refine(proof => proof.candidate.baseSnapshotSha256 === proof.manifestSha256);
export const qualifiedRepairResponseSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('repair_receipt'), scope: qualifiedRepairScopeSchema, domainId: uuid, imageSha256: sha256Schema,
    originSha256: sha256Schema, commitSha256: sha256Schema,
    cleanupConfirmed: z.literal(true), sessionVerified: z.literal(true), snapshot: qualifiedGuestRepairProofSchema,
  }),
  qualifiedRunnerRejectionSchema.extend({ issue: qualifiedGuestRepairIssueSchema.optional() }),
]).refine(result => result.kind === 'repair_receipt' || result.issue === undefined
  || (result.code === 'job_failed' && result.cleanup === 'confirmed'));
export type QualifiedRepairRequest = z.infer<typeof qualifiedRepairRequestSchema>;
export type QualifiedRepairResponse = z.infer<typeof qualifiedRepairResponseSchema>;
export type QualifiedRepairReceipt = Extract<QualifiedRepairResponse, { kind: 'repair_receipt' }>;
