import { z } from 'zod';
import { verificationBaselineFailuresSchema, verificationComparisonCountsSchema } from './formal-verification-evidence.js';
import { sha256Schema } from './inspection.js';
import { operationsHealthRegressionSchema } from './operations-repair.js';
import { idSchema, sourceRefSchema } from './primitives.js';

const retryFailureSchema = z.discriminatedUnion('outcome', [
  verificationComparisonCountsSchema.extend({ outcome: z.literal('source_findings') })
    .refine(failure => failure.introduced > 0 || failure.remaining > 0),
  z.strictObject({
    outcome: z.literal('checks_failed'),
    buildCode: z.string().regex(/^[a-z_]{1,48}$/).nullable(),
    checks: verificationBaselineFailuresSchema,
  }).refine(failure => failure.buildCode !== null || failure.checks.length > 0),
]);

export const formalRepairRetryContextSchema = z.strictObject({
  previousRunId: idSchema, verificationResultSha256: sha256Schema, receiptSha256: sha256Schema,
  candidateManifestSha256: sha256Schema, patchSha256: sha256Schema, operationId: idSchema,
  patchShape: z.strictObject({ files: z.int().min(1).max(8), removedBytes: z.int().nonnegative(), replacementBytes: z.int().nonnegative() }),
  failure: retryFailureSchema,
});
export type FormalRepairRetryContext = z.infer<typeof formalRepairRetryContextSchema>;

const repairContinuation = z.strictObject({
  version: z.literal(1), taskId: idSchema, projectId: idSchema, runId: idSchema, generation: z.int().min(2),
  source: sourceRefSchema, baseSnapshotSha256: sha256Schema, catalogSha256: sha256Schema,
  verificationProfileSha256: sha256Schema, repairPolicySha256: sha256Schema,
});
export const formalRepairRetrySchema = repairContinuation.extend({
  previous: formalRepairRetryContextSchema,
}).refine(retry => retry.runId !== retry.previous.previousRunId && retry.baseSnapshotSha256 !== retry.previous.candidateManifestSha256);
export type FormalRepairRetry = z.infer<typeof formalRepairRetrySchema>;

export const linkedHealthRepairContextSchema = z.strictObject({
  previousRunId: idSchema, verificationResultSha256: sha256Schema, receiptSha256: sha256Schema,
  subjectManifestSha256: sha256Schema, regression: operationsHealthRegressionSchema,
});
export type LinkedHealthRepairContext = z.infer<typeof linkedHealthRepairContextSchema>;
export const linkedHealthRepairSchema = repairContinuation.extend({
  kind: z.literal('linked_health'), generation: z.literal(2), previous: linkedHealthRepairContextSchema,
}).refine(repair => repair.runId !== repair.previous.previousRunId && repair.baseSnapshotSha256 === repair.previous.subjectManifestSha256);
export const formalRepairContinuationSchema = z.union([formalRepairRetrySchema, linkedHealthRepairSchema]);
export type FormalRepairContinuation = z.infer<typeof formalRepairContinuationSchema>;
export type LinkedHealthRepair = z.infer<typeof linkedHealthRepairSchema>;
