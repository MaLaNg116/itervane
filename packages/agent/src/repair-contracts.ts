import {
  idSchema, repairCandidateReceiptSchema, repairObservationSchema, repairPatchLimits, repairTemplateIdSchema,
  sha256Schema, sourceContentLimits, type FormalAuditResult,
} from '@itervane/contracts';
import { z } from 'zod';

const selected = z.array(sha256Schema).min(1).max(4).refine(values => new Set(values).size === values.length);
const targetIndex = z.int().min(0).max(repairPatchLimits.files - 1);
const offset = z.int().min(0).max(sourceContentLimits.maxFileBytes);
const edit = z.strictObject({ startByte: offset, endByte: offset, replacement: z.string().max(8_192) })
  .refine(value => value.startByte < value.endByte || (value.startByte === value.endByte && value.replacement.length > 0));
export const repairToolInputs = {
  read_repair_targets: z.strictObject({ findingIds: selected }),
  apply_repair_template: z.strictObject({ observationId: sha256Schema, targetIndex, templateId: repairTemplateIdSchema }),
  apply_repair_patch: z.strictObject({ observationId: sha256Schema,
    targets: z.array(z.strictObject({ targetIndex, edits: z.array(edit).min(1).max(repairPatchLimits.editsPerFile) }))
      .min(1).max(repairPatchLimits.files).refine(values => new Set(values.map(value => value.targetIndex)).size === values.length),
  }),
};
export const repairToolNames = ['read_repair_targets', 'apply_repair_template', 'apply_repair_patch'] as const;
export const repairActionSchema = z.enum(['apply_repair_template', 'apply_repair_patch']);
export const repairFailureCodeSchema = z.enum([
  'invalid_proposal', 'cleanup_unproven', 'not_ready', 'job_failed',
  'repair-base', 'repair-scope', 'repair-precondition', 'repair-invalid', 'repair-integrity',
]);
export type RepairFailureCode = z.infer<typeof repairFailureCodeSchema>;

export const repairEvidenceDataSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('repair_targets'), actionSha256: sha256Schema, receiptSha256: sha256Schema, observation: repairObservationSchema }),
  z.strictObject({ kind: z.literal('repair_candidate'), action: repairActionSchema, actionSha256: sha256Schema,
    receiptSha256: sha256Schema, observationId: sha256Schema, candidate: repairCandidateReceiptSchema }),
  z.strictObject({ kind: z.literal('repair_failure'), action: z.enum(repairToolNames), actionSha256: sha256Schema, code: repairFailureCodeSchema }),
]);
export type RepairEvidenceData = z.infer<typeof repairEvidenceDataSchema>;
export const finishRepairInputSchema = z.strictObject({ summary: z.string().trim().min(1).max(480), evidenceId: sha256Schema });
export const formalRepairCompletionSchema = finishRepairInputSchema.extend({
  operationId: idSchema, receiptSha256: sha256Schema, candidateManifestSha256: sha256Schema,
});
export type RepairFindingSummary = Pick<NonNullable<FormalAuditResult['checklist']>['findings'][number],
  'id' | 'ruleId' | 'severity' | 'certainty' | 'scanner'>;
