import { z } from 'zod';
import { codeRuleValidationProfileSchema } from './code-rule-profile.js';
import { sha256Schema } from './inspection.js';
import { materializedSourceBasisSchema } from './qualified-inspection.js';
import { codeRulePackageSchema, rulePackageReviewRecordSchema } from './rule-packages.js';
import { candidateValidationRecordSchema } from './rule-validation.js';
import { taskRuleSnapshotLimit, taskRuleSnapshotSchema } from './task-rule-snapshots.js';

export const publishedCodeRuleSetSchema = z.strictObject({
  version: z.literal(1),
  snapshot: z.strictObject({ sha256: sha256Schema, document: taskRuleSnapshotSchema }),
  profile: codeRuleValidationProfileSchema,
  rules: z.array(z.strictObject({
    package: codeRulePackageSchema, review: rulePackageReviewRecordSchema, validation: candidateValidationRecordSchema,
  })).max(taskRuleSnapshotLimit),
});
export type PublishedCodeRuleSet = z.infer<typeof publishedCodeRuleSetSchema>;

export const publishedInspectionCommandSchema = z.strictObject({
  version: z.literal(1), rules: publishedCodeRuleSetSchema, materializedFrom: materializedSourceBasisSchema.optional(),
});
