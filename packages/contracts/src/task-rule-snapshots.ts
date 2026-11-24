import { z } from 'zod';
import { localeSchema } from './i18n.js';
import { sha256Schema } from './inspection.js';
import { ruleIdSchema } from './preaudit.js';
import { idSchema } from './primitives.js';

export const ruleSnapshotPurposeSchema = z.enum(['delivery', 'operations']);
export type RuleSnapshotPurpose = z.infer<typeof ruleSnapshotPurposeSchema>;

const publishedRuleReference = z.strictObject({
  packageId: idSchema, packageKey: ruleIdSchema, versionId: idSchema, kind: z.enum(['design_skill', 'code_rule', 'runbook']),
  versionSha256: sha256Schema, reviewSha256: sha256Schema, sequence: z.int().min(1).max(2_147_483_647),
});
export const taskRuleSnapshotSchema = z.strictObject({
  version: z.literal(1), taskId: idSchema, projectId: idSchema, purpose: ruleSnapshotPurposeSchema,
  entries: publishedRuleReference.array().max(32),
}).refine(({ purpose, entries }) => new Set(entries.map(item => item.packageId)).size === entries.length
  && entries.every(item => (purpose === 'operations') === (item.kind === 'runbook'))
  && entries.every((item, index) => !index || entries[index - 1]!.packageKey < item.packageKey));
export type TaskRuleSnapshot = z.infer<typeof taskRuleSnapshotSchema>;

export const taskRuleSnapshotViewSchema = z.strictObject({
  taskId: idSchema, locale: localeSchema, message: z.string(), snapshot: z.strictObject({
    sha256: sha256Schema, document: taskRuleSnapshotSchema, recordedAt: z.iso.datetime(),
  }).nullable(),
});
