import { z } from 'zod';
import { sha256Schema } from './inspection.js';
import { idSchema } from './primitives.js';
import { ruleIdSchema } from './preaudit.js';

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
