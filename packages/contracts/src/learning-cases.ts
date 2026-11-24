import { z } from 'zod';
import { listQuerySchema, taskDtoSchema } from './control-plane.js';
import { verificationComparisonCountsSchema } from './formal-verification-evidence.js';
import { localeSchema } from './i18n.js';
import { sha256Schema } from './inspection.js';
import { idSchema } from './primitives.js';

export const learningCaseCategorySchema = z.enum(['resolved_source_findings', 'reproduced_health_failure', 'recovered_stopped_instance']);
const repair = {
  patchSha256: sha256Schema, originalSnapshotSha256: sha256Schema, repairedSnapshotSha256: sha256Schema,
  verificationReceiptSha256: sha256Schema, sourceComparison: verificationComparisonCountsSchema,
};
export const learningCaseFactsSchema = z.discriminatedUnion('category', [
  z.strictObject({ ...repair, category: z.literal('resolved_source_findings') })
    .refine(value => value.sourceComparison.resolved > 0 && value.sourceComparison.introduced === 0),
  z.strictObject({ ...repair, category: z.literal('reproduced_health_failure'), reproductionSha256: sha256Schema,
    originalHealthStatus: z.int().min(400).max(599), repairedHealthStatus: z.literal(200) })
    .refine(value => value.sourceComparison.introduced === 0),
  z.strictObject({
    category: z.literal('recovered_stopped_instance'),
    diagnosisSha256: sha256Schema, proposalSha256: sha256Schema, releaseOperationId: idSchema,
    executionId: idSchema, actionTaskId: idSchema, diagnosisState: z.enum(['exited', 'dead']),
    restartAttempt: z.int().min(1).max(3), result: z.literal('verified_recovered'), sameInstance: z.literal(true),
    healthStatus: z.literal(200), anonymousStatus: z.union([z.literal(401), z.literal(403)]),
  }),
]);
export type LearningCaseFacts = z.infer<typeof learningCaseFactsSchema>;

export const learningCaseDocumentSchema = z.strictObject({
  version: z.literal(1), projectId: idSchema, taskId: idSchema, runId: idSchema, generation: z.int().positive(),
  dataClass: taskDtoSchema.shape.dataClass,
  evidenceSha256: sha256Schema, recordedAt: z.iso.datetime(), facts: learningCaseFactsSchema,
});
export type LearningCaseDocument = z.infer<typeof learningCaseDocumentSchema>;
export const captureLearningCaseSchema = z.strictObject({ runId: idSchema.transform(value => value.toLowerCase()), evidenceSha256: sha256Schema });
export const learningCaseViewSchema = z.strictObject({
  id: idSchema, sha256: sha256Schema, document: learningCaseDocumentSchema,
  locale: localeSchema, title: z.string(), capturedAt: z.iso.datetime(),
});
export const learningCaseCaptureResultSchema = z.strictObject({ item: learningCaseViewSchema, replayed: z.boolean() });
export const learningCaseQuerySchema = listQuerySchema.extend({ category: learningCaseCategorySchema.optional(), before: idSchema.optional() });
export const learningCasesViewSchema = z.strictObject({ items: learningCaseViewSchema.array().max(100), nextBefore: idSchema.nullable() });
