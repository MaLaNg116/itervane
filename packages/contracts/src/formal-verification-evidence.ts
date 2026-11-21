import { z } from 'zod';
import { sha256Schema } from './inspection.js';
import { idSchema, sourceRefSchema } from './primitives.js';
import { ociDigestSchema, qualifiedImageArchiveSchema } from './qualified-standard-image.js';

const count = z.int().min(0).max(4_000);
export const verificationComparisonCountsSchema = z.strictObject({ introduced: count, resolved: count, remaining: count });
export const verificationImageFindingCountsSchema = z.strictObject({ critical: count, high: count, medium: count, low: count, unknown: count });
export const verificationBaselineFailuresSchema = z.array(z.strictObject({
  id: z.enum(['health', 'version', 'synthetic_data', 'page', 'compiled_asset']),
  code: z.enum(['unexpected_status', 'unexpected_content', 'timeout', 'unavailable', 'missing_page_asset']),
  statusCode: z.int().min(100).max(599).nullable(),
})).max(5);
const pending = z.strictObject({ status: z.enum(['not_requested', 'not_reached']) });
const stopped = z.strictObject({
  status: z.enum(['blocked', 'failed']), code: z.string().regex(/^[a-z_]{1,48}$/),
});
export const formalVerificationEvidenceSchema = z.strictObject({
  version: z.literal(1),
  binding: z.strictObject({
    taskId: idSchema, runId: idSchema, projectId: idSchema, generation: z.int().positive(),
    source: sourceRefSchema, verificationInputSha256: sha256Schema, receiptSha256: sha256Schema,
    subjectManifestSha256: sha256Schema,
  }),
  source: z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('compared'), ...verificationComparisonCountsSchema.shape }),
    z.strictObject({
      status: z.literal('unavailable'), scanner: z.enum(['gitleaks', 'trivy']),
      reason: z.enum(['report_binding', 'incomplete_coverage', 'profile_mismatch']),
    }),
  ]),
  build: z.discriminatedUnion('status', [
    pending, stopped, z.strictObject({ status: z.literal('built'), distSha256: sha256Schema }),
  ]),
  baseline: z.discriminatedUnion('status', [
    pending,
    z.strictObject({ status: z.literal('blocked'), code: z.string().regex(/^[a-z_]{1,48}$/) }),
    z.strictObject({
      status: z.enum(['passed', 'failed']), baselineSha256: sha256Schema, runtimeInputsSha256: sha256Schema,
      failures: verificationBaselineFailuresSchema,
    }).refine(baseline => (baseline.status === 'passed') === (baseline.failures.length === 0)),
  ]),
  image: z.discriminatedUnion('status', [
    pending,
    z.strictObject({ status: z.literal('blocked'), code: z.string().regex(/^[a-z_]{1,48}$/) }),
    z.strictObject({
      status: z.literal('scanned'), manifestDigest: ociDigestSchema, configDigest: ociDigestSchema,
      databaseSha256: sha256Schema, scanReportSha256: sha256Schema, scanPolicySha256: sha256Schema,
      osPackages: z.int().min(1).max(5_000), npmPackages: z.int().min(1).max(15_000),
      findings: verificationImageFindingCountsSchema,
      archive: qualifiedImageArchiveSchema.nullable(),
    }),
  ]),
}).refine(({ baseline, image }) => (image.status !== 'scanned' && image.status !== 'blocked') || baseline.status === 'passed');
export type FormalVerificationEvidence = z.infer<typeof formalVerificationEvidenceSchema>;

export const verificationSections = ['source', 'build', 'baseline', 'image'] as const;
export const verificationSectionSchema = z.enum(verificationSections);

export const finishVerificationInputSchema = z.strictObject({
  summary: z.string().trim().min(1).max(480),
  evidenceIds: z.array(sha256Schema).min(3).max(4).refine(ids => new Set(ids).size === ids.length),
  followUps: z.array(z.strictObject({
    evidenceId: sha256Schema, detail: z.string().trim().min(1).max(320),
  })).max(4),
});

export const formalVerificationCompletionSchema = finishVerificationInputSchema.extend({
  receiptSha256: sha256Schema, candidateManifestSha256: sha256Schema,
  outcome: z.enum(['observed', 'checks_failed', 'source_findings', 'incomplete']),
  source: formalVerificationEvidenceSchema.shape.source,
  unverified: z.array(verificationSectionSchema).max(4),
});
