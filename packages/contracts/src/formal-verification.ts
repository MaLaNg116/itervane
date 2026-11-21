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
});
export type VerificationProfile = z.infer<typeof verificationProfileSchema>;

const subjectSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('original'), manifestSha256: sha256Schema }),
  z.strictObject({
    kind: z.literal('repair'), manifestSha256: sha256Schema, operationId: idSchema, requestId: idSchema,
    inputSha256: sha256Schema, resultSha256: sha256Schema, checkpointId: idSchema,
    receiptSha256: sha256Schema, commandSha256: sha256Schema, patchSha256: sha256Schema,
  }),
]);

export const formalVerificationInputSchema = formalRepairInputSchema.omit({ findingIds: true }).extend({
  profile: verificationProfileSchema,
  subject: subjectSchema,
}).refine(({ subject, inspection }) => subject.kind === 'original'
  ? subject.manifestSha256 === inspection.snapshotSha256
  : subject.manifestSha256 !== inspection.snapshotSha256);
export type FormalVerificationInput = z.infer<typeof formalVerificationInputSchema>;
