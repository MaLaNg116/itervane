import { z } from 'zod';
import { localeSchema, taskEventReasonSchema } from './i18n.js';
import { sha256Schema } from './inspection.js';
import {
  operationsLogObservationSchema, operationsMetricObservationSchema, operationsRequestBindingSchema, whiskersObservationSchema,
} from './operations.js';
import { idSchema, taskStateSchema } from './primitives.js';
import { ociDigestSchema } from './qualified-standard-image.js';

export const operationsDiagnosisInputSchema = z.strictObject({
  version: z.literal(1), taskId: idSchema, runId: idSchema, generation: z.int().positive(),
  locale: localeSchema, requestSha256: sha256Schema, request: operationsRequestBindingSchema,
});
export type OperationsDiagnosisInput = z.infer<typeof operationsDiagnosisInputSchema>;

export const operationsDiagnosisSections = ['container', 'release', 'logs', 'metrics'] as const;
export const operationsDiagnosisSectionSchema = z.enum(operationsDiagnosisSections);
export type OperationsDiagnosisSection = z.infer<typeof operationsDiagnosisSectionSchema>;

const verifiedRelease = z.strictObject({
  operationId: idSchema, manifestDigest: ociDigestSchema, verifiedAt: z.iso.datetime({ precision: 3 }),
});
const releaseEvidence = z.strictObject({ current: verifiedRelease, previous: verifiedRelease.nullable() })
  .refine(evidence => !evidence.previous || evidence.previous.operationId !== evidence.current.operationId
    && evidence.previous.verifiedAt <= evidence.current.verifiedAt, 'Previous release must precede the current release');
const observation = { kind: z.literal('operations_section'), proofSha256: sha256Schema };
export const operationsDiagnosisObservationSchema = z.discriminatedUnion('section', [
  z.strictObject({ ...observation, section: z.literal('container'), result: whiskersObservationSchema }),
  z.strictObject({ ...observation, section: z.literal('release'), result: releaseEvidence }),
  z.strictObject({ ...observation, section: z.literal('logs'), result: operationsLogObservationSchema }),
  z.strictObject({ ...observation, section: z.literal('metrics'), result: operationsMetricObservationSchema }),
]);
export type OperationsDiagnosisObservation = z.infer<typeof operationsDiagnosisObservationSchema>;

export const operationsHypothesisCodes = ['application_error', 'release_regression', 'memory_pressure'] as const;
export const operationsRecommendationCodes = ['continue_observation', 'review_restart', 'review_rollback', 'investigate_code', 'human_review'] as const;
export const operationsMemoryPressureThreshold = 85;
const evidenceIds = z.array(sha256Schema).min(1).max(operationsDiagnosisSections.length)
  .refine(ids => ids.length === new Set(ids).size, 'Evidence references must be unique');
export const finishOperationsInputSchema = z.strictObject({
  hypotheses: z.array(z.strictObject({ code: z.enum(operationsHypothesisCodes), evidenceIds })).max(operationsHypothesisCodes.length),
  recommendation: z.strictObject({ code: z.enum(operationsRecommendationCodes), evidenceIds }),
});
export const operationsDiagnosisResultSchema = finishOperationsInputSchema.extend({
  facts: z.array(z.strictObject({ section: operationsDiagnosisSectionSchema, evidenceId: sha256Schema, proofSha256: sha256Schema }))
    .min(2).max(operationsDiagnosisSections.length),
  previousReleaseOperationId: idSchema.nullable(),
}).refine(result => {
  const sections = new Set(result.facts.map(fact => fact.section));
  const ids = new Set(result.facts.map(fact => fact.evidenceId));
  return sections.size === result.facts.length && sections.has('container') && sections.has('release')
    && ids.size === result.facts.length
    && [...result.hypotheses, result.recommendation].every(item => item.evidenceIds.every(id => ids.has(id)))
    && (result.previousReleaseOperationId !== null) === (result.recommendation.code === 'review_rollback');
}, 'Diagnosis requires scoped facts, valid references and a rollback reference when applicable');
export type OperationsDiagnosisResult = z.infer<typeof operationsDiagnosisResultSchema>;

