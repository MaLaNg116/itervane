import { z } from 'zod';
import { localeSchema } from './i18n.js';
import { sha256Schema } from './inspection.js';
import { operationsRequestBindingSchema } from './operations.js';
import { idSchema } from './primitives.js';
import { ociDigestSchema } from './qualified-standard-image.js';
import { releaseDecisionDtoSchema, releaseDecisionSchema } from './release.js';

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

const proposalStatus = z.enum(['pending', 'confirmed', 'rejected', 'revoked', 'expired', 'stale']);
const operationKind = z.enum(['restart', 'rollback']);
const releaseSummary = z.strictObject({ operationId: idSchema, manifestDigest: ociDigestSchema });
const shownProposal = z.strictObject({
  id: idSchema, fingerprint: sha256Schema, status: proposalStatus, message: z.string().min(1).max(320),
  kind: operationKind, validUntil: operationsProposalSchema.shape.validUntil,
  current: releaseSummary, restore: releaseSummary.nullable(),
  decisions: z.array(releaseDecisionDtoSchema).max(2), actions: z.array(releaseDecisionSchema).max(2),
}).refine(proposal => (proposal.kind === 'rollback') === (proposal.restore !== null));

export const operationsProposalViewSchema = z.strictObject({
  taskId: idSchema, runId: idSchema, taskVersion: z.int().positive(), locale: localeSchema,
  draft: z.strictObject({ diagnosisSha256: sha256Schema, kind: operationKind }).nullable(),
  proposal: shownProposal.nullable(),
}).refine(view => !(view.draft && view.proposal));

export type OperationsProposalView = z.infer<typeof operationsProposalViewSchema>;
