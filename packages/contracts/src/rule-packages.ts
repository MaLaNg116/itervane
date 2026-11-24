import { z } from 'zod';
import { localeSchema } from './i18n.js';
import { sha256Schema } from './inspection.js';
import { idSchema } from './primitives.js';
import { limitedTextSchema, ruleIdSchema } from './preaudit.js';
import { listQuerySchema } from './control-plane.js';
import { codeRuleCandidateSchema, runbookCandidateSchema } from './rule-extraction.js';

const versionLabel = z.string().max(32).regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
const pathSegment = '[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}';
const referencePath = new RegExp('^references/(?:' + pathSegment + '/){0,3}' + pathSegment + '\\.md$');
const designAssetPath = new RegExp('^assets/(?:' + pathSegment + '/){0,3}' + pathSegment + '\\.json$');
const skillText = limitedTextSchema.transform(value => value.replace(/\r\n/g, '\n'));
const plainLabel = limitedTextSchema.pipe(z.string().trim().min(1).max(160).refine(value => !/[\r\n\t]/.test(value)));
const summary = z.strictObject({ title: plainLabel, description: skillText.pipe(z.string().trim().max(1_200)) });
const sourceUrl = z.string().max(2_048).refine(value => {
  const url = URL.parse(value);
  return url?.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
});
const source = z.strictObject({
  name: plainLabel,
  license: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/),
  url: sourceUrl.optional(),
});
const scope = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('workspace') }),
  z.strictObject({ kind: z.literal('project'), projectId: idSchema.transform(value => value.toLowerCase()) }),
]);
const resource = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('reference'), path: z.string().max(160).regex(referencePath), locale: localeSchema, content: skillText }),
  z.strictObject({ kind: z.literal('design_data'), path: z.string().max(160).regex(designAssetPath), content: skillText.refine(value => {
    try {
      const data: unknown = JSON.parse(value);
      return data !== null && typeof data === 'object' && !Array.isArray(data);
    } catch { return false; }
  }) }),
]);
const metadata = { packageKey: ruleIdSchema, version: versionLabel, source, text: z.strictObject({ en: summary, 'zh-CN': summary }) };

export const designSkillPackageSchema = z.strictObject({
  formatVersion: z.literal(1),
  kind: z.literal('design_skill'),
  packageKey: metadata.packageKey, version: metadata.version, scope, source: metadata.source, text: metadata.text,
  skill: z.strictObject({ path: z.literal('SKILL.md'), locale: localeSchema, content: skillText }),
  resources: z.array(resource).max(8).default([]).refine(items =>
    new Set(items.map(item => item.path.toLowerCase())).size === items.length).transform(items =>
    [...items].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
}).refine(document => new TextEncoder().encode(JSON.stringify(document)).length <= 48 * 1024, 'Rule package exceeds 48 KiB');
export type DesignSkillPackage = z.infer<typeof designSkillPackageSchema>;

export const prepareCandidatePackageSchema = z.strictObject({
  ...metadata, scope: z.enum(['project', 'workspace']), validationId: idSchema, validationSha256: sha256Schema,
});

const validatedPackage = {
  formatVersion: z.literal(1), ...metadata, scope,
  validation: z.strictObject({ id: idSchema, sha256: sha256Schema, projectId: idSchema, candidateId: idSchema,
    candidateSha256: sha256Schema, extractionResultSha256: sha256Schema, planSha256: sha256Schema }),
};
export const validatedRulePackageSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('code_rule'), ...validatedPackage, candidate: codeRuleCandidateSchema }),
  z.strictObject({ kind: z.literal('runbook'), ...validatedPackage, candidate: runbookCandidateSchema }),
]).refine(document => document.scope.kind === 'workspace' || document.scope.projectId === document.validation.projectId);
export const rulePackageDocumentSchema = z.union([designSkillPackageSchema, validatedRulePackageSchema]);
export type RulePackageDocument = z.infer<typeof rulePackageDocumentSchema>;

