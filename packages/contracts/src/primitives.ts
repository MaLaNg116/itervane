import { z } from 'zod';

export const idSchema = z.uuid();
export const agentRoles = ['audit', 'repair', 'verify', 'operations', 'rule-extraction'] as const;
export const agentRoleSchema = z.enum(agentRoles);
export const taskStates = [
  'queued', 'running', 'waiting_approval', 'waiting_input', 'reconciling',
  'succeeded', 'failed', 'cancel_requested', 'cancelled', 'needs_human',
] as const;
export const taskStateSchema = z.enum(taskStates);
export const sourceRefSchema = z.object({
  repositoryId: idSchema,
  commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
}).strict();
