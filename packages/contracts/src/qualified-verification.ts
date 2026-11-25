import { z } from 'zod';
import { repairCandidateManifestSchema, repairCommandByteLimit, repairCommandSchema } from './formal-repair.js';
import { formalVerificationInputSchema } from './formal-verification.js';
import { sha256Schema, sourceContentLimits, sourceManifestSchema } from './inspection.js';
import { publishedCodeRuleSetSchema } from './published-code-rule-set.js';
import { publishedCodeScanEvidenceSchema } from './published-code-scan.js';
import { qualifiedStandardBuildProofSchema } from './qualified-standard-build.js';
import {
  publishedInspectionCommandByteLimit, qualifiedInspectionScopeSchema, qualifiedInspectionSnapshotSchema,
  qualifiedRunnerRejectionSchema, qualifiedScanReportsSchema,
} from './qualified-inspection.js';

export const verificationCommandByteLimit = repairCommandByteLimit + 8192;
export const verificationProofByteLimit = 8 * 1024 * 1024;
export const publishedVerificationCommandByteLimit = verificationCommandByteLimit + publishedInspectionCommandByteLimit;
export const publishedVerificationProofByteLimit = 16 * 1024 * 1024;
export const verificationCommandSchema = z.strictObject({
  input: formalVerificationInputSchema,
  repair: repairCommandSchema.nullable(),
  publishedCodeRules: publishedCodeRuleSetSchema.optional(),
});

const scope = qualifiedInspectionScopeSchema.omit({ planSha256: true }).extend({
  operation: z.literal('verify_source'), verificationInputSha256: sha256Schema,
  baseSnapshotSha256: sha256Schema, targetManifestSha256: sha256Schema,
  runnerImageSha256: sha256Schema, scannerInputsSha256: sha256Schema,
  buildProfileSha256: sha256Schema.optional(),
  runStandardBaseline: z.literal(true).optional(),
  healthFollowup: z.literal(true).optional(),
  ociInputsSha256: sha256Schema.optional(),
  retainStandardImage: z.literal(true).optional(),
  publishedCodeRuleSetSha256: sha256Schema.optional(),
  commandSha256: sha256Schema, commandBytes: z.int().positive().max(publishedVerificationCommandByteLimit),
});
export const qualifiedVerificationRequestSchema = scope.extend({ origin: z.string().min(1).max(768) })
  .refine(request => (!request.healthFollowup || request.runStandardBaseline === true)
    && (Boolean(request.publishedCodeRuleSetSha256) || request.commandBytes <= verificationCommandByteLimit));
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
  publishedCode: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('original'), manifest: sourceManifestSchema, scan: publishedCodeScanEvidenceSchema }),
    z.strictObject({ kind: z.literal('repair'), manifest: repairCandidateManifestSchema, scan: publishedCodeScanEvidenceSchema }),
  ]).optional(),
}).refine(proof => (!proof.target || proof.target.manifestSha256 !== proof.manifestSha256)
  && (!proof.publishedCode || (proof.publishedCode.kind === 'repair') === Boolean(proof.target)));

export const qualifiedVerificationResponseSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('verification_receipt'), scope, domainId: z.uuidv4(),
    imageSha256: sha256Schema, originSha256: sha256Schema, commitSha256: sha256Schema,
    cleanupConfirmed: z.literal(true), sessionVerified: z.literal(true), snapshot: qualifiedGuestVerificationProofSchema,
  }).refine(receipt => Boolean(receipt.scope.publishedCodeRuleSetSha256) === Boolean(receipt.snapshot.publishedCode)),
  qualifiedRunnerRejectionSchema,
]);
export type QualifiedVerificationResponse = z.infer<typeof qualifiedVerificationResponseSchema>;
export type QualifiedVerificationReceipt = Extract<QualifiedVerificationResponse, { kind: 'verification_receipt' }>;
