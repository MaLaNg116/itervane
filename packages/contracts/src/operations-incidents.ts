import { z } from 'zod';
import { localeSchema } from './i18n.js';
import { operationsHealthSignalSchema } from './operations-health.js';
import { idSchema, taskStateSchema } from './primitives.js';

export const operationsIncidentScopeSchema = z.strictObject({ projectId: idSchema, environmentId: idSchema });

export const operationsHealthSampleViewSchema = z.strictObject({
  sequence: z.int().positive(), recordedAt: z.iso.datetime(), releaseOperationId: idSchema, restoreExecutionId: idSchema.nullable(),
  signal: operationsHealthSignalSchema, message: z.string(),
});

const diagnosisView = z.strictObject({
  taskId: idSchema, runId: idSchema, attempt: z.int().min(1).max(3), sampleSequence: z.int().positive(),
  state: taskStateSchema, stateLabel: z.string(),
});
const repairView = z.strictObject({
  proposalId: idSchema, diagnosisRunId: idSchema, taskId: idSchema.nullable(), state: taskStateSchema.nullable(),
}).refine(({ taskId, state }) => (taskId === null) === (state === null));

export const operationsIncidentSummarySchema = z.strictObject({
  id: idSchema, releaseOperationId: idSchema, restoreExecutionId: idSchema.nullable(),
  openedAt: z.iso.datetime(), lastUnhealthyAt: z.iso.datetime(), unhealthySamples: z.int().positive(),
  closedAt: z.iso.datetime().nullable(), closedReason: z.enum(['recovered', 'target_changed']).nullable(), message: z.string(),
  diagnosisStop: z.strictObject({
    at: z.iso.datetime(), reason: z.enum(['attempt_limit', 'task_stopped', 'operator_stopped']), message: z.string(),
  }).nullable(),
  latestSample: operationsHealthSampleViewSchema,
  diagnoses: z.array(diagnosisView).max(3), repairs: z.array(repairView).max(3),
}).refine(({ closedAt, closedReason }) => (closedAt === null) === (closedReason === null));
export type OperationsIncidentSummary = z.infer<typeof operationsIncidentSummarySchema>;

export const operationsIncidentsViewSchema = operationsIncidentScopeSchema.extend({
  version: z.literal(1), locale: localeSchema, latestHealth: operationsHealthSampleViewSchema.nullable(),
  items: z.array(operationsIncidentSummarySchema).max(100),
});

export const taskIncidentViewSchema = z.strictObject({
  version: z.literal(1), taskId: idSchema, locale: localeSchema,
  relatedAs: z.enum(['diagnosis', 'linked_repair']).nullable(), incident: operationsIncidentSummarySchema.nullable(),
}).refine(({ relatedAs, incident }) => (relatedAs === null) === (incident === null));
