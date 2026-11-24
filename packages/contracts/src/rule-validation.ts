import { z } from 'zod';
import { localeSchema } from './i18n.js';
import { sha256Schema } from './inspection.js';
import { idSchema, taskStateSchema } from './primitives.js';
import { ruleIdSchema } from './preaudit.js';
import { qualifiedRunnerRejectionSchema } from './qualified-inspection.js';
import { codeRuleCandidateSchema } from './rule-extraction.js';

export const ruleSampleKinds = ['violation', 'corrected', 'lookalike'] as const;
export const ruleSampleKindSchema = z.enum(ruleSampleKinds);
export type RuleSampleKind = z.infer<typeof ruleSampleKindSchema>;

export const codeRuleValidationProfileSchema = z.strictObject({
  version: z.literal(1), engine: z.literal('semgrep_ce'),
  engineVersion: z.string().max(24).regex(/^\d+\.\d+\.\d+$/), engineInputsSha256: sha256Schema, runnerImageSha256: sha256Schema,
});
export type CodeRuleValidationProfile = z.infer<typeof codeRuleValidationProfileSchema>;
const sampleBinding = z.strictObject({
  name: ruleSampleKindSchema, file: z.string().regex(/^(violation|corrected|lookalike)\.(js|ts)$/), sha256: sha256Schema,
});
export const codeRuleValidationBasisSchema = z.strictObject({
  version: z.literal(1), candidateId: idSchema, extractionResultSha256: sha256Schema, candidateSha256: sha256Schema,
  ruleKey: ruleIdSchema, configSha256: sha256Schema, profile: codeRuleValidationProfileSchema,
  samples: z.array(sampleBinding).length(3),
}).refine(value => value.samples.every((item, index) => item.name === ruleSampleKinds[index] && item.file.startsWith(item.name + '.'))
  && new Set(value.samples.map(item => item.sha256)).size === 3);
export type CodeRuleValidationBasis = z.infer<typeof codeRuleValidationBasisSchema>;

export const ruleSampleFailureSchema = z.enum(['engine_unavailable', 'timeout', 'command_failed', 'invalid_report', 'version_mismatch', 'incomplete_coverage', 'invalid_match']);
const reportBinding = { ...sampleBinding.shape };
export const codeRuleSampleObservationSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...reportBinding, status: z.literal('checked'), reportSha256: sha256Schema, matches: z.int().min(0).max(256) }),
  z.strictObject({ ...reportBinding, status: z.literal('unavailable'), reason: ruleSampleFailureSchema }),
]);
export type CodeRuleSampleObservation = z.infer<typeof codeRuleSampleObservationSchema>;
export const codeRuleSampleResultSchema = z.strictObject({
  version: z.literal(1), basisSha256: sha256Schema, status: z.enum(['passed', 'failed', 'unavailable']),
  samples: z.array(codeRuleSampleObservationSchema).length(3),
});
export type CodeRuleSampleResult = z.infer<typeof codeRuleSampleResultSchema>;

export const codeRuleValidationCommandSchema = z.strictObject({
  version: z.literal(1), basis: codeRuleValidationBasisSchema, candidate: codeRuleCandidateSchema,
});
export const ruleValidationCommandByteLimit = 32 * 1024;
export const ruleValidationProofByteLimit = 8 * 1024;
export const qualifiedRuleValidationRequestSchema = z.strictObject({
  version: z.literal(1), operation: z.literal('validate_rule_samples'),
  requestId: z.uuidv4(), taskId: z.uuidv4(), runId: z.uuidv4(), projectId: z.uuidv4(),
  generation: z.int().min(1).max(2_147_483_647), fence: z.int().min(1).max(2_147_483_647),
  workspaceSha256: sha256Schema, runnerImageSha256: sha256Schema, basisSha256: sha256Schema, engineInputsSha256: sha256Schema,
  commandSha256: sha256Schema, commandBytes: z.int().min(1).max(ruleValidationCommandByteLimit),
});
export type QualifiedRuleValidationRequest = z.infer<typeof qualifiedRuleValidationRequestSchema>;
export const qualifiedGuestRuleValidationProofSchema = z.strictObject({
  version: z.literal(1), commandSha256: sha256Schema, result: codeRuleSampleResultSchema,
});
export const qualifiedRuleValidationResponseSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('rule_samples_receipt'), scope: qualifiedRuleValidationRequestSchema, domainId: z.uuidv4(),
    imageSha256: sha256Schema, cleanupConfirmed: z.literal(true), sessionVerified: z.literal(true), proof: qualifiedGuestRuleValidationProofSchema }),
  qualifiedRunnerRejectionSchema,
]);
export type QualifiedRuleValidationResponse = z.infer<typeof qualifiedRuleValidationResponseSchema>;
export type QualifiedRuleValidationReceipt = Extract<QualifiedRuleValidationResponse, { kind: 'rule_samples_receipt' }>;

