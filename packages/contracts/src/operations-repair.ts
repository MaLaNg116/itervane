import { z } from 'zod';
import { taskDtoSchema } from './control-plane.js';
import { localeSchema } from './i18n.js';
import { sha256Schema } from './inspection.js';
import { operationsHealthBindingSchema } from './operations-health.js';
import { idSchema, sourceRefSchema, taskStateSchema } from './primitives.js';

export const freezeOperationsRepairSchema = z.strictObject({ diagnosisSha256: sha256Schema });
export const confirmOperationsRepairSchema = z.strictObject({
  fingerprint: sha256Schema, commit: sourceRefSchema.shape.commit.optional(), locale: localeSchema.default('en'),
});

export const operationsRepairProposalSchema = z.strictObject({
  version: z.literal(1),
  diagnosis: z.strictObject({ taskId: idSchema, runId: idSchema, sha256: sha256Schema }),
  target: operationsHealthBindingSchema,
  incident: z.strictObject({ id: idSchema, sampleSequence: z.int().positive() }).nullable(),
  source: z.strictObject({
    candidateId: idSchema, candidateSha256: sha256Schema, releaseTaskId: idSchema,
    git: sourceRefSchema, dataClass: taskDtoSchema.shape.dataClass, originSha256: sha256Schema,
    originalSnapshotSha256: sha256Schema, deployedSnapshotSha256: sha256Schema, patchSha256: sha256Schema.nullable(),
  }).refine(source => (source.originalSnapshotSha256 === source.deployedSnapshotSha256) === (source.patchSha256 === null)),
  proposedBy: idSchema, grantId: idSchema, validUntil: z.iso.datetime({ precision: 3 }),
});

export type OperationsRepairProposal = z.infer<typeof operationsRepairProposalSchema>;

export const operationsHealthRegressionSchema = z.strictObject({
  proposalId: idSchema, diagnosisSha256: sha256Schema, publicationProofSha256: sha256Schema,
  incidentId: idSchema, sampleSequence: z.int().positive(), sampleEvidenceSha256: sha256Schema,
});

const linkedRepairProposalView = z.strictObject({
  id: idSchema, fingerprint: sha256Schema, validUntil: z.iso.datetime({ precision: 3 }),
  status: z.enum(['pending', 'confirmed', 'expired', 'stale']), message: z.string(), mayConfirm: z.boolean(),
  incidentId: idSchema.nullable(),
  target: operationsHealthBindingSchema.pick({ environmentId: true, releaseOperationId: true, restoreExecutionId: true }),
  source: sourceRefSchema.extend({ requiresMaterializedCommit: z.boolean() }),
  linkedTask: z.strictObject({ taskId: idSchema, runId: idSchema, state: taskStateSchema, stateLabel: z.string() }).nullable(),
}).refine(item => (item.status === 'confirmed') === (item.linkedTask !== null) && (!item.mayConfirm || item.status === 'pending'));

export const operationsRepairViewSchema = z.strictObject({
  taskId: idSchema, runId: idSchema, taskVersion: z.int().positive(), locale: localeSchema,
  draft: freezeOperationsRepairSchema.nullable(), proposal: linkedRepairProposalView.nullable(),
}).refine(({ draft, proposal }) => draft === null || proposal === null);
export type OperationsRepairView = z.infer<typeof operationsRepairViewSchema>;
