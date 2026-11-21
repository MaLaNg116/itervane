import { z } from 'zod';
import { repairCandidateReceiptSchema, repairCommandByteLimit, repairObservationSchema } from './formal-repair.js';
import { sha256Schema, sourceContentLimits } from './inspection.js';
import { qualifiedInspectionScopeSchema, qualifiedRunnerRejectionSchema } from './qualified-inspection.js';

const uuid = z.uuidv4();
const gitId = z.string().regex(/^[a-f0-9]{40}$/);
const repairScope = qualifiedInspectionScopeSchema.omit({ planSha256: true }).extend({
  operation: z.enum(['apply_repair', 'observe_repair']), operationId: uuid,
  repairInputSha256: sha256Schema, baseSnapshotSha256: sha256Schema, commandSha256: sha256Schema,
  commandBytes: z.int().positive().max(repairCommandByteLimit),
});
export const qualifiedRepairScopeSchema = repairScope.extend({ operation: z.literal('apply_repair') });
export const qualifiedRepairObservationScopeSchema = repairScope.extend({ operation: z.literal('observe_repair') });
export const qualifiedRepairRequestSchema = qualifiedRepairScopeSchema.extend({ origin: z.string().min(1).max(768) });
export const qualifiedRepairObservationRequestSchema = qualifiedRepairObservationScopeSchema.extend({ origin: z.string().min(1).max(768) });
export const qualifiedGuestRepairIssueSchema = z.enum(['repair-base', 'repair-scope', 'repair-precondition', 'repair-invalid', 'repair-integrity']);
const qualifiedGuestRepairSource = z.strictObject({
  runId: uuid, repositoryId: uuid, commit: gitId, tree: gitId, manifestSha256: sha256Schema,
  files: z.int().min(1).max(sourceContentLimits.maxFiles), commandSha256: sha256Schema,
  readOnly: z.literal(true), offline: z.literal(true),
});
export const qualifiedGuestRepairProofSchema = qualifiedGuestRepairSource.extend({ candidate: repairCandidateReceiptSchema })
  .refine(proof => proof.candidate.baseSnapshotSha256 === proof.manifestSha256);
export const qualifiedGuestRepairObservationSchema = qualifiedGuestRepairSource.extend({ observation: repairObservationSchema })
  .refine(proof => proof.observation.baseSnapshotSha256 === proof.manifestSha256);
const receiptFields = {
  domainId: uuid, imageSha256: sha256Schema, originSha256: sha256Schema, commitSha256: sha256Schema,
  cleanupConfirmed: z.literal(true), sessionVerified: z.literal(true),
};
const rejectedRepair = qualifiedRunnerRejectionSchema.extend({ issue: qualifiedGuestRepairIssueSchema.optional() })
  .refine(result => result.issue === undefined || (result.code === 'job_failed' && result.cleanup === 'confirmed'));
export const qualifiedRepairResponseSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('repair_receipt'), scope: qualifiedRepairScopeSchema, ...receiptFields, snapshot: qualifiedGuestRepairProofSchema,
  }),
  rejectedRepair,
]);
export const qualifiedRepairObservationResponseSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('repair_observation'), scope: qualifiedRepairObservationScopeSchema, ...receiptFields,
    snapshot: qualifiedGuestRepairObservationSchema,
  }),
  rejectedRepair,
]);
export type QualifiedRepairRequest = z.infer<typeof qualifiedRepairRequestSchema>;
export type QualifiedRepairResponse = z.infer<typeof qualifiedRepairResponseSchema>;
export type QualifiedRepairReceipt = Extract<QualifiedRepairResponse, { kind: 'repair_receipt' }>;
export type QualifiedRepairObservationRequest = z.infer<typeof qualifiedRepairObservationRequestSchema>;
export type QualifiedRepairObservationResponse = z.infer<typeof qualifiedRepairObservationResponseSchema>;
export type QualifiedRepairObservationReceipt = Extract<QualifiedRepairObservationResponse, { kind: 'repair_observation' }>;
