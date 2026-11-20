import { randomUUID } from 'node:crypto';
import { sha256 } from '@itervane/agent';
import { formalAuditInputSchema, qualifiedInspectionResponseSchema, type Locale, type QualifiedInspectionReceipt } from '@itervane/contracts';
import { catalogSnapshot } from '@itervane/rules';
import { MemorySaver } from '@langchain/langgraph';

export const omittedPath = 'fixture-source-path-excluded-from-model.json';
const policySha256 = sha256('approved-policy');
const providerSha256 = sha256('approved-provider');

export function auditFixture(locale: Locale, secretMatches: number, dependencyMatch = true) {
  const scope = {
    version: 1, requestId: randomUUID(), taskId: randomUUID(), runId: randomUUID(),
    projectId: randomUUID(), repositoryId: randomUUID(), commit: '0'.repeat(40), generation: 1,
    fence: 1, planSha256: policySha256, workspaceSha256: sha256('workspace'),
  };
  const snapshotSha256 = sha256('source-manifest');
  const domainId = randomUUID();
  const scans: QualifiedInspectionReceipt['snapshot']['reports'] = [
    { scanner: 'gitleaks', version: '8.30.1', policySha256, snapshotSha256, status: 'completed', reason: null, database: null,
      findings: Array.from({ length: secretMatches }, (_, index) => ({
        id: sha256(`pattern-${index}`), ruleId: 'fixture-pattern', path: omittedPath, line: index + 1, severity: 'unknown',
      })) },
    { scanner: 'trivy', version: '0.70.0', policySha256, snapshotSha256, status: 'completed', reason: null,
      database: { sha256: sha256('advisory-db'), updatedAt: '2026-11-20T04:00:00Z' },
      findings: dependencyMatch ? [{ id: sha256('dependency'), ruleId: 'TEST-Advisory.1', path: omittedPath, line: null, severity: 'high' }] : [] },
  ];
  const inspection = qualifiedInspectionResponseSchema.parse({
    kind: 'receipt', scope, domainId, imageSha256: sha256('guest'),
    originSha256: sha256('origin'), commitSha256: sha256(scope.commit), cleanupConfirmed: true, sessionVerified: true,
    snapshot: { runId: domainId, repositoryId: scope.repositoryId, commit: scope.commit, tree: '1'.repeat(40),
      manifestSha256: snapshotSha256, files: 4, totalBytes: 2_000, inputsSha256: sha256('guest-inputs'),
      readOnly: true, offline: true, reports: scans },
  });
  if (inspection.kind !== 'receipt') throw new Error('Expected receipt fixture');
  const document = formalAuditInputSchema.parse({
    version: 1, taskId: scope.taskId, runId: scope.runId, projectId: scope.projectId, generation: scope.generation,
    dataClass: 'synthetic', source: { repositoryId: scope.repositoryId, commit: scope.commit },
    purposeSha256: sha256('fixture purpose'), locale, catalog: catalogSnapshot(),
    inspection: { requestId: scope.requestId, receiptSha256: sha256(JSON.stringify(inspection)), snapshotSha256, planSha256: scope.planSha256 },
  });
  return { inspection, input: { document, sha256: sha256(JSON.stringify(document)) }, providerSha256,
    checkpointer: new MemorySaver(), authorize: async () => true };
}