export const operationsDiagnosisReceiptSchema = z.strictObject({
  version: z.literal(1), taskId: idSchema, runId: idSchema, fence: z.int().positive(),
  requestSha256: sha256Schema, inputSha256: sha256Schema, providerSha256: sha256Schema, bindingSha256: sha256Schema,
  checkpointId: z.string().min(1).max(128), observationSha256: sha256Schema,
  usage: z.strictObject({ turns: z.int().positive(), toolCalls: z.int().positive(), tokens: z.int().nonnegative() }),
  reads: z.array(z.strictObject({ section: operationsDiagnosisSectionSchema, operationId: sha256Schema, readSha256: sha256Schema }))
    .min(2).max(operationsDiagnosisSections.length),
  result: operationsDiagnosisResultSchema,
}).refine(receipt => receipt.usage.toolCalls === receipt.reads.length && receipt.result.facts.length === receipt.reads.length
  && receipt.reads.every((read, index) => read.section === receipt.result.facts[index]?.section)
  && new Set(receipt.reads.map(read => read.operationId)).size === receipt.reads.length,
'Recorded reads must match the diagnosis facts and tool budget');
export type OperationsDiagnosisReceipt = z.infer<typeof operationsDiagnosisReceiptSchema>;

const privateScope = { containerId: true, serverId: true } as const;
const evidenceBinding = { evidenceId: sha256Schema, proofSha256: sha256Schema };
const publicMetrics = z.discriminatedUnion('status', [
  operationsMetricObservationSchema.options[0].omit(privateScope), operationsMetricObservationSchema.options[1].omit(privateScope),
]);
const diagnosisFactView = z.discriminatedUnion('section', [
  z.strictObject({ ...evidenceBinding, section: z.literal('container'), result: whiskersObservationSchema.omit(privateScope) }),
  z.strictObject({ ...evidenceBinding, section: z.literal('release'), result: releaseEvidence }),
  z.strictObject({ ...evidenceBinding, section: z.literal('logs'), result: z.strictObject(operationsLogObservationSchema.shape).omit(privateScope)
    .refine(log => log.warningLines <= log.lines && log.errorLines <= log.lines, 'Log signals exceed the observed lines') }),
  z.strictObject({ ...evidenceBinding, section: z.literal('metrics'), result: publicMetrics }),
]);

const displayLabel = { message: z.string().min(1).max(320) };
const diagnosisView = z.strictObject({
  receiptSha256: sha256Schema,
  hypotheses: z.array(finishOperationsInputSchema.shape.hypotheses.element.extend(displayLabel)).max(operationsHypothesisCodes.length),
  recommendation: finishOperationsInputSchema.shape.recommendation.extend(displayLabel),
  previousReleaseOperationId: idSchema.nullable(),
  facts: z.array(diagnosisFactView).min(2).max(operationsDiagnosisSections.length),
});

export const operationsObservationViewSchema = z.strictObject({
  version: z.literal(1), taskId: idSchema, runId: idSchema, taskVersion: z.int().min(1).max(2_147_483_647),
  applicationId: idSchema, environmentId: idSchema, releaseOperationId: idSchema,
  state: taskStateSchema, observation: whiskersObservationSchema.pick({ state: true, observedAt: true }).extend({
    stateLabel: z.string().min(1).max(120), receiptSha256: sha256Schema,
  }).nullable(),
  diagnosis: diagnosisView.optional(),
  message: z.string().min(1).max(320), reason: taskEventReasonSchema.nullable(),
  reasonMessage: z.string().min(1).max(320).nullable(), locale: localeSchema,
}).refine(view => (view.state === 'succeeded') === (view.observation !== null) && (!view.diagnosis || view.state === 'succeeded'),
'Completed observation evidence is required');

export type OperationsObservationView = z.infer<typeof operationsObservationViewSchema>;
