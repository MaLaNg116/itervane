import { z } from 'zod';
import { taskDtoSchema } from './control-plane.js';
import { localeSchema, taskEventReasonSchema } from './i18n.js';
import { sha256Schema } from './inspection.js';
import { idSchema, serviceOriginSchema, sourceRefSchema, taskStateSchema } from './primitives.js';
import { ociDigestSchema } from './qualified-standard-image.js';

const revision = z.int().min(1).max(2_147_483_647);

export const whiskersEndpointSchema = z.strictObject({
  origin: serviceOriginSchema('Whiskers'),
  serverId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/),
});

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

export const whiskersReadKeySchema = z.string().regex(/^[a-f0-9]{64}$/);

export const whiskersObservationSchema = z.strictObject({
  containerId: sha256Schema,
  serverId: whiskersEndpointSchema.shape.serverId,
  state: z.enum(['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead']),
  observedAt: z.iso.datetime({ precision: 3 }),
});

export const operationsObservationReceiptSchema = z.strictObject({
  version: z.literal(1), taskId: idSchema, runId: idSchema, releaseOperationId: idSchema,
  bindingSha256: sha256Schema, fence: revision, observation: whiskersObservationSchema,
});

export type OperationsObservationReceipt = z.infer<typeof operationsObservationReceiptSchema>;

export const operationsObservationViewSchema = z.strictObject({
  version: z.literal(1), taskId: idSchema, runId: idSchema, taskVersion: revision,
  applicationId: idSchema, environmentId: idSchema, releaseOperationId: idSchema,
  state: taskStateSchema, observation: whiskersObservationSchema.pick({ state: true, observedAt: true }).extend({
    stateLabel: z.string().min(1).max(120), receiptSha256: sha256Schema,
  }).nullable(),
  message: z.string().min(1).max(320), reason: taskEventReasonSchema.nullable(),
  reasonMessage: z.string().min(1).max(320).nullable(), locale: localeSchema,
}).refine(view => (view.state === 'succeeded') === (view.observation !== null), 'Completed observation evidence is required');

export type OperationsObservationView = z.infer<typeof operationsObservationViewSchema>;
