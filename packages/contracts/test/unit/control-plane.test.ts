import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { capabilitiesSchema, environmentInputSchema, projectInputSchema, repositoryInputSchema } from '../../src/index.js';

it('rejects credentials and token-bearing repository URLs instead of persisting them', () => {
  for (const url of ['https://user:password@example.com/repo', 'https://example.com/repo?token=test', 'https://example.com/repo#token', 'ssh://example.com/repo']) {
    expect(repositoryInputSchema.safeParse({ name: 'example', url }).success).toBe(false);
  }
  expect(repositoryInputSchema.parse({ name: ' example ', url: 'https://example.com/repo/' })).toEqual({ name: 'example', url: 'https://example.com/repo' });
});

it('keeps permission and access protection out of client-controlled resource input', () => {
  expect(projectInputSchema.safeParse({ name: 'demo', slug: 'demo', actor: { kind: 'human' } }).success).toBe(false);
  expect(environmentInputSchema.safeParse({ name: 'demo', applicationId: randomUUID(), access: 'public' }).success).toBe(false);
});

it('cannot claim execution or deployment capability in this delivery', () => {
  expect(capabilitiesSchema.safeParse({ stage: 'p1-a', taskAdmission: true, taskExecution: true, externalMcp: false, sandbox: false, deployment: true, operations: false }).success).toBe(false);
});
