import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { agentRoleSchema, assertTransition, mayApprove, startTaskSchema, summarizeChecks, toolResultSchema, wakeupSchema } from '../../src/index.js';

describe('governance boundaries', () => {
  const projectId = randomUUID();
  const input = () => ({ projectId, source: { repositoryId: randomUUID(), commit: 'a'.repeat(40) }, idempotencyKey: 'request', purpose: 'Audit the fixed snapshot', dataClass: 'synthetic' });

  it('requires a fixed commit rather than a branch or command', () => {
    expect(startTaskSchema.safeParse(input()).success).toBe(true);
    expect(startTaskSchema.safeParse({ ...input(), source: { repositoryId: randomUUID(), commit: 'main' } }).success).toBe(false);
  });
  it.each(['approved', 'actor', 'permissions', 'apiKey'])('rejects caller-supplied %s authority', property => {
    expect(startTaskSchema.safeParse({ ...input(), [property]: true }).success).toBe(false);
  });
  it('does not admit production data into the first MVP', () => {
    expect(startTaskSchema.safeParse({ ...input(), dataClass: 'production' }).success).toBe(false);
  });
  it('requires a human with current project permissions for approval', () => {
    const actor = { id: randomUUID(), kind: 'human' as const, projectIds: [projectId], permissions: ['approve' as const] };
    expect(mayApprove(actor, projectId)).toBe(true);
    expect(mayApprove({ ...actor, kind: 'agent' }, projectId)).toBe(false);
    expect(mayApprove({ ...actor, kind: 'service' }, projectId)).toBe(false);
    expect(mayApprove(actor, randomUUID())).toBe(false);
    expect(mayApprove({ ...actor, permissions: [] }, projectId)).toBe(false);
  });
  it('keeps credentials and approval out of queue payloads', () => {
    const wakeup = { taskId: randomUUID(), runId: randomUUID(), generation: 1 };
    expect(wakeupSchema.safeParse(wakeup).success).toBe(true);
    expect(wakeupSchema.safeParse({ ...wakeup, apiKey: 'test-placeholder' }).success).toBe(false);
    expect(wakeupSchema.safeParse({ ...wakeup, generation: 0 }).success).toBe(false);
  });
  it('does not reinterpret cancellation or unknown execution as success', () => {
    expect(() => assertTransition('cancel_requested', 'succeeded')).toThrow();
    expect(() => assertTransition('cancel_requested', 'reconciling')).not.toThrow();
    expect(() => assertTransition('succeeded', 'running')).toThrow();
    expect(toolResultSchema.safeParse({ status: 'unknown', operationId: randomUUID(), requiresReconciliation: false }).success).toBe(false);
  });
  it('keeps all five logical roles and never passes absent evidence', () => {
    expect(agentRoleSchema.options).toEqual(['audit', 'repair', 'verify', 'operations', 'rule-extraction']);
    expect(summarizeChecks([])).toBe('blocked');
    expect(summarizeChecks([{ id: 'missing', status: 'blocked', detail: 'missing' }, { id: 'bad', status: 'failed', detail: 'failure' }])).toBe('failed');
  });
});
