import { z } from 'zod';
import { taskDtoSchema } from './control-plane.js';
import { localeSchema } from './i18n.js';
import { sha256Schema } from './inspection.js';
import { idSchema, serviceOriginSchema, sourceRefSchema } from './primitives.js';
import { ociDigestSchema } from './qualified-standard-image.js';
import { releaseRuntimeObservationSchema } from './release.js';

const revision = z.int().min(1).max(2_147_483_647);

export const whiskersEndpointSchema = z.strictObject({
  origin: serviceOriginSchema('Whiskers'),
  serverId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/),
});

export const whiskersContainerBindingSchema = whiskersEndpointSchema.extend({ containerId: sha256Schema });
export type WhiskersContainerBinding = z.output<typeof whiskersContainerBindingSchema>;
export const whiskersNativeApprovalIdSchema = z.string().regex(/^[a-f0-9]{32}$/);

export const whiskersRestartImageDigest = 'sha256:876510ea689a7cca7c6d36a8c1d60f5b5cf09549ece6d4ad2d54e29aa599148c';
export const operationsRestartInstallationSchema = z.strictObject({
  version: z.literal(1),
  installationId: idSchema,
  environmentId: idSchema,
  enrollmentSha256: sha256Schema,
  whiskers: whiskersEndpointSchema,
  imageDigest: z.literal(whiskersRestartImageDigest),
  policySha256: sha256Schema,
  rolesSha256: sha256Schema,
  credentialSha256: sha256Schema,
});
export type OperationsRestartInstallation = z.infer<typeof operationsRestartInstallationSchema>;

export const operationsRestartWriterProofSchema = z.strictObject({
  installationId: idSchema,
  installationSha256: sha256Schema,
  credentialSha256: sha256Schema,
});
export type OperationsRestartWriterProof = z.infer<typeof operationsRestartWriterProofSchema>;

export const operationsRestartRequestSchema = z.strictObject({
  version: z.literal(1),
  tool: z.literal('restart_container'),
  target: whiskersContainerBindingSchema,
  credentialSha256: sha256Schema,
});
export type OperationsRestartRequest = z.infer<typeof operationsRestartRequestSchema>;

export const operationsRestartApprovalInputSchema = z.strictObject({
  callSha256: sha256Schema,
  approvalId: whiskersNativeApprovalIdSchema,
});

export const maxOperationsRestartResumes = 3;
export const operationsRestartContinueInputSchema = operationsRestartApprovalInputSchema.extend({
  expectedVersion: revision,
  idempotencyKey: idSchema,
});
export const operationsRestartResumeBindingSchema = operationsRestartApprovalInputSchema.extend({
  ...operationsRestartWriterProofSchema.shape, runtimeBaselineSha256: sha256Schema,
});
export const operationsRestartResumeOutcomeSchema = operationsRestartApprovalInputSchema.extend({
  outcome: z.enum(['pending', 'acknowledged', 'unknown']),
});

export const operationsRuntimeStartedAtSchema = z.iso.datetime({ precision: 9 }).refine(value => Date.parse(value) > 0);
export const operationsRestartBaselineSchema = releaseRuntimeObservationSchema.pick({
  containerId: true, configDigest: true, imageReference: true, runtimeConfigSha256: true, network: true,
}).extend({ state: z.enum(['exited', 'dead']), startedAt: operationsRuntimeStartedAtSchema });
export type OperationsRestartBaseline = z.infer<typeof operationsRestartBaselineSchema>;

export const operationsRestartRecoveryObservationSchema = z.strictObject({
  runtime: releaseRuntimeObservationSchema, startedAt: operationsRuntimeStartedAtSchema,
});

export const maxOperationsRestartRecoveryAttempts = 3;
export const operationsRestartRecoveryFailureSchema = z.enum([
  'missing_evidence', 'target_changed', 'native_unconfirmed', 'unhealthy', 'unavailable', 'lease_expired',
]);
export type OperationsRestartRecoveryFailure = z.infer<typeof operationsRestartRecoveryFailureSchema>;
export const operationsRestartRecoveryProofSchema = z.strictObject({
  version: z.literal(1), executionId: idSchema, releaseOperationId: idSchema, fence: revision,
  proposalFingerprint: sha256Schema, callSha256: sha256Schema, runtimeBaselineSha256: sha256Schema,
  native: z.strictObject({ approvalId: whiskersNativeApprovalIdSchema, attempt: revision.max(maxOperationsRestartResumes) }).nullable(),
  observation: operationsRestartRecoveryObservationSchema,
});
export type OperationsRestartRecoveryProof = z.infer<typeof operationsRestartRecoveryProofSchema>;

