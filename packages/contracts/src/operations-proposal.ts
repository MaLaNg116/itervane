import { z } from 'zod';
import { sha256Schema } from './inspection.js';
import { operationsRequestBindingSchema } from './operations.js';
import { idSchema } from './primitives.js';
import { ociDigestSchema } from './qualified-standard-image.js';

const rollbackRelease = z.strictObject({
  operationId: idSchema, manifestDigest: ociDigestSchema, configDigest: ociDigestSchema, proofSha256: sha256Schema,
});
const operationsProposalAction = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('restart') }),
  z.strictObject({ kind: z.literal('rollback'), restore: rollbackRelease }),
]);

export const freezeOperationsProposalSchema = z.strictObject({ diagnosisSha256: sha256Schema });

export const operationsProposalSchema = z.strictObject({
  version: z.literal(1),
  diagnosis: z.strictObject({ taskId: idSchema, runId: idSchema, sha256: sha256Schema, observedAt: z.iso.datetime({ precision: 3 }) }),
  target: operationsRequestBindingSchema, targetProofSha256: sha256Schema,
  proposedBy: idSchema, grantId: idSchema, action: operationsProposalAction,
  validUntil: z.iso.datetime({ precision: 3 }),
}).refine(proposal => proposal.action.kind !== 'rollback'
  || (proposal.action.restore.operationId !== proposal.target.releaseOperationId
    && proposal.action.restore.manifestDigest !== proposal.target.manifestDigest),
'Rollback requires a different verified release');

export type OperationsProposal = z.infer<typeof operationsProposalSchema>;
