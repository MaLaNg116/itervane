import { z } from 'zod';
import { codeRuleLanguageSchema, codeRuleValidationProfileSchema, ruleSampleFailureSchema } from './code-rule-profile.js';
import { sha256Schema, sourceContentLimits } from './inspection.js';
import { ruleIdSchema } from './preaudit.js';
import { idSchema, sourceRefSchema } from './primitives.js';
export { codeRuleLanguageSchema, type CodeRuleLanguage } from './code-rule-profile.js';

const batchBasis = z.strictObject({
  language: codeRuleLanguageSchema, configSha256: sha256Schema, targetsSha256: sha256Schema,
  fileCount: z.int().min(0).max(sourceContentLimits.maxFiles),
});
const basis = z.strictObject({
  version: z.literal(1), taskId: idSchema, projectId: idSchema, source: sourceRefSchema,
  manifestSha256: sha256Schema, snapshotSha256: sha256Schema, ruleSetSha256: sha256Schema,
  profile: codeRuleValidationProfileSchema, batches: z.array(batchBasis).max(codeRuleLanguageSchema.options.length),
});
export type PublishedCodeScanBasis = z.infer<typeof basis>;

export const publishedCodeScanReportByteLimit = 4 * 1024 * 1024;
export const publishedCodeScanMatchLimit = 2_000;
export const publishedCodeScanPositionSchema = z.strictObject({
  line: z.int().min(1).max(sourceContentLimits.maxFileBytes + 1),
  col: z.int().min(1).max(sourceContentLimits.maxFileBytes + 1),
  offset: z.int().min(0).max(sourceContentLimits.maxFileBytes),
});
const finding = z.strictObject({
  ruleKey: ruleIdSchema, path: z.string().min(1).max(240),
  start: publishedCodeScanPositionSchema, end: publishedCodeScanPositionSchema,
});
export type PublishedCodeScanFinding = z.infer<typeof finding>;
const report = z.discriminatedUnion('status', [
  z.strictObject({ language: codeRuleLanguageSchema, status: z.literal('checked'), reportSha256: sha256Schema,
    findings: z.array(finding).max(publishedCodeScanMatchLimit) }),
  z.strictObject({ language: codeRuleLanguageSchema, status: z.literal('not_applicable') }),
  z.strictObject({ language: codeRuleLanguageSchema, status: z.literal('unavailable'), reason: ruleSampleFailureSchema }),
]);
export type PublishedCodeScanReport = z.infer<typeof report>;

export const publishedCodeScanEvidenceSchema = z.strictObject({
  sha256: sha256Schema,
  document: z.strictObject({ basis, reports: z.array(report).max(codeRuleLanguageSchema.options.length) }),
});
