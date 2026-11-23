import { z } from 'zod';
import { linkedHealthRepairContextSchema } from './formal-repair-retry.js';
import { localeSchema } from './i18n.js';
import { sha256Schema } from './inspection.js';
import { catalogSnapshotSchema } from './preaudit.js';
import { idSchema, sourceRefSchema } from './primitives.js';
import { normalizedScannerFindingSchema } from './qualified-inspection.js';

export const formalAuditInputSchema = z.strictObject({
  version: z.literal(1), taskId: idSchema, runId: idSchema, projectId: idSchema, generation: z.int().positive(),
  source: sourceRefSchema, dataClass: z.enum(['public', 'synthetic']), locale: localeSchema, purposeSha256: sha256Schema,
  inspection: z.strictObject({ requestId: idSchema, receiptSha256: sha256Schema, snapshotSha256: sha256Schema, planSha256: sha256Schema }),
  catalog: catalogSnapshotSchema,
  healthReproduction: linkedHealthRepairContextSchema.optional(),
});
export type FormalAuditInput = z.infer<typeof formalAuditInputSchema>;

export const auditModelProtocolSchema = z.enum(['anthropic', 'openai']);
export const auditScannerSchema = z.enum(['gitleaks', 'trivy']);
export const auditFindingsPerScan = 8;
export const formalAuditReasonSchema = z.enum([
  'audit_complete', 'audit_incomplete', 'manual_review', 'deadline', 'turn_budget', 'tool_budget', 'token_budget',
  'context_budget', 'no_progress', 'provider_error', 'invalid_receipt', 'interrupted_action', 'incompatible_checkpoint',
]);
const auditText = z.string().trim().min(1).max(480);
const citations = z.array(sha256Schema).min(1).max(8).refine(ids => new Set(ids).size === ids.length);
const evidence = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('scan'), id: sha256Schema, scanner: auditScannerSchema, version: z.string().regex(/^\d+\.\d+\.\d+$/),
    policySha256: sha256Schema, databaseSha256: sha256Schema.nullable(), totalFindings: z.int().min(0).max(2000),
    findingIds: z.array(sha256Schema).max(auditFindingsPerScan),
  }),
  z.strictObject({ kind: z.literal('rule'), id: sha256Schema, ruleId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), sha256: sha256Schema }),
  z.strictObject({ kind: z.literal('health_reproduction'), id: sha256Schema, reproduction: linkedHealthRepairContextSchema }),
]);

export const formalAuditResultSchema = z.strictObject({
  version: z.literal(1), taskId: idSchema, runId: idSchema, projectId: idSchema, generation: z.int().positive(), locale: localeSchema,
  inputSha256: sha256Schema, checkpointId: idSchema, inspectionSha256: sha256Schema, snapshotSha256: sha256Schema, catalogSha256: sha256Schema,
  status: z.enum(['completed', 'requires_human']), reason: formalAuditReasonSchema, provider: auditModelProtocolSchema,
  usage: z.strictObject({ turns: z.int().min(0).max(12), toolCalls: z.int().min(0).max(8), tokens: z.int().min(0) }),
  evidence: z.array(evidence).max(8),
  trace: z.array(z.strictObject({ operationId: sha256Schema, tool: z.enum(['read_scan', 'read_rule', 'read_health_reproduction']), evidenceId: sha256Schema })).max(8),
  checklist: z.strictObject({
    summary: auditText, coverage: z.enum(['complete', 'partial']), limits: z.array(auditText).min(1).max(6), evidenceIds: citations,
    hypotheses: z.array(z.strictObject({ description: auditText, evidenceIds: citations })).max(6),
    findings: z.array(normalizedScannerFindingSchema.extend({
      scanner: auditScannerSchema, certainty: z.enum(['confirmed', 'suspected']), impact: auditText, suggestion: auditText,
    })).max(2 * auditFindingsPerScan),
  }).nullable(),
}).refine(record => (record.status === 'completed') === (record.reason === 'audit_complete')
  && (record.status === 'completed' ? record.checklist?.coverage === 'complete' : true));
export type FormalAuditResult = z.infer<typeof formalAuditResultSchema>;

const auditView = { taskId: idSchema, runId: idSchema, locale: localeSchema, message: z.string() };
export const formalAuditDtoSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...auditView, status: z.enum(['pending', 'unavailable']), result: z.null() }),
  z.strictObject({ ...auditView, status: z.literal('recorded'), sha256: sha256Schema, recordedAt: z.iso.datetime(), result: formalAuditResultSchema }),
]);
export type FormalAuditDto = z.infer<typeof formalAuditDtoSchema>;