export const runbookSelectionContextSchema = z.strictObject({
  observedState: z.enum(['exited', 'dead', 'running', 'unknown']),
  publication: z.enum(['current', 'superseded', 'unknown']),
  approvals: z.enum(['both', 'missing', 'revoked', 'expired']),
  priorAttempts: z.int().min(0).max(3),
});
export const runbookSelectionSchema = z.enum([
  'ready_for_guarded_dispatch', 'observe_only', 'await_approval', 'stop_target_drift', 'stop_unknown',
  'stop_attempt_limit', 'stop_approval',
]);
export const runbookRecoveryContextSchema = z.strictObject({
  nativeOutcome: z.enum(['acknowledged', 'unknown']), sameInstance: z.boolean().nullable(), newerStart: z.boolean().nullable(),
  healthStatus: z.int().min(100).max(599).nullable(), anonymousStatus: z.int().min(100).max(599).nullable(),
});
export const runbookRecoverySchema = z.enum(['verified_recovered', 'stop_target_drift', 'stop_unknown', 'stop_failed_health']);

export const runbookEvaluationResultSchema = z.strictObject({
  status: z.enum(['passed', 'failed']),
  scenarios: z.strictObject({
    eligible: runbookSelectionSchema, healthy: runbookSelectionSchema, stale: runbookSelectionSchema,
    unapproved: runbookSelectionSchema, exhausted: runbookSelectionSchema, revoked: runbookSelectionSchema,
  }),
  recovery: z.strictObject({
    verified: runbookRecoverySchema, replaced: runbookRecoverySchema, unknown: runbookRecoverySchema,
    unhealthy: runbookRecoverySchema, anonymous: runbookRecoverySchema,
  }),
});

const candidateValidationIdentity = {
  version: z.literal(1), candidateId: idSchema, extractionResultSha256: sha256Schema, candidateSha256: sha256Schema,
};
export const candidateValidationPlanSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...candidateValidationIdentity, kind: z.literal('code_rule'), profile: codeRuleValidationProfileSchema }),
  z.strictObject({ ...candidateValidationIdentity, kind: z.literal('runbook'), evaluatorVersion: z.literal(1) }),
]);
export type CandidateValidationPlan = z.infer<typeof candidateValidationPlanSchema>;
const codeRuleReceipt = qualifiedRuleValidationResponseSchema.options[0];
export const candidateValidationEvidenceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('code_rule'), receipt: codeRuleReceipt }),
  z.strictObject({ kind: z.literal('runbook'), evaluatorVersion: z.literal(1), result: runbookEvaluationResultSchema }),
]);
export type CandidateValidationEvidence = z.infer<typeof candidateValidationEvidenceSchema>;
export const candidateValidationRecordSchema = z.strictObject({
  ...candidateValidationIdentity, taskId: idSchema, runId: idSchema, projectId: idSchema, planSha256: sha256Schema,
  status: z.enum(['passed', 'failed', 'unavailable']), evidence: candidateValidationEvidenceSchema,
}).refine(record => record.status === (record.evidence.kind === 'code_rule' ? record.evidence.receipt.proof.result.status : record.evidence.result.status));
export type CandidateValidationRecord = z.infer<typeof candidateValidationRecordSchema>;
export const startCandidateValidationSchema = z.strictObject({
  extractionResultSha256: sha256Schema, locale: localeSchema.default('en'), idempotencyKey: z.string().min(1).max(128),
});
export const candidateValidationViewSchema = z.strictObject({
  taskId: idSchema, runId: idSchema, plan: candidateValidationPlanSchema, planSha256: sha256Schema,
  state: taskStateSchema, locale: localeSchema, message: z.string(),
  result: z.strictObject({ id: idSchema, sha256: sha256Schema, document: candidateValidationRecordSchema, recordedAt: z.iso.datetime() }).nullable(),
}).refine(view => (view.state === 'succeeded') === (view.result?.document.status === 'passed')
  && (view.result === null || view.state === 'succeeded' || view.state === 'needs_human'));
