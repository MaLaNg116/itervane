import { z } from 'zod';
import { formalRepairInputSchema } from './formal-repair.js';
import { sha256Schema } from './inspection.js';
import { idSchema } from './primitives.js';

export const verificationProfileSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  policySha256: sha256Schema,
  baselineSha256: sha256Schema,
  scannerInputsSha256: sha256Schema,
  runnerImageSha256: sha256Schema,
  buildProfileSha256: sha256Schema.optional(),
  runStandardBaseline: z.literal(true).optional(),
  ociInputsSha256: sha256Schema.optional(),
  retainStandardImage: z.literal(true).optional(),
}).refine(profile => (!profile.runStandardBaseline || Boolean(profile.buildProfileSha256))
  && (!profile.ociInputsSha256 || profile.runStandardBaseline === true)
  && (!profile.retainStandardImage || Boolean(profile.ociInputsSha256)));
export type VerificationProfile = z.infer<typeof verificationProfileSchema>;

export const standardVerificationProfileSchema = verificationProfileSchema.safeExtend({
  buildProfileSha256: sha256Schema,
  runStandardBaseline: z.literal(true),
  ociInputsSha256: sha256Schema,
  retainStandardImage: z.literal(true),
});
export type StandardVerificationProfile = z.infer<typeof standardVerificationProfileSchema>;

const subjectSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('original'), manifestSha256: sha256Schema }),
  z.strictObject({
    kind: z.literal('repair'), manifestSha256: sha256Schema, operationId: idSchema, requestId: idSchema,
    inputSha256: sha256Schema, resultSha256: sha256Schema, checkpointId: idSchema,
    receiptSha256: sha256Schema, commandSha256: sha256Schema, patchSha256: sha256Schema,
  }),
]);

const healthRegressionSchema = z.strictObject({
  proposalId: idSchema, diagnosisSha256: sha256Schema, publicationProofSha256: sha256Schema,
  incidentId: idSchema, sampleSequence: z.int().positive(), sampleEvidenceSha256: sha256Schema,
});

export const formalVerificationInputSchema = formalRepairInputSchema.omit({ findingIds: true }).extend({
  profile: verificationProfileSchema,
  subject: subjectSchema,
  healthRegression: healthRegressionSchema.optional(),
}).refine(({ subject, inspection, profile, healthRegression }) =>
  (subject.kind === 'original') === (subject.manifestSha256 === inspection.snapshotSha256)
  && (!healthRegression || profile.runStandardBaseline === true));
export type FormalVerificationInput = z.infer<typeof formalVerificationInputSchema>;
