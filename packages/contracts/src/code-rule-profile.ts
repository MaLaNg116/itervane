import { z } from 'zod';
import { sha256Schema } from './inspection.js';

export const codeRuleLanguageSchema = z.enum(['javascript', 'typescript']);
export type CodeRuleLanguage = z.infer<typeof codeRuleLanguageSchema>;

export const codeRuleValidationProfileSchema = z.strictObject({
  version: z.literal(1), engine: z.literal('semgrep_ce'),
  engineVersion: z.string().max(24).regex(/^\d+\.\d+\.\d+$/), engineInputsSha256: sha256Schema, runnerImageSha256: sha256Schema,
});
export type CodeRuleValidationProfile = z.infer<typeof codeRuleValidationProfileSchema>;

export const ruleSampleFailureSchema = z.enum([
  'engine_unavailable', 'timeout', 'command_failed', 'invalid_report', 'version_mismatch', 'incomplete_coverage', 'invalid_match',
]);
