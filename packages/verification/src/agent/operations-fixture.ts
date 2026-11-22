import { randomUUID } from 'node:crypto';
import { sha256, type AgentScope, type createFormalOperations } from '@itervane/agent';
import { operationsDiagnosisInputSchema, operationsRequestBindingSchema, type Locale, type OperationsDiagnosisSection } from '@itervane/contracts';
import type { ModelAdapter } from '@itervane/model';

const time = '2026-11-20T12:00:00.000Z';
const previousTime = '2026-11-19T12:00:00.000Z';
const digest = (value: string) => 'sha256:' + sha256(value);
export const operationsDecision = (name: string, input: unknown) => ({ text: '', calls: [{ id: 'decision', name, input }], tokenUsage: 20 });
export const chooseOperationsSection = (section: OperationsDiagnosisSection) => operationsDecision('read_operations', { section });

export function operationsFixture(locale: Locale, state: 'running' | 'exited') {
  const request = operationsRequestBindingSchema.parse({
    version: 1, projectId: randomUUID(), applicationId: randomUUID(), environmentId: randomUUID(), grantId: randomUUID(),
    releaseTaskId: randomUUID(), releaseOperationId: randomUUID(), source: { repositoryId: randomUUID(), commit: 'd'.repeat(40) },
    dataClass: 'synthetic', targetRevision: 1, mappingSha256: sha256('target mapping'),
    enrollmentRevision: 1, enrollmentSha256: sha256('enrollment'), containerId: sha256('managed container'),
    manifestDigest: digest('current image'), configDigest: digest('image config'),
  });
  const document = operationsDiagnosisInputSchema.parse({ version: 1, taskId: randomUUID(), runId: randomUUID(),
    generation: 1, locale, request, requestSha256: sha256(JSON.stringify(request)) });
  const serverId = 'private-server-reference';
  const scope = { containerId: request.containerId, serverId, observedAt: time };
  const previousReleaseOperationId = randomUUID();
  const facts = {
    container: { ...scope, state },
    release: {
      current: { operationId: request.releaseOperationId, manifestDigest: request.manifestDigest, verifiedAt: time },
      previous: { operationId: previousReleaseOperationId, manifestDigest: digest('previous image'), verifiedAt: previousTime },
    },
    logs: { ...scope, tailLines: 40, lines: 8, warningLines: 1, errorLines: 2 },
    metrics: { ...scope, status: 'observed', period: '1h', dataPoints: 8,
      cpu: { average: 15, maximum: 25, minimum: 3 }, memory: { average: 90, maximum: 95, minimum: 45 } },
  };
  const read: Parameters<typeof createFormalOperations>[0]['read'] = async ({ section }) => ({
    proofSha256: sha256(section), result: facts[section],
  });
  const authorize = async (_scope: AgentScope) => true;
  return { input: { document, sha256: sha256(JSON.stringify(document)) }, serverId, providerSha256: sha256('model profile'),
    authorize, read, previousReleaseOperationId, facts };
}

export function scriptedOperations(): ModelAdapter {
  return { protocol: 'anthropic', async complete({ conversation }) {
    const message = conversation[0];
    if (message?.kind !== 'user') throw new Error('Missing diagnosis context');
    const { observations } = JSON.parse(message.text) as { observations: {
      id: string; data: { section: OperationsDiagnosisSection; result: { state?: string } };
    }[] };
    const bySection = new Map(observations.map(item => [item.data.section, item]));
    const container = bySection.get('container');
    if (!container) return chooseOperationsSection('container');
    const stopped = container.data.result.state === 'exited';
    const extra = stopped ? 'logs' : 'metrics';
    const signal = bySection.get(extra);
    if (!signal) return chooseOperationsSection(extra);
    const release = bySection.get('release');
    if (!release) return chooseOperationsSection('release');
    return operationsDecision('finish_role', {
      hypotheses: [{ code: stopped ? 'application_error' : 'memory_pressure', evidenceIds: [signal.id] }],
      recommendation: { code: stopped ? 'review_rollback' : 'continue_observation', evidenceIds: [container.id, release.id] },
    });
  } };
}
