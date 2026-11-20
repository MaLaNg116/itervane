import { z } from 'zod';
import { idSchema, sourceRefSchema } from './primitives.js';

export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const scannerProfileSchema = z.object({
  scanner: z.enum(['gitleaks', 'trivy']), version: z.string().regex(/^\d+\.\d+\.\d+$/),
  policySha256: sha256Schema, coverage: z.enum(['snapshot-secret-patterns', 'npm-lockfile-vulnerabilities']),
}).strict();
export const inspectionPlanSchema = z.object({
  version: z.literal(1), taskId: idSchema, runId: idSchema, requestedSource: sourceRefSchema,
  isolation: z.object({ kind: z.literal('disposable_vm'), driver: z.literal('qemu-kvm-libvirt'), verification: z.literal('required') }).strict(),
  network: z.object({ fetch: z.literal('registered_https_only'), scan: z.literal('deny') }).strict(),
  limits: z.object({ cpu: z.literal(2), memoryMiB: z.literal(2048), diskMiB: z.literal(8192), timeoutSeconds: z.literal(180),
    maxFiles: z.literal(5000), maxFileBytes: z.literal(2097152), maxSourceBytes: z.literal(33554432), maxReportBytes: z.literal(4194304) }).strict(),
  scanners: z.tuple([scannerProfileSchema, scannerProfileSchema]),
}).strict();
export const sourceInspectionDtoSchema = z.object({
  taskId: idSchema, runId: idSchema, requestedSource: sourceRefSchema,
  status: z.enum(['not_prepared', 'blocked']), reason: z.literal('runner_unavailable'),
  sourceFetched: z.literal(false), snapshotVerified: z.literal(false), scanCompleted: z.literal(false),
  plan: z.object({ sha256: sha256Schema, document: inspectionPlanSchema, createdAt: z.iso.datetime() }).strict().nullable(),
}).strict().superRefine((value, ctx) => {
  const plan = value.plan?.document;
  if ((value.status === 'blocked') !== (plan !== undefined) || (plan && (plan.taskId !== value.taskId || plan.runId !== value.runId
    || plan.requestedSource.repositoryId !== value.requestedSource.repositoryId || plan.requestedSource.commit !== value.requestedSource.commit))) {
    ctx.addIssue({ code: 'custom', message: 'Inspection binding mismatch' });
  }
});
export type InspectionPlan = z.infer<typeof inspectionPlanSchema>;
export type SourceInspectionDto = z.infer<typeof sourceInspectionDtoSchema>;
