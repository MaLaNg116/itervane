import { z } from 'zod';
import { idSchema, sourceRefSchema } from './primitives.js';

export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const sourceContentLimits = Object.freeze({ maxFiles: 5000, maxFileBytes: 2097152, maxSourceBytes: 33554432 });
export const sourceManifestSchema = z.strictObject({
  version: z.literal(1), source: sourceRefSchema, objectFormat: z.enum(['sha1', 'sha256']), tree: sourceRefSchema.shape.commit,
  files: z.array(z.strictObject({
    path: z.string().min(1).max(240), mode: z.enum(['100644', '100755']),
    bytes: z.int().min(0).max(sourceContentLimits.maxFileBytes), sha256: sha256Schema,
  })).max(sourceContentLimits.maxFiles),
  totalBytes: z.int().min(0).max(sourceContentLimits.maxSourceBytes), sha256: sha256Schema,
});
export type SourceManifest = z.infer<typeof sourceManifestSchema>;
export const retrySourceInspectionReasonSchema = z.enum(['runner_unavailable', 'inspection_reconciling', 'inspection_failed']);
export const sourceInspectionPauseReasonSchema = z.enum([
  ...retrySourceInspectionReasonSchema.options, 'inspection_unsupported', 'inspection_source_mismatch', 'inspection_ready', 'inspection_incomplete',
]);
export type SourceInspectionPauseReason = z.infer<typeof sourceInspectionPauseReasonSchema>;
export const sourceInspectionObservationSchema = z.strictObject({
  requestId: idSchema, coverage: z.enum(['complete', 'incomplete']),
});
export const sourceInspectionBlockReasonSchema = z.enum(['runner_unavailable', 'inspection_failed', 'inspection_unsupported', 'inspection_source_mismatch']);
export const scannerStatusSchema = z.enum(['completed', 'failed', 'unavailable', 'unsupported']);
export const scannerReasonSchema = z.enum(['timeout', 'scanner_error', 'invalid_report', 'missing_inventory', 'database_unavailable', 'empty_source']);
export const scannerDatabaseSchema = z.strictObject({ sha256: sha256Schema, updatedAt: z.iso.datetime() });
export const scannerProfileSchema = z.object({
  scanner: z.enum(['gitleaks', 'trivy']), version: z.string().regex(/^\d+\.\d+\.\d+$/),
  policySha256: sha256Schema, coverage: z.enum(['snapshot-secret-patterns', 'npm-lockfile-vulnerabilities']),
}).strict();
export const inspectionPlanSchema = z.object({
  version: z.literal(1), taskId: idSchema, runId: idSchema, requestedSource: sourceRefSchema,
  isolation: z.object({ kind: z.literal('disposable_vm'), driver: z.literal('qemu-kvm-libvirt'), verification: z.literal('required') }).strict(),
  network: z.object({ fetch: z.literal('registered_https_only'), scan: z.literal('deny') }).strict(),
  limits: z.object({ cpu: z.literal(2), memoryMiB: z.literal(2048), diskMiB: z.literal(8192), timeoutSeconds: z.literal(180),
    maxFiles: z.literal(sourceContentLimits.maxFiles), maxFileBytes: z.literal(sourceContentLimits.maxFileBytes),
    maxSourceBytes: z.literal(sourceContentLimits.maxSourceBytes), maxReportBytes: z.literal(4194304) }).strict(),
  scanners: z.tuple([scannerProfileSchema, scannerProfileSchema]),
}).strict();
const inspectionCoordinates = {
  taskId: idSchema, runId: idSchema, requestedSource: sourceRefSchema,
};
const preparedPlan = z.strictObject({ sha256: sha256Schema, document: inspectionPlanSchema, createdAt: z.iso.datetime() });
const unverified = { ...inspectionCoordinates, sourceFetched: z.literal(false), snapshotVerified: z.literal(false), scanCompleted: z.literal(false) };
const scanSummary = z.strictObject({
  scanner: scannerProfileSchema.shape.scanner, status: scannerStatusSchema, reason: scannerReasonSchema.nullable(),
  findingsCount: z.int().min(0).max(2000), database: scannerDatabaseSchema.nullable(),
});
const verified = {
  ...inspectionCoordinates, plan: preparedPlan, sourceFetched: z.literal(true), snapshotVerified: z.literal(true),
  result: z.strictObject({
    requestId: idSchema, receiptSha256: sha256Schema, snapshotSha256: sha256Schema, recordedAt: z.iso.datetime(),
    files: z.int().min(1).max(5000), scans: z.tuple([scanSummary, scanSummary]),
    publishedCode: z.strictObject({ status: z.enum(['complete', 'incomplete']), evidenceSha256: sha256Schema,
      ruleSnapshotSha256: sha256Schema, checkedFiles: z.int().min(0).max(sourceContentLimits.maxFiles), findings: z.int().min(0).max(4_000),
    }).optional(),
  }),
};

export const sourceInspectionDtoSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...unverified, status: z.literal('not_prepared'), reason: z.literal('runner_unavailable'), plan: z.null() }),
  z.strictObject({ ...unverified, status: z.literal('blocked'), reason: sourceInspectionBlockReasonSchema, plan: preparedPlan }),
  z.strictObject({ ...unverified, status: z.literal('checking'), reason: z.null(), plan: preparedPlan, requestId: idSchema }),
  z.strictObject({ ...unverified, status: z.literal('reconciling'), reason: z.literal('inspection_reconciling'), plan: preparedPlan, requestId: idSchema }),
  z.strictObject({ ...verified, status: z.literal('completed'), reason: z.literal('inspection_ready'), scanCompleted: z.literal(true) }),
  z.strictObject({ ...verified, status: z.literal('incomplete'), reason: z.literal('inspection_incomplete'), scanCompleted: z.literal(false) }),
]).superRefine((value, ctx) => {
  const plan = value.plan?.document;
  if (plan && (plan.taskId !== value.taskId || plan.runId !== value.runId
    || plan.requestedSource.repositoryId !== value.requestedSource.repositoryId || plan.requestedSource.commit !== value.requestedSource.commit)) {
    ctx.addIssue({ code: 'custom', message: 'Inspection binding mismatch' });
  }
  if ('result' in value) {
    const { scans, publishedCode, files } = value.result;
    if (value.scanCompleted !== (scans.every(scan => scan.status === 'completed') && publishedCode?.status !== 'incomplete')
      || (publishedCode && publishedCode.checkedFiles > files) || scans.some((scan, index) =>
      scan.scanner !== value.plan.document.scanners[index]?.scanner || (scan.status === 'completed'
        ? scan.reason !== null || (scan.scanner === 'trivy') !== (scan.database !== null)
        : scan.reason === null || scan.findingsCount !== 0 || scan.database !== null))) {
      ctx.addIssue({ code: 'custom', message: 'Inspection coverage mismatch' });
    }
  }
});
export type InspectionPlan = z.infer<typeof inspectionPlanSchema>;
export type SourceInspectionDto = z.infer<typeof sourceInspectionDtoSchema>;
