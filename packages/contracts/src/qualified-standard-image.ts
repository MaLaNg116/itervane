import { z } from 'zod';
import { scannerDatabaseSchema, sha256Schema } from './inspection.js';

export const ociDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const ociArchiveByteLimit = 200 * 1024 * 1024;
export const qualifiedImageArchiveSchema = z.strictObject({
  format: z.literal('oci-layout-tar'), sha256: sha256Schema, bytes: z.int().positive().max(ociArchiveByteLimit),
});
export type QualifiedImageArchive = z.infer<typeof qualifiedImageArchiveSchema>;

export const qualifiedOciArchiveVerificationSchema = z.strictObject({
  kind: z.literal('archive_verified'), version: z.literal(1), runnerImageSha256: sha256Schema, archive: qualifiedImageArchiveSchema,
});
export type QualifiedOciArchiveVerification = z.infer<typeof qualifiedOciArchiveVerificationSchema>;
const imageFindingSchema = z.strictObject({
  class: z.enum(['os-pkgs', 'lang-pkgs']),
  advisory: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  package: z.string().regex(/^[A-Za-z0-9@][A-Za-z0-9+@._:/-]{0,215}$/),
  version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9+~.:_-]{0,127}$/),
  severity: z.enum(['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
});
export const qualifiedImageScanSchema = z.strictObject({
  scanner: z.literal('trivy'), version: z.literal('0.76.2'),
  imageDigest: ociDigestSchema, configDigest: ociDigestSchema,
  policySha256: sha256Schema, database: scannerDatabaseSchema, reportSha256: sha256Schema,
  osPackages: z.int().min(1).max(5_000), npmPackages: z.int().min(1).max(15_000),
  findings: z.array(imageFindingSchema).max(2_000),
});

const binding = z.strictObject({
  version: z.literal(1), ociInputsSha256: sha256Schema, runtimeInputsSha256: sha256Schema,
});
export const qualifiedStandardImageProofSchema = z.discriminatedUnion('status', [
  binding.extend({
    status: z.literal('scanned'), platform: z.literal('linux/amd64'),
    manifestDigest: ociDigestSchema, configDigest: ociDigestSchema,
    baseManifestDigest: ociDigestSchema, appLayerDigest: ociDigestSchema,
    runtimeLayerSha256: sha256Schema, scan: qualifiedImageScanSchema, archive: qualifiedImageArchiveSchema.optional(),
  }).refine(proof => proof.scan.imageDigest === proof.manifestDigest && proof.scan.configDigest === proof.configDigest),
  binding.extend({
    status: z.literal('blocked'),
    code: z.enum(['image_inputs', 'runtime_projection', 'image_compose', 'image_scan']),
  }),
]);
export type QualifiedStandardImageProof = z.infer<typeof qualifiedStandardImageProofSchema>;
