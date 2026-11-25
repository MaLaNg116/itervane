import { z } from 'zod';
import { auditModelProtocolSchema } from './formal-audit.js';
import { localeSchema } from './i18n.js';
import { sha256Schema } from './inspection.js';
import { learningCaseCategorySchema, learningCaseDocumentSchema } from './learning-cases.js';
import { limitedTextSchema, ruleIdSchema } from './preaudit.js';
import { idSchema, taskStateSchema } from './primitives.js';

const shortText = limitedTextSchema.pipe(z.string().trim().max(480));
const localized = z.strictObject({ title: shortText, appliesTo: shortText, limitation: shortText });
const candidateBase = {
  key: ruleIdSchema, text: z.strictObject({ en: localized, 'zh-CN': localized }),
};
const sampleText = limitedTextSchema.pipe(z.string().max(1_600));
export const codeRuleCandidateSchema = z.strictObject({
  ...candidateBase, kind: z.literal('code_rule'),
  check: z.strictObject({ engine: z.literal('semgrep_ce'), language: z.enum(['javascript', 'typescript']),
    pattern: shortText, patternNot: shortText.optional(),
  }),
  samples: z.strictObject({ violation: sampleText, corrected: sampleText, lookalike: sampleText })
    .refine(samples => new Set(Object.values(samples).map(value => value.trim())).size === 3),
});
const runbookCandidate = z.strictObject({
  ...candidateBase, kind: z.literal('runbook'),
  action: z.literal('restart_current_publication'),
  when: z.strictObject({ observedStates: z.array(z.enum(['exited', 'dead'])).min(1).max(2)
    .refine(states => states.length === new Set(states).size) }),
  controls: z.strictObject({ publicationBinding: z.literal('exact'), approval: z.literal('portal_and_whiskers'),
    maxNativeAttempts: z.int().min(1).max(3), stopOn: z.tuple([z.literal('target_drift'), z.literal('unknown_outcome'), z.literal('failed_health')]) }),
  success: z.strictObject({ instance: z.literal('same'), newerStart: z.literal(true), healthStatus: z.literal(200),
    access: z.literal('protected') }),
  samples: z.strictObject({
    eligible: z.strictObject({ observedState: z.enum(['exited', 'dead']), publication: z.literal('current'), approvals: z.literal('both') }),
    healthy: z.strictObject({ observedState: z.literal('running'), publication: z.literal('current'), approvals: z.literal('both') }),
    stale: z.strictObject({ observedState: z.enum(['exited', 'dead']), publication: z.literal('superseded'), approvals: z.literal('both') }),
    unapproved: z.strictObject({ observedState: z.enum(['exited', 'dead']), publication: z.literal('current'), approvals: z.literal('missing') }),
  }),
}).refine(value => [value.samples.eligible, value.samples.stale, value.samples.unapproved]
  .every(sample => value.when.observedStates.includes(sample.observedState)));
export const learningCandidateSchema = z.discriminatedUnion('kind', [codeRuleCandidateSchema, runbookCandidate]);
export type LearningCandidate = z.infer<typeof learningCandidateSchema>;

export const learningCaseReferenceSchema = z.strictObject({ caseId: idSchema, sha256: sha256Schema });
export const extractionCaseSchema = learningCaseReferenceSchema.extend({ document: learningCaseDocumentSchema });
export type ExtractionCase = z.infer<typeof extractionCaseSchema>;
export const learningKnowledgeSchema = z.strictObject({
  category: learningCaseCategorySchema,
  cases: z.array(learningCaseReferenceSchema).max(10).refine(items => new Set(items.map(item => item.caseId)).size === items.length),
  candidates: z.array(z.strictObject({ id: idSchema, key: ruleIdSchema, kind: z.enum(['code_rule', 'runbook']), semanticSha256: sha256Schema })).max(12)
    .refine(items => new Set(items.map(item => item.id)).size === items.length),
});
export type LearningKnowledge = z.infer<typeof learningKnowledgeSchema>;

const conclusion = {
  evidenceIds: z.array(sha256Schema).length(2).refine(ids => ids[0] !== ids[1]), rationale: shortText,
};
export const finishRuleExtractionInputSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ ...conclusion, outcome: z.literal('candidate'), candidate: learningCandidateSchema }),
  z.strictObject({ ...conclusion, outcome: z.literal('retain_case'), reason: z.literal('insufficient_generalization') }),
  z.strictObject({ ...conclusion, outcome: z.literal('duplicate'), existingCandidateId: idSchema }),
]);
export const formalRuleExtractionResultSchema = z.strictObject({
  caseId: idSchema, caseSha256: sha256Schema, knowledgeSha256: sha256Schema, result: finishRuleExtractionInputSchema,
});
export type FormalRuleExtractionResult = z.infer<typeof formalRuleExtractionResultSchema>;

export const startRuleExtractionSchema = z.strictObject({
  caseSha256: sha256Schema, locale: localeSchema.default('en'), idempotencyKey: z.string().min(1).max(128),
});
export const ruleExtractionInputSchema = z.strictObject({
  version: z.literal(1), taskId: idSchema, runId: idSchema, projectId: idSchema, generation: z.literal(1),
  source: learningCaseReferenceSchema, knowledge: learningKnowledgeSchema, knowledgeSha256: sha256Schema,
  providerSha256: sha256Schema,
});
export type RuleExtractionInput = z.infer<typeof ruleExtractionInputSchema>;
export const ruleExtractionResultRecordSchema = z.strictObject({
  version: z.literal(1), taskId: idSchema, runId: idSchema, projectId: idSchema, generation: z.literal(1),
  inputSha256: sha256Schema, checkpointId: idSchema, provider: auditModelProtocolSchema, extraction: formalRuleExtractionResultSchema,
  usage: z.strictObject({ turns: z.int().min(1).max(8), toolCalls: z.literal(2), tokens: z.int().min(0).max(18_000) }),
  candidateSemanticSha256: sha256Schema.nullable(),
}).refine(value => (value.extraction.result.outcome === 'candidate') === (value.candidateSemanticSha256 !== null));
export type RuleExtractionResultRecord = z.infer<typeof ruleExtractionResultRecordSchema>;

export const ruleExtractionViewSchema = z.strictObject({
  taskId: idSchema, runId: idSchema, source: learningCaseReferenceSchema, locale: localeSchema,
  state: taskStateSchema, result: z.strictObject({ id: idSchema, sha256: sha256Schema,
    document: ruleExtractionResultRecordSchema, recordedAt: z.iso.datetime() }).nullable(),
  message: z.string(),
}).refine(({ state, result }) => (state === 'succeeded') === (result !== null));
