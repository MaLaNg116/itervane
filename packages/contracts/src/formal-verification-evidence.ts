import { z } from 'zod';
import { sha256Schema } from './inspection.js';
import { idSchema, sourceRefSchema } from './primitives.js';
import { ociDigestSchema, qualifiedImageArchiveSchema } from './qualified-standard-image.js';

const count = z.int().min(0).max(4_000);
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
    z.strictObject({ status: z.literal('compared'), introduced: count, resolved: count, remaining: count }),
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
      failures: z.array(z.strictObject({
        id: z.enum(['health', 'version', 'synthetic_data', 'page', 'compiled_asset']),
        code: z.enum(['unexpected_status', 'unexpected_content', 'timeout', 'unavailable', 'missing_page_asset']),
        statusCode: z.int().min(100).max(599).nullable(),
      })).max(5),
    }).refine(baseline => (baseline.status === 'passed') === (baseline.failures.length === 0)),
  ]),
  image: z.discriminatedUnion('status', [
    pending,
    z.strictObject({ status: z.literal('blocked'), code: z.string().regex(/^[a-z_]{1,48}$/) }),
    z.strictObject({
      status: z.literal('scanned'), manifestDigest: ociDigestSchema, configDigest: ociDigestSchema,
      databaseSha256: sha256Schema, scanReportSha256: sha256Schema, scanPolicySha256: sha256Schema,
      osPackages: z.int().min(1).max(5_000), npmPackages: z.int().min(1).max(15_000),
      findings: z.strictObject({ critical: count, high: count, medium: count, low: count, unknown: count }),
      archive: qualifiedImageArchiveSchema.nullable(),
    }),
  ]),
}).refine(({ baseline, image }) => (image.status !== 'scanned' && image.status !== 'blocked') || baseline.status === 'passed');
export type FormalVerificationEvidence = z.infer<typeof formalVerificationEvidenceSchema>;
