import { z } from 'zod';
import { sha256Schema } from './inspection.js';

const uuid = z.uuidv4();
const gitId = z.string().regex(/^[0-9a-f]{40}$/);
const counter = z.int().min(1).max(2147483647);
const snapshot = z.strictObject({
  runId: uuid, repositoryId: uuid, commit: gitId, tree: gitId, manifestSha256: sha256Schema,
  files: z.int().min(1).max(5000), totalBytes: z.int().min(1).max(33554432),
  inputsSha256: sha256Schema, readOnly: z.literal(true), offline: z.literal(true),
});
const finding = z.strictObject({
  id: sha256Schema, ruleId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/),
  path: z.string().min(1).max(240), line: z.int().min(1).max(100000000).nullable(),
  severity: z.enum(['unknown', 'low', 'medium', 'high', 'critical']),
});
const report = z.strictObject({
  scanner: z.enum(['gitleaks', 'trivy']), version: z.string().regex(/^\d+\.\d+\.\d+$/),
  policySha256: sha256Schema, snapshotSha256: sha256Schema,
  status: z.enum(['completed', 'failed', 'unavailable', 'unsupported']),
  reason: z.enum(['timeout', 'scanner_error', 'invalid_report', 'missing_inventory', 'database_unavailable', 'empty_source']).nullable(),
  findings: z.array(finding).max(2000),
  database: z.strictObject({ sha256: sha256Schema, updatedAt: z.iso.datetime() }).nullable(),
}).superRefine((value, ctx) => {
  if (value.status === 'completed'
    ? value.reason !== null || (value.scanner === 'trivy') !== (value.database !== null)
    : value.reason === null || value.findings.length > 0 || value.database !== null) {
    ctx.addIssue({ code: 'custom', message: 'Invalid scanner outcome' });
  }
});

export const qualifiedInspectionScopeSchema = z.strictObject({
  version: z.literal(1), requestId: uuid, taskId: uuid, runId: uuid, projectId: uuid, repositoryId: uuid,
  generation: counter, fence: counter, planSha256: sha256Schema, workspaceSha256: sha256Schema, commit: gitId,
});
export const qualifiedInspectionRequestSchema = qualifiedInspectionScopeSchema.extend({ origin: z.string().min(1).max(768) });
export const qualifiedInspectionStatusSchema = z.strictObject({
  kind: z.literal('status'), version: z.literal(1), workspaceSha256: sha256Schema,
  imageSha256: sha256Schema, state: z.enum(['idle', 'blocked']),
});
export const qualifiedInspectionResponseSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('receipt'), scope: qualifiedInspectionScopeSchema, domainId: uuid, imageSha256: sha256Schema,
    originSha256: sha256Schema, commitSha256: sha256Schema, cleanupConfirmed: z.literal(true),
    sessionVerified: z.literal(true), snapshot: snapshot.extend({ reports: z.tuple([report, report]) }),
  }),
  z.strictObject({
    kind: z.literal('rejected'), requestId: uuid.nullable(), cleanup: z.enum(['not_started', 'confirmed', 'unknown']),
    code: z.enum(['peer_denied', 'invalid_request', 'origin_denied', 'lease_lost', 'not_ready', 'job_failed', 'cleanup_unproven']),
    domainId: uuid.nullable(),
  }),
]);
export type QualifiedInspectionRequest = z.infer<typeof qualifiedInspectionRequestSchema>;
export type QualifiedInspectionScope = z.infer<typeof qualifiedInspectionScopeSchema>;
export type QualifiedInspectionStatus = z.infer<typeof qualifiedInspectionStatusSchema>;
export type QualifiedInspectionResponse = z.infer<typeof qualifiedInspectionResponseSchema>;
export type QualifiedInspectionReceipt = Extract<QualifiedInspectionResponse, { kind: 'receipt' }>;
