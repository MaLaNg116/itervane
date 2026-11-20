import { z } from 'zod';
import { idSchema } from './primitives.js';
import { localeSchema } from './i18n.js';
import { sha256Schema } from './inspection.js';

export const textLanguageSchema = z.enum(['javascript', 'typescript', 'json', 'text']);
export const ruleIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const versionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
const ruleText = z.object({ title: z.string().min(1).max(160), guidance: z.string().min(1).max(2000), limitation: z.string().min(1).max(1200) }).strict();
export const ruleMaterialSchema = z.object({
  id: ruleIdSchema, version: versionSchema, kind: z.enum(['check', 'guidance', 'skill']),
  languages: z.array(textLanguageSchema).min(1).max(4), detector: z.enum(['eval-call', 'html-sink', 'allow-marker', 'none']),
  enforcement: z.literal('advisory'), source: z.object({ kind: z.literal('bundled'), license: z.literal('Apache-2.0'), references: z.array(z.url()).max(4) }).strict(),
  text: z.object({ en: ruleText, 'zh-CN': ruleText }).strict(),
}).strict();
export const ruleSnapshotSchema = z.object({ sha256: sha256Schema, material: ruleMaterialSchema }).strict();
export const catalogSnapshotSchema = z.object({ version: versionSchema, engineVersion: versionSchema, sha256: sha256Schema, rules: z.array(ruleSnapshotSchema).min(1).max(16) }).strict();
export const ruleDtoSchema = ruleMaterialSchema.omit({ detector: true, text: true }).extend(ruleText.shape).extend({ sha256: sha256Schema }).strict();
export const ruleQuerySchema = z.object({ language: textLanguageSchema.optional(), catalogSha256: sha256Schema.optional() }).strict();
export const catalogDtoSchema = z.object({ version: versionSchema, engineVersion: versionSchema, sha256: sha256Schema, locale: localeSchema, items: z.array(ruleDtoSchema).max(16) }).strict();

export const limitedTextSchema = z.string().min(1).max(16384).refine(value => value.isWellFormed() && value.trim().length > 0
  && new TextEncoder().encode(value).byteLength <= 16384 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  && !/\r(?!\n)/.test(value) && value.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').length <= 1000, 'Bounded plain text required');
export const preauditInputSchema = z.object({
  projectId: idSchema, idempotencyKey: idSchema, catalogSha256: sha256Schema,
  language: textLanguageSchema, format: z.enum(['snippet', 'unified_diff']), dataClass: z.enum(['synthetic', 'public']), text: limitedTextSchema,
}).strict();
const inputMetadata = z.object({ origin: z.literal('client_supplied'), sha256: sha256Schema, language: textLanguageSchema,
  format: z.enum(['snippet', 'unified_diff']), dataClass: z.enum(['synthetic', 'public']), bytes: z.number().int().min(1).max(16384), lines: z.number().int().min(1).max(1000), analyzedLines: z.number().int().min(0).max(1000) }).strict();
const observation = z.object({ ruleId: ruleIdSchema, certainty: z.enum(['observed_text', 'suspected']), inputLine: z.number().int().min(1).max(1000), sourceLine: z.number().int().min(1).max(100_000_000).nullable() }).strict();
const coverage = z.object({ ruleId: ruleIdSchema, status: z.enum(['checked', 'partial', 'guidance_only', 'not_applicable', 'not_analyzed']) }).strict();
export const uncoveredSchema = z.enum(['repository_context', 'formal_scanners', 'runtime_behavior', 'semantic_analysis', 'unchanged_lines', 'no_added_lines', 'observation_limit']);
export const evaluationSchema = z.object({
  version: z.literal(1), input: inputMetadata, catalog: catalogSnapshotSchema,
  outcome: z.enum(['observations', 'no_observations', 'not_analyzed']), observations: z.array(observation).max(100),
  coverage: z.array(coverage).max(16), uncovered: z.array(uncoveredSchema).min(1).max(7), formalScan: z.literal(false), releaseEligible: z.literal(false),
}).strict();
export const preauditRecordSchema = z.object({ id: idSchema, projectId: idSchema, requestedBy: idSchema, submittedVia: z.enum(['http', 'mcp']), evaluation: evaluationSchema }).strict();
export const preauditSummaryDtoSchema = z.object({ id: idSchema, projectId: idSchema, requestedBy: idSchema, submittedVia: z.enum(['http', 'mcp']), createdAt: z.iso.datetime(),
  input: inputMetadata, outcome: evaluationSchema.shape.outcome, catalogSha256: sha256Schema, reportSha256: sha256Schema }).strict();
export const preauditDtoSchema = preauditSummaryDtoSchema.extend({
  locale: localeSchema, catalogVersion: versionSchema, engineVersion: versionSchema,
  observations: z.array(observation.extend({ ruleVersion: versionSchema, ruleSha256: sha256Schema, title: z.string(), guidance: z.string(), limitation: z.string() }).strict()).max(100),
  coverage: z.array(coverage.extend({ title: z.string() }).strict()).max(16), uncovered: z.array(z.object({ code: uncoveredSchema, message: z.string() }).strict()).max(7),
  formalScan: z.literal(false), releaseEligible: z.literal(false),
}).strict();
export const preauditAdmissionSchema = z.object({ report: preauditDtoSchema, replayed: z.boolean() }).strict();
export type PreauditInput = z.infer<typeof preauditInputSchema>;
export type RuleMaterial = z.infer<typeof ruleMaterialSchema>;
export type CatalogSnapshot = z.infer<typeof catalogSnapshotSchema>;
export type Evaluation = z.infer<typeof evaluationSchema>;
export type PreauditRecord = z.infer<typeof preauditRecordSchema>;
