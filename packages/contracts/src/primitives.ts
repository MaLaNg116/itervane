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

export function serviceOriginSchema(service: string) {
  return z.string().max(2048).transform((input, context) => {
    const url = URL.parse(input);
    const loopback = url?.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port;
    if (!url || url.username || url.password || url.pathname !== '/' || url.search || url.hash
        || (!loopback && url.protocol !== 'https:')) {
      context.addIssue({ code: 'custom', message: `Expected a bare HTTPS ${service} origin or an explicit loopback endpoint` });
      return z.NEVER;
    }
    return url.origin;
  });
}
