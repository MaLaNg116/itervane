import { z } from 'zod';
import { idSchema, sourceRefSchema, taskStateSchema } from './primitives.js';

export * from './control-plane.js';
export { idSchema, sourceRefSchema, taskStateSchema, agentRoleSchema, taskStates, agentRoles } from './primitives.js';
export type TaskState = z.infer<typeof taskStateSchema>;

export const startTaskSchema = z.object({
  projectId: idSchema,
  source: sourceRefSchema,
  idempotencyKey: z.string().min(1).max(128),
  purpose: z.string().min(1).max(2_000),
  dataClass: z.enum(['synthetic', 'public']),
}).strict();
export type StartTask = z.infer<typeof startTaskSchema>;

// Credentials and claimed approval are deliberately absent from queue payloads.
export const wakeupSchema = z.object({
  taskId: idSchema,
  runId: idSchema,
  generation: z.number().int().positive(),
}).strict();

export const actorSchema = z.object({
  id: idSchema,
  kind: z.enum(['human', 'service', 'agent']),
  projectIds: z.array(idSchema),
  permissions: z.array(z.enum(['read', 'submit', 'approve'])),
}).strict();
export type Actor = z.infer<typeof actorSchema>;

export function mayApprove(actor: Actor, projectId: string): boolean {
  return actor.kind === 'human' && actor.projectIds.includes(projectId)
    && actor.permissions.includes('approve');
}

export const evidenceRefSchema = z.object({
  id: idSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.enum(['source', 'diff', 'scan', 'test', 'image', 'observation']),
}).strict();

export const toolResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('success'), evidence: z.array(evidenceRefSchema), data: z.unknown() }).strict(),
  z.object({ status: z.literal('business_error'), code: z.string(), retryable: z.literal(false) }).strict(),
  z.object({ status: z.literal('infrastructure_error'), code: z.string(), retryable: z.boolean() }).strict(),
  z.object({ status: z.literal('waiting_approval'), operationId: idSchema }).strict(),
  z.object({ status: z.literal('unknown'), operationId: idSchema, requiresReconciliation: z.literal(true) }).strict(),
]);

const transitions: Record<TaskState, readonly TaskState[]> = {
  queued: ['running', 'cancelled'],
  running: ['waiting_approval', 'waiting_input', 'reconciling', 'succeeded', 'failed', 'cancel_requested', 'needs_human'],
  waiting_approval: ['queued', 'cancelled', 'needs_human'],
  waiting_input: ['queued', 'cancelled', 'needs_human'],
  reconciling: ['queued', 'succeeded', 'failed', 'needs_human'],
  cancel_requested: ['cancelled', 'reconciling', 'needs_human'],
  succeeded: [], failed: [], cancelled: [], needs_human: [],
};

export function assertTransition(from: TaskState, to: TaskState): void {
  if (!transitions[from].includes(to)) throw new Error(`Invalid task transition: ${from} -> ${to}`);
}

export const checkSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['passed', 'failed', 'blocked']),
  detail: z.string().min(1),
}).strict();
export type Check = z.infer<typeof checkSchema>;
export type ProbeReport = {
  probe: string;
  runId: string;
  checkedAt: string;
  status: Check['status'];
  checks: Check[];
};

export function summarizeChecks(checks: readonly Check[]): Check['status'] {
  if (checks.some(c => c.status === 'failed')) return 'failed';
  return checks.length === 0 || checks.some(c => c.status === 'blocked') ? 'blocked' : 'passed';
}
