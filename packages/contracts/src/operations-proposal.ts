import { z } from 'zod';
import { localeSchema } from './i18n.js';
import { sha256Schema } from './inspection.js';
import { operationsEnqueueActionSchema, operationsExecutionReceiptSchema, operationsExecutionViewScopeSchema, operationsRequestBindingSchema } from './operations.js';
import { idSchema } from './primitives.js';
import { ociDigestSchema } from './qualified-standard-image.js';
import { komodoReleaseTargetSchema, releaseDecisionDtoSchema, releaseDecisionSchema, releaseKomodoCompletionSchema, releaseRuntimeObservationSchema } from './release.js';

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

export const operationsRestorePlanSchema = z.strictObject({
  version: z.literal(1), environmentId: idSchema,
  targetRevision: operationsRequestBindingSchema.shape.targetRevision, mappingSha256: sha256Schema, rolloutCheckSha256: sha256Schema,
  target: komodoReleaseTargetSchema,
  current: rollbackRelease.extend({ containerId: sha256Schema }),
  restore: rollbackRelease.extend({ publishedVersion: releaseRuntimeObservationSchema.shape.version }),
}).refine(plan => plan.current.operationId !== plan.restore.operationId && plan.current.manifestDigest !== plan.restore.manifestDigest,
'Recovery requires a different verified release');
export type OperationsRestorePlan = z.infer<typeof operationsRestorePlanSchema>;

export const maxOperationsRestoreRecoveryAttempts = 3;
export const operationsRestoreRecoveryFailureSchema = z.enum([
  'missing_update', 'update_failed', 'target_changed', 'update_pending', 'unavailable', 'unhealthy', 'lease_expired',
]);
export type OperationsRestoreRecoveryFailure = z.infer<typeof operationsRestoreRecoveryFailureSchema>;
export const operationsRestoreObservationSchema = z.strictObject({
  update: releaseKomodoCompletionSchema.extend({ success: z.literal(true) }),
  runtime: releaseRuntimeObservationSchema,
});
export const operationsRestoreRecoveryProofSchema = operationsRestoreObservationSchema.extend({
  version: z.literal(1), executionId: idSchema, restoreOperationId: idSchema, planSha256: sha256Schema,
  fence: z.int().positive(), attempt: z.int().min(1).max(maxOperationsRestoreRecoveryAttempts),
});
export type OperationsRestoreRecoveryProof = z.infer<typeof operationsRestoreRecoveryProofSchema>;

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

const verifiedRestore = z.strictObject({
  proofSha256: sha256Schema, version: releaseRuntimeObservationSchema.shape.version, verifiedAt: z.iso.datetime({ precision: 3 }),
});

export const operationsRestoreExecutionViewSchema = operationsExecutionViewScopeSchema.extend({
  execution: operationsExecutionReceiptSchema.extend({
    restore: releaseSummary, nativeUpdateId: releaseKomodoCompletionSchema.shape.updateId.nullable(),
    recovery: z.strictObject({
      state: z.enum(['observing', 'retry', 'manual_review', 'verified']),
      failure: operationsRestoreRecoveryFailureSchema.nullable(), proof: verifiedRestore.nullable(),
    }).refine(recovery => recovery.state === 'verified' ? recovery.proof !== null && recovery.failure === null : recovery.proof === null).nullable(),
  }).nullable(),
  action: operationsEnqueueActionSchema.nullable(),
});
export type OperationsRestoreExecutionView = z.infer<typeof operationsRestoreExecutionViewSchema>;
