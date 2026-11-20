import { createHash } from 'node:crypto';
import { idSchema, localeSchema, sourceRefSchema } from '@itervane/contracts';
import { z } from 'zod';

export const shaSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const keySchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const note = z.string().trim().min(1).max(480);

export const deliveryRoleSchema = z.enum(['audit', 'repair', 'verify']);
export type DeliveryRole = z.infer<typeof deliveryRoleSchema>;

export const agentSpecSchema = z.object({
  taskId: idSchema, runId: idSchema, projectId: idSchema, generation: z.number().int().positive(),
  source: sourceRefSchema, snapshotSha256: shaSchema, catalogSha256: shaSchema, baselineSha256: shaSchema,
  locale: localeSchema, goal: note,
  limits: z.object({
    maxTurns: z.number().int().min(1).max(40),
    maxToolCalls: z.number().int().min(1).max(28),
    maxTokens: z.number().int().min(1).max(200_000),
    maxContextBytes: z.number().int().min(2_048).max(32_768),
    maxDurationMs: z.number().int().min(10).max(180_000),
    maxStalledTurns: z.number().int().min(2).max(6),
    maxRepairs: z.number().int().min(1).max(3),
  }).strict(),
}).strict();
export type AgentSpec = z.infer<typeof agentSpecSchema>;

export function sha256(value: string) { return createHash('sha256').update(value).digest('hex'); }

export const checkKinds = ['rescan', 'baseline', 'targeted'] as const;
export const checkKindSchema = z.enum(checkKinds);
export const contextSectionSchema = z.enum(['overview', 'display', 'pagination']);
export const findingIdsSchema = z.array(keySchema).max(16).refine(values => new Set(values).size === values.length);
export const templateIdsSchema = z.array(keySchema).min(1).max(4).refine(values => new Set(values).size === values.length);
export const evidenceIdsSchema = z.array(shaSchema).min(1).max(28).refine(values => new Set(values).size === values.length);

export const findingSchema = z.object({
  id: keySchema, ruleId: keySchema, severity: z.enum(['low', 'medium', 'high', 'critical']),
  certainty: z.enum(['confirmed', 'suspected']), title: note, location: note,
}).strict();

export const candidateSchema = z.object({
  baseSha256: shaSchema, snapshotSha256: shaSchema, diffSha256: shaSchema, diff: z.string().min(1).max(4_096),
  templateIds: templateIdsSchema, findingIds: findingIdsSchema,
}).strict().refine(candidate => candidate.snapshotSha256 !== candidate.baseSha256 && sha256(candidate.diff) === candidate.diffSha256);
export type Candidate = z.infer<typeof candidateSchema>;

export const checkSchema = z.object({
  check: checkKindSchema, status: z.enum(['passed', 'failed', 'unavailable']), findingIds: findingIdsSchema,
}).strict().refine(result => result.status === 'failed' || result.findingIds.length === 0);
export type ProtectedCheck = z.infer<typeof checkSchema>;

const evidenceDataSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('context'), section: contextSectionSchema, text: z.string().min(1).max(1_200) }).strict(),
  z.object({ kind: z.literal('rule'), ruleId: keySchema, sha256: shaSchema, guidance: note, limitation: note }).strict(),
  z.object({ kind: z.literal('findings'), coverage: z.enum(['complete', 'partial']), limits: z.array(note).max(6),
    findings: z.array(findingSchema).max(16).refine(items => new Set(items.map(item => item.id)).size === items.length),
  }).strict(),
  z.object({ kind: z.literal('candidate'), candidate: candidateSchema }).strict(),
  z.object({ kind: z.literal('check'), result: checkSchema }).strict(),
]);

export const receiptSchema = z.object({
  origin: z.literal('trusted_fixture'),
  bindingSha256: shaSchema, snapshotSha256: shaSchema, data: evidenceDataSchema,
}).strict();
export type AgentReceipt = z.infer<typeof receiptSchema>;
export type EvidenceData = AgentReceipt['data'];

export const evidenceSchema = receiptSchema.extend({ id: shaSchema });
export type AgentEvidence = z.infer<typeof evidenceSchema>;

const completionFields = { summary: note, evidenceIds: evidenceIdsSchema };
const hypothesisSchema = z.object({ description: note, evidenceIds: evidenceIdsSchema }).strict();
const findingExplanation = z.object({ findingId: keySchema, impact: note, suggestion: note }).strict();
export const completionSchemas = {
  audit: z.object({ ...completionFields, explanations: z.array(findingExplanation).max(16),
    hypotheses: z.array(hypothesisSchema).max(6).default([]) }).strict(),
  repair: z.object(completionFields).strict(),
  verify: z.object(completionFields).strict(),
};

export const auditReportSchema = z.object({
  ...completionFields, hypotheses: z.array(hypothesisSchema).max(6),
  coverage: z.enum(['complete', 'partial']), limits: z.array(note).max(6),
  findings: z.array(findingSchema.extend({ impact: note, suggestion: note })).max(16),
}).strict();
export const repairReportSchema = z.object({ ...completionFields, candidate: candidateSchema }).strict();
export const verificationReportSchema = z.object({
  ...completionFields, snapshotSha256: shaSchema,
  outcome: z.enum(['verified_fixture', 'needs_repair', 'unverified']),
  checks: z.array(checkSchema).length(3), resolved: findingIdsSchema, remaining: findingIdsSchema,
  added: z.array(keySchema).max(48), unverified: z.array(checkKindSchema).max(3),
}).strict();

export type AuditReport = z.infer<typeof auditReportSchema>;
export type RepairReport = z.infer<typeof repairReportSchema>;
export type VerificationReport = z.infer<typeof verificationReportSchema>;