const reviewChecks = z.union([z.strictObject({
  sourceAndLicense: z.boolean(), scopeAndGuidance: z.boolean(), designResources: z.boolean(),
}), z.strictObject({
  sourceAndLicense: z.boolean(), scopeAndGuidance: z.boolean(), validationEvidence: z.boolean(),
})]);
const reviewOutcome = z.enum(['accepted', 'changes_requested']);
export const rulePackageReviewInputSchema = z.strictObject({
  versionSha256: sha256Schema, checks: reviewChecks, note: skillText.pipe(z.string().trim().max(800)).optional(),
}).refine(({ checks, note }) => Boolean(note) || Object.values(checks).every(Boolean), 'Review notes are required for requested changes');
export const rulePackageReviewRecordSchema = rulePackageReviewInputSchema.safeExtend({
  formatVersion: z.literal(1), kind: z.enum(['design_review', 'candidate_review']), versionId: idSchema, reviewedBy: idSchema, grantId: idSchema,
  outcome: reviewOutcome,
}).refine(({ checks, outcome, kind }) => (kind === 'design_review') === ('designResources' in checks)
  && (outcome === 'accepted') === Object.values(checks).every(Boolean));
export type RulePackageReviewRecord = z.infer<typeof rulePackageReviewRecordSchema>;
export const rulePackageReviewDtoSchema = z.strictObject({
  id: idSchema, sha256: sha256Schema, versionSha256: sha256Schema, checks: reviewChecks,
  outcome: reviewOutcome, note: z.string().max(800).optional(), reviewedAt: z.iso.datetime(),
});

export const rulePackageRevisionSchema = z.strictObject({
  packageId: idSchema, versionId: idSchema, packageKey: ruleIdSchema, version: versionLabel, sha256: sha256Schema,
  scope, source, text: summary, locale: localeSchema, kind: z.enum(['design_skill', 'code_rule', 'runbook']),
  reviewState: z.enum(['draft', 'accepted', 'changes_requested']), reviewMessage: z.string(), createdAt: z.iso.datetime(),
});
export const rulePackageDetailSchema = rulePackageRevisionSchema.extend({
  document: rulePackageDocumentSchema, review: rulePackageReviewDtoSchema.nullable(),
}).refine(({ document, kind }) => document.kind === kind);
export const rulePackageImportResultSchema = z.strictObject({ version: rulePackageDetailSchema, replayed: z.boolean() });
export const rulePackageListQuerySchema = listQuerySchema.extend({ before: idSchema.optional() });
export const rulePackagePageSchema = z.strictObject({ items: z.array(rulePackageRevisionSchema).max(100), nextBefore: idSchema.nullable() });

const activationSequence = z.int().min(0).max(2_147_483_647);
const activationBinding = {
  expectedSequence: activationSequence, versionId: idSchema, versionSha256: sha256Schema, idempotencyKey: idSchema,
};
export const rulePackageActivationInputSchema = z.discriminatedUnion('action', [
  z.strictObject({ ...activationBinding, action: z.enum(['publish', 'rollback']), reviewSha256: sha256Schema }),
  z.strictObject({ ...activationBinding, action: z.literal('withdraw') }),
]);
export const rulePackageActivationSchema = z.strictObject({
  sequence: activationSequence.min(1), action: z.enum(['publish', 'rollback', 'withdraw']),
  versionId: idSchema, versionSha256: sha256Schema, reviewSha256: sha256Schema.nullable(),
  recordedBy: idSchema, recordedAt: z.iso.datetime(), message: z.string(),
});
export const rulePackageActivationViewSchema = z.strictObject({
  packageId: idSchema, sequence: activationSequence, current: rulePackageActivationSchema.nullable(),
  history: z.array(rulePackageActivationSchema).max(50), locale: localeSchema,
});
export const rulePackageActivationResultSchema = z.strictObject({
  operation: rulePackageActivationSchema, state: rulePackageActivationViewSchema, replayed: z.boolean(),
});
