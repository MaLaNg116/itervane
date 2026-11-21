import { z } from 'zod';
import { sha256Schema } from './inspection.js';
import { qualifiedStandardBaselineProofSchema } from './qualified-standard-baseline.js';

export const standardBuildProfileSchema = z.strictObject({
  version: z.literal(1), platform: z.literal('linux/amd64'),
  packageSha256: sha256Schema, lockSha256: sha256Schema, dependenciesSha256: sha256Schema,
  nodeSha256: sha256Schema, npmVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  baselineSha256: sha256Schema, viteConfigSha256: sha256Schema,
  baselineProbeSha256: sha256Schema.optional(),
  ociInputsSha256: sha256Schema.optional(),
});
export type StandardBuildProfile = z.infer<typeof standardBuildProfileSchema>;

const binding = z.strictObject({
  version: z.literal(1), runId: z.uuidv4(), verificationInputSha256: sha256Schema,
  subjectManifestSha256: sha256Schema, buildProfileSha256: sha256Schema, baselineSha256: sha256Schema,
});
export const standardBuildDispatchSchema = binding.extend({ projectionSha256: sha256Schema });

export const qualifiedStandardBuildProofSchema = z.discriminatedUnion('status', [
  standardBuildDispatchSchema.extend({
    status: z.literal('built'), isolationVerified: z.literal(true),
    dist: z.strictObject({
      sha256: sha256Schema, files: z.int().min(1).max(1024), bytes: z.int().min(1).max(64 * 1024 * 1024),
    }),
    baseline: qualifiedStandardBaselineProofSchema.optional(),
  }),
  binding.extend({
    status: z.literal('blocked'),
    code: z.enum(['profile_unavailable', 'profile_mismatch', 'scan_incomplete', 'source_layout']),
  }),
  standardBuildDispatchSchema.extend({
    status: z.literal('failed'),
    code: z.enum(['boundary_denied', 'input_invalid', 'offline_install', 'bundle_failed', 'deadline', 'output_invalid']),
  }),
]);
export type QualifiedStandardBuildProof = z.infer<typeof qualifiedStandardBuildProofSchema>;
