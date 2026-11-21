import { z } from 'zod';
import { formalVerificationCompletionSchema, formalVerificationEvidenceSchema, verificationImageFindingCountsSchema } from './formal-verification-evidence.js';
import { localeSchema } from './i18n.js';
import { sha256Schema } from './inspection.js';
import { idSchema } from './primitives.js';
import { ociDigestSchema } from './qualified-standard-image.js';

const fields = { runId: idSchema, generation: z.int().positive(), message: z.string().min(1).max(320) };
const waiting = z.strictObject({
  ...fields, status: z.enum(['pending', 'reconciling', 'unavailable', 'cancel_requested', 'cancelled']),
});
const recorded = z.strictObject({
  ...fields, status: z.literal('recorded'), recordedAt: z.iso.datetime(),
  outcome: z.union([formalVerificationCompletionSchema.shape.outcome, z.literal('requires_human')]),
  resultSha256: sha256Schema, receiptSha256: sha256Schema, candidateManifestSha256: sha256Schema,
  source: formalVerificationEvidenceSchema.shape.source,
  build: formalVerificationEvidenceSchema.shape.build,
  baseline: formalVerificationEvidenceSchema.shape.baseline,
  image: z.discriminatedUnion('status', [
    z.strictObject({ status: z.enum(['not_requested', 'not_reached', 'blocked']) }),
    z.strictObject({
      status: z.literal('scanned'), manifestDigest: ociDigestSchema,
      findings: verificationImageFindingCountsSchema,
    }),
  ]),
});

export const verificationViewSchema = z.strictObject({
  version: z.literal(1), taskId: idSchema, locale: localeSchema, current: z.discriminatedUnion('status', [waiting, recorded]),
  previous: recorded.nullable(),
}).refine(({ current, previous }) => !previous || (previous.runId !== current.runId && previous.generation + 1 === current.generation));

export type VerificationView = z.infer<typeof verificationViewSchema>;
export type RecordedVerificationView = z.infer<typeof recorded>;
