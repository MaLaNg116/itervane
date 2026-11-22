import { z } from 'zod';
import { sha256Schema } from './inspection.js';
import { idSchema } from './primitives.js';
import { ociDigestSchema } from './qualified-standard-image.js';

export const operationsHealthBindingSchema = z.strictObject({
  version: z.literal(1),
  environmentId: idSchema, projectId: idSchema, applicationId: idSchema,
  targetRevision: z.int().positive(), mappingSha256: sha256Schema,
  enrollmentRevision: z.int().positive(), enrollmentSha256: sha256Schema,
  releaseOperationId: idSchema, restoreExecutionId: idSchema.nullable(), publicationProofSha256: sha256Schema,
  containerId: sha256Schema, manifestDigest: ociDigestSchema, configDigest: ociDigestSchema,
});
export type OperationsHealthBinding = z.infer<typeof operationsHealthBindingSchema>;

export const operationsHealthSignalSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('healthy'), evidenceSha256: sha256Schema }),
  z.strictObject({ status: z.literal('unhealthy'), evidenceSha256: sha256Schema,
    reason: z.enum(['runtime_stopped', 'application_unhealthy']) }),
  z.strictObject({ status: z.literal('unavailable'), evidenceSha256: sha256Schema,
    reason: z.enum(['ingress_unavailable', 'probe_identity', 'komodo_unavailable', 'target_changed']) }),
]);
export type OperationsHealthSignal = z.infer<typeof operationsHealthSignalSchema>;
