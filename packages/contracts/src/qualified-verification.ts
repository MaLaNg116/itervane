import { z } from 'zod';
import { repairCommandByteLimit, repairCommandSchema } from './formal-repair.js';
import { formalVerificationInputSchema } from './formal-verification.js';
import { sha256Schema, sourceContentLimits } from './inspection.js';
import { qualifiedStandardBuildProofSchema } from './qualified-standard-build.js';
import {
  qualifiedInspectionScopeSchema, qualifiedInspectionSnapshotSchema, qualifiedRunnerRejectionSchema, qualifiedScanReportsSchema,
} from './qualified-inspection.js';

export const verificationCommandByteLimit = repairCommandByteLimit + 8192;
export const verificationProofByteLimit = 8 * 1024 * 1024;
export const verificationCommandSchema = z.strictObject({
  input: formalVerificationInputSchema,
  repair: repairCommandSchema.nullable(),
});

const scope = qualifiedInspectionScopeSchema.omit({ planSha256: true }).extend({
  operation: z.literal('verify_source'), verificationInputSha256: sha256Schema,
  baseSnapshotSha256: sha256Schema, targetManifestSha256: sha256Schema,
  runnerImageSha256: sha256Schema, scannerInputsSha256: sha256Schema,
  buildProfileSha256: sha256Schema.optional(),
  commandSha256: sha256Schema, commandBytes: z.int().positive().max(verificationCommandByteLimit),
});
export const qualifiedVerificationRequestSchema = scope.extend({ origin: z.string().min(1).max(768) });
export type QualifiedVerificationRequest = z.infer<typeof qualifiedVerificationRequestSchema>;

export const qualifiedGuestVerificationProofSchema = qualifiedInspectionSnapshotSchema.extend({
  verificationInputSha256: sha256Schema, commandSha256: sha256Schema,
  reports: qualifiedScanReportsSchema,
  target: z.strictObject({
    manifestSha256: sha256Schema,
    totalBytes: z.int().min(0).max(sourceContentLimits.maxSourceBytes),
    patchSha256: sha256Schema,
    reports: qualifiedScanReportsSchema,
  }).nullable(),
  build: qualifiedStandardBuildProofSchema.optional(),
}).refine(proof => !proof.target || proof.target.manifestSha256 !== proof.manifestSha256);

export const qualifiedVerificationResponseSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('verification_receipt'), scope, domainId: z.uuidv4(),
    imageSha256: sha256Schema, originSha256: sha256Schema, commitSha256: sha256Schema,
    cleanupConfirmed: z.literal(true), sessionVerified: z.literal(true), snapshot: qualifiedGuestVerificationProofSchema,
  }),
  qualifiedRunnerRejectionSchema,
]);
export type QualifiedVerificationResponse = z.infer<typeof qualifiedVerificationResponseSchema>;
export type QualifiedVerificationReceipt = Extract<QualifiedVerificationResponse, { kind: 'verification_receipt' }>;