export const operationsTargetInputSchema = z.strictObject({
  environmentId: idSchema,
  releaseTargetRevision: revision,
  releaseTargetSha256: sha256Schema,
  whiskers: whiskersEndpointSchema,
});

export type OperationsTargetInput = z.infer<typeof operationsTargetInputSchema>;

export const startOperationsTaskSchema = z.strictObject({
  projectId: idSchema, environmentId: idSchema,
  idempotencyKey: z.string().min(1).max(128), locale: localeSchema.default('en'),
  expectedReleaseOperationId: idSchema.optional(),
});

export type StartOperationsTask = z.infer<typeof startOperationsTaskSchema>;

export const operationsLaunchOptionSchema = z.strictObject({
  projectId: idSchema, environmentId: idSchema, releaseOperationId: idSchema,
  diagnosis: z.literal(true).optional(),
});
export const operationsLaunchViewSchema = z.strictObject({ option: operationsLaunchOptionSchema.nullable() });
export type OperationsLaunchOption = z.infer<typeof operationsLaunchOptionSchema>;

export const operationsRequestBindingSchema = z.strictObject({
  version: z.literal(1), projectId: idSchema, applicationId: idSchema, environmentId: idSchema, grantId: idSchema,
  releaseTaskId: idSchema, releaseOperationId: idSchema, source: sourceRefSchema, dataClass: taskDtoSchema.shape.dataClass,
  targetRevision: revision, mappingSha256: sha256Schema, enrollmentRevision: revision, enrollmentSha256: sha256Schema,
  containerId: sha256Schema, manifestDigest: ociDigestSchema, configDigest: ociDigestSchema,
});

export type OperationsRequestBinding = z.infer<typeof operationsRequestBindingSchema>;

export const whiskersMcpKeySchema = z.string().regex(/^[a-f0-9]{64}$/);
export const whiskersReadKeySchema = whiskersMcpKeySchema;

export const whiskersObservationSchema = z.strictObject({
  containerId: sha256Schema,
  serverId: whiskersEndpointSchema.shape.serverId,
  state: z.enum(['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead']),
  observedAt: z.iso.datetime({ precision: 3 }),
});

const scopedObservation = whiskersObservationSchema.pick({ containerId: true, serverId: true, observedAt: true });
export const operationsLogTailLines = 40;
const logLineCount = z.int().min(0).max(operationsLogTailLines);
export const operationsLogObservationSchema = scopedObservation.extend({
  tailLines: z.literal(operationsLogTailLines), lines: logLineCount,
  warningLines: logLineCount, errorLines: logLineCount,
}).refine(report => report.warningLines <= report.lines && report.errorLines <= report.lines, 'Log signals exceed the observed lines');

export const operationsMetricPeriod = '1h';
const percentage = z.number().min(0).max(100_000);
const usageSeries = z.strictObject({ average: percentage, maximum: percentage, minimum: percentage })
  .refine(series => series.minimum <= series.average && series.average <= series.maximum, 'Metrics must be ordered');
const metricObservation = scopedObservation.extend({ period: z.literal(operationsMetricPeriod) });
export const operationsMetricObservationSchema = z.discriminatedUnion('status', [
  metricObservation.extend({ status: z.literal('unavailable'), reason: z.literal('no_samples') }),
  metricObservation.extend({ status: z.literal('observed'), cpu: usageSeries, memory: usageSeries.nullable(),
    dataPoints: z.int().min(1).max(100_000) }),
]);

export const operationsObservationReceiptSchema = z.strictObject({
  version: z.literal(1), taskId: idSchema, runId: idSchema, releaseOperationId: idSchema,
  bindingSha256: sha256Schema, fence: revision, observation: whiskersObservationSchema,
});

export type OperationsObservationReceipt = z.infer<typeof operationsObservationReceiptSchema>;
