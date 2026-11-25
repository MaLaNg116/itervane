import { z } from 'zod';
import { codeRuleValidationProfileSchema } from './code-rule-profile.js';
import { scannerDatabaseSchema, scannerReasonSchema, scannerStatusSchema, sha256Schema, sourceManifestSchema } from './inspection.js';
import { publishedCodeScanEvidenceSchema } from './published-code-scan.js';

const uuid = z.uuidv4();
const gitId = z.string().regex(/^[0-9a-f]{40}$/);
const counter = z.int().min(1).max(2147483647);
export const qualifiedInspectionSnapshotSchema = z.strictObject({
  runId: uuid, repositoryId: uuid, commit: gitId, tree: gitId, manifestSha256: sha256Schema,
  files: z.int().min(1).max(5000), totalBytes: z.int().min(1).max(33554432),
  inputsSha256: sha256Schema, readOnly: z.literal(true), offline: z.literal(true),
});
export const npmPackageNameSchema = z.string().min(1).max(214).regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/);
export const npmStableVersionSchema = z.string().max(29).regex(/^(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})$/);
export const npmAdvisoryIdSchema = z.string().regex(/^(?:CVE-\d{4}-\d{4,12}|GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})$/);
export const npmAdvisoryEvidenceSchema = z.strictObject({
  name: npmPackageNameSchema, installedVersion: npmStableVersionSchema,
  fixedVersions: z.array(npmStableVersionSchema).max(8).refine(versions => new Set(versions).size === versions.length),
});
export const normalizedScannerFindingSchema = z.strictObject({
  id: sha256Schema, ruleId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/),
  path: z.string().min(1).max(240), line: z.int().min(1).max(100000000).nullable(),
  severity: z.enum(['unknown', 'low', 'medium', 'high', 'critical']),
  npm: npmAdvisoryEvidenceSchema.optional(),
});
const report = z.strictObject({
  scanner: z.enum(['gitleaks', 'trivy']), version: z.string().regex(/^\d+\.\d+\.\d+$/),
  policySha256: sha256Schema, snapshotSha256: sha256Schema,
  status: scannerStatusSchema, reason: scannerReasonSchema.nullable(),
  findings: z.array(normalizedScannerFindingSchema).max(2000),
  database: scannerDatabaseSchema.nullable(),
}).superRefine((value, ctx) => {
  if (value.status === 'completed'
    ? value.reason !== null || (value.scanner === 'trivy') !== (value.database !== null)
    : value.reason === null || value.findings.length > 0 || value.database !== null) {
    ctx.addIssue({ code: 'custom', message: 'Invalid scanner outcome' });
  }
  if (value.findings.some(finding => finding.npm !== undefined && (value.scanner !== 'trivy' || finding.line !== null))) {
    ctx.addIssue({ code: 'custom', message: 'Npm coordinates require an npm advisory finding' });
  }
});
export const qualifiedScanReportsSchema = z.tuple([report, report]);

export const qualifiedInspectionScopeSchema = z.strictObject({
  version: z.literal(1), requestId: uuid, taskId: uuid, runId: uuid, projectId: uuid, repositoryId: uuid,
  generation: counter, fence: counter, planSha256: sha256Schema, workspaceSha256: sha256Schema, commit: gitId,
});
export const materializedSourceBasisSchema = z.strictObject({ commit: gitId, baseSnapshotSha256: sha256Schema });
export const publishedInspectionCommandByteLimit = 2 * 1024 * 1024;
export const publishedInspectionProofByteLimit = 12 * 1024 * 1024;
const publishedInspectionBinding = z.strictObject({
  commandSha256: sha256Schema, commandBytes: z.int().min(1).max(publishedInspectionCommandByteLimit), runnerImageSha256: sha256Schema,
});
export const publishedInspectionBasisSchema = z.strictObject({
  binding: publishedInspectionBinding, snapshotSha256: sha256Schema, profile: codeRuleValidationProfileSchema,
}).refine(basis => basis.binding.runnerImageSha256 === basis.profile.runnerImageSha256);
export type PublishedInspectionBasis = z.infer<typeof publishedInspectionBasisSchema>;
export const publishedInspectionProofSchema = z.strictObject({
  commandSha256: sha256Schema, manifest: sourceManifestSchema, scan: publishedCodeScanEvidenceSchema,
});
export const qualifiedInspectionJobScopeSchema = qualifiedInspectionScopeSchema.extend({
  materializedFrom: materializedSourceBasisSchema.optional(), publishedCode: publishedInspectionBinding.optional(),
});
export const qualifiedInspectionRequestSchema = qualifiedInspectionJobScopeSchema.extend({ origin: z.string().min(1).max(768) });
export const qualifiedInspectionStatusSchema = z.strictObject({
  kind: z.literal('status'), version: z.literal(1), workspaceSha256: sha256Schema,
  imageSha256: sha256Schema, state: z.enum(['idle', 'blocked']),
});
export const qualifiedRunnerRejectionSchema = z.strictObject({
  kind: z.literal('rejected'), requestId: uuid.nullable(), cleanup: z.enum(['not_started', 'confirmed', 'unknown']),
  code: z.enum(['peer_denied', 'invalid_request', 'origin_denied', 'lease_lost', 'not_ready', 'job_failed', 'cleanup_unproven']),
  domainId: uuid.nullable(),
});
export const qualifiedInspectionResponseSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('receipt'), scope: qualifiedInspectionJobScopeSchema, domainId: uuid, imageSha256: sha256Schema,
    originSha256: sha256Schema, commitSha256: sha256Schema, cleanupConfirmed: z.literal(true),
    sessionVerified: z.literal(true), snapshot: qualifiedInspectionSnapshotSchema.extend({
      reports: qualifiedScanReportsSchema, materializedCandidateSha256: sha256Schema.optional(), publishedCode: publishedInspectionProofSchema.optional(),
    }),
  }).refine(receipt => Boolean(receipt.scope.materializedFrom) === Boolean(receipt.snapshot.materializedCandidateSha256)
    && Boolean(receipt.scope.publishedCode) === Boolean(receipt.snapshot.publishedCode)),
  qualifiedRunnerRejectionSchema,
]);
export type QualifiedInspectionRequest = z.infer<typeof qualifiedInspectionRequestSchema>;
export type MaterializedSourceBasis = z.infer<typeof materializedSourceBasisSchema>;
export type QualifiedInspectionScope = z.infer<typeof qualifiedInspectionJobScopeSchema>;
export type QualifiedInspectionStatus = z.infer<typeof qualifiedInspectionStatusSchema>;
export type QualifiedInspectionResponse = z.infer<typeof qualifiedInspectionResponseSchema>;
export type QualifiedInspectionReceipt = Extract<QualifiedInspectionResponse, { kind: 'receipt' }>;
