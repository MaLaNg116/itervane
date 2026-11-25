import { createHash } from 'node:crypto';
import { auditChecklistFindingLimit, auditDesignSkillEvidenceSchema, auditFindingsPerScan, auditScanFindingLimit, auditScannerSchema, extractionCaseSchema, idSchema, learningKnowledgeSchema, linkedHealthRepairContextSchema, localeSchema, operationsDiagnosisObservationSchema,
  sourceRefSchema } from '@itervane/contracts';
import { z } from 'zod';
import { repairEvidenceDataSchema } from './repair-contracts.js';
import { verificationObservationSchema } from './verification-contracts.js';

export const shaSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const keySchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const note = z.string().trim().min(1).max(480);

export const deliveryRoleSchema = z.enum(['audit', 'repair', 'verify']);
export type DeliveryRole = z.infer<typeof deliveryRoleSchema>;
export const agentRoleSchema = z.enum([...deliveryRoleSchema.options, 'operations', 'rule-extraction']);
export type AgentRole = z.infer<typeof agentRoleSchema>;

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
export { auditFindingsPerScan, auditScannerSchema };
const auditFindingId = z.union([keySchema, shaSchema]);
export const findingIdsSchema = z.array(keySchema).max(16).refine(values => new Set(values).size === values.length);
export const templateIdsSchema = z.array(keySchema).min(1).max(4).refine(values => new Set(values).size === values.length);
export const evidenceIdsSchema = z.array(shaSchema).min(1).max(28).refine(values => new Set(values).size === values.length);

export const findingSchema = z.object({
  id: keySchema, ruleId: keySchema, severity: z.enum(['low', 'medium', 'high', 'critical']),
  certainty: z.enum(['confirmed', 'suspected']), title: note, location: note,
}).strict();
const scannedFindingSchema = findingSchema.extend({
  id: shaSchema, ruleId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/),
  severity: z.enum(['unknown', 'low', 'medium', 'high', 'critical']),
});

export const candidateSchema = z.object({
  baseSha256: shaSchema, snapshotSha256: shaSchema, diffSha256: shaSchema, diff: z.string().min(1).max(4_096),
  templateIds: templateIdsSchema, findingIds: findingIdsSchema,
}).strict().refine(candidate => candidate.snapshotSha256 !== candidate.baseSha256 && sha256(candidate.diff) === candidate.diffSha256);
export type Candidate = z.infer<typeof candidateSchema>;

export const checkSchema = z.object({
  check: checkKindSchema, status: z.enum(['passed', 'failed', 'unavailable']), findingIds: findingIdsSchema,
}).strict().refine(result => result.status === 'failed' || result.findingIds.length === 0);
export type ProtectedCheck = z.infer<typeof checkSchema>;

const ruleEvidenceSchema = z.object({
  kind: z.literal('rule'), ruleId: keySchema, sha256: shaSchema, guidance: note, limitation: note,
  designSkill: auditDesignSkillEvidenceSchema.optional(),
}).strict();
const scanEvidenceSchema = z.object({
  kind: z.literal('scan'), scanner: auditScannerSchema, version: z.string().regex(/^\d+\.\d+\.\d+$/),
  inspectionSha256: shaSchema, policySha256: shaSchema, databaseSha256: shaSchema.nullable(),
  totalFindings: z.int().min(0).max(auditScanFindingLimit), findings: z.array(scannedFindingSchema).max(auditFindingsPerScan),
}).strict().refine(scan => (scan.scanner === 'trivy') === (scan.databaseSha256 !== null)
  && scan.findings.length === Math.min(scan.totalFindings, auditFindingsPerScan)
  && new Set(scan.findings.map(finding => finding.id)).size === scan.findings.length
  && scan.findings.every(finding => finding.certainty === (scan.scanner === 'gitleaks' ? 'suspected' : 'confirmed')));

const evidenceDataSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('context'), section: contextSectionSchema, text: z.string().min(1).max(1_200),
    suggestedSection: contextSectionSchema.optional(),
  }).strict(),
  ruleEvidenceSchema,
  z.object({ kind: z.literal('findings'), coverage: z.enum(['complete', 'partial']), limits: z.array(note).max(6),
    findings: z.array(findingSchema).max(16).refine(items => new Set(items.map(item => item.id)).size === items.length),
  }).strict(),
  z.object({ kind: z.literal('candidate'), candidate: candidateSchema }).strict(),
  z.object({ kind: z.literal('check'), result: checkSchema }).strict(),
]);

const receiptBinding = { bindingSha256: shaSchema, snapshotSha256: shaSchema };
export const receiptSchema = z.strictObject({ origin: z.literal('trusted_fixture'), ...receiptBinding, data: evidenceDataSchema });
export type AgentReceipt = z.infer<typeof receiptSchema>;
export type EvidenceData = AgentReceipt['data'];
export const formalReceiptSchema = z.strictObject({
  origin: z.literal('formal_audit'), ...receiptBinding, data: z.discriminatedUnion('kind', [
    ruleEvidenceSchema, scanEvidenceSchema, z.strictObject({
      kind: z.literal('health_reproduction'), reproduction: linkedHealthRepairContextSchema,
      check: z.literal('second_health_request'), statusCode: z.literal(503),
    }),
  ]),
});
export type FormalAuditReceipt = z.infer<typeof formalReceiptSchema>;
export const formalRepairReceiptSchema = z.strictObject({
  origin: z.literal('formal_repair'), ...receiptBinding, data: repairEvidenceDataSchema,
});
export const formalVerificationReceiptSchema = z.strictObject({
  origin: z.literal('formal_verification'), ...receiptBinding, data: verificationObservationSchema,
});
export const formalOperationsReceiptSchema = z.strictObject({
  origin: z.literal('formal_operations'), ...receiptBinding, data: operationsDiagnosisObservationSchema,
});
export const ruleExtractionEvidenceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('learning_case'), record: extractionCaseSchema }),
  z.strictObject({ kind: z.literal('learning_knowledge'), knowledge: learningKnowledgeSchema }),
]);
export const formalRuleExtractionReceiptSchema = z.strictObject({
  origin: z.literal('formal_rule_extraction'), ...receiptBinding, data: ruleExtractionEvidenceSchema,
});

export const evidenceSchema = z.discriminatedUnion('origin', [
  receiptSchema.extend({ id: shaSchema }), formalReceiptSchema.extend({ id: shaSchema }), formalRepairReceiptSchema.extend({ id: shaSchema }),
  formalVerificationReceiptSchema.extend({ id: shaSchema }), formalOperationsReceiptSchema.extend({ id: shaSchema }),
  formalRuleExtractionReceiptSchema.extend({ id: shaSchema }),
]);
export type AgentEvidence = z.infer<typeof evidenceSchema>;
export type AgentOrigin = AgentEvidence['origin'];

const completionFields = { summary: note, evidenceIds: evidenceIdsSchema };
const hypothesisSchema = z.object({ description: note, evidenceIds: evidenceIdsSchema }).strict();
const explanationFields = { impact: note, suggestion: note };
const findingExplanation = z.object({ findingId: auditFindingId, ...explanationFields }).strict();
export const completionSchemas = {
  audit: z.object({ ...completionFields, explanations: z.array(findingExplanation).max(auditChecklistFindingLimit),
    hypotheses: z.array(hypothesisSchema).max(6).default([]) }).strict(),
  repair: z.object(completionFields).strict(),
  verify: z.object(completionFields).strict(),
};

export const auditReportSchema = z.object({
  ...completionFields, hypotheses: z.array(hypothesisSchema).max(6),
  coverage: z.enum(['complete', 'partial']), limits: z.array(note).max(6),
  findings: z.array(z.union([findingSchema.extend(explanationFields), scannedFindingSchema.extend(explanationFields)])).max(auditChecklistFindingLimit),
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
