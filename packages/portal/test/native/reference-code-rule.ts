import { deepStrictEqual, equal, notEqual, ok } from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/client';
import type { Page } from '@playwright/test';
import {
  admissionDtoSchema, formalReleaseCandidateDtoSchema, formalRepairDtoSchema, formalVerificationInputSchema,
  formalVerificationResultSchema, idSchema, operationsIncidentStopResultSchema, operationsObservationViewSchema,
  operationsRepairViewSchema, operationsIncidentsViewSchema, projectDtoSchema, qualifiedVerificationResponseSchema,
  repositoryDtoSchema, taskDtoSchema, taskIncidentViewSchema, type CodeRuleValidationProfile, type RecordedVerificationView,
  type ReleaseRolloutProof, type StandardVerificationProfile, type TaskDto,
} from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { workerConfig } from '../../../control-plane/src/config.js';
import type { Database } from '../../../control-plane/src/persistence/database.js';
import { configuredAuditModel } from '../../../control-plane/src/runtime/formal-audit.js';
import type { openProtectedIngress } from '../../../control-plane/test/native/protected-ingress.js';
import { auditFixtureKey, auditFixtureModel } from '../../../control-plane/test/native/audit-provider.js';
import { readNativeRuleReuse, ruleReuseRevisions, summarizePublishedRuleScan } from '../../../control-plane/test/native/published-rule-reuse.js';
import { startScopedWorker } from '../../../control-plane/test/native/scoped-worker.js';
import type { openNativeReleaseKomodo } from '../../../verification/src/native/komodo-probe.js';
import { portalPost, untilResult } from './reference-browser.js';
import { publishReferenceRule, type ReferenceRule } from './reference-learning.js';
import { registerReferenceTarget } from './reference-registration.js';
import type { ReferenceToolCall } from './reference-release.js';
import { openNativeWhiskersReadScope } from './whiskers-read.js';

export const referenceHealthRevision = '5d72c2fd9558d708441dc258496842698b09f630';

type ScopedRelease = { proof: ReleaseRolloutProof };
type CodeRuleInput = {
  origin: string;
  directory: string;
  page: Page;
  client: Client;
  read: ReferenceToolCall;
  mcpToken: () => Promise<string>;
  database: Database;
  databaseUrl: string;
  shared: string;
  workerBundle: string;
  runnerEnvironment: string[];
  ca: string;
  deployment: Awaited<ReturnType<Awaited<ReturnType<typeof openNativeReleaseKomodo>>['prepare']>>;
  ingress: Awaited<ReturnType<typeof openProtectedIngress>>;
  mapping: { environmentId: string; revision: number; fingerprint: string };
  release: ReleaseRolloutProof;
  originalTask: TaskDto;
  modelUrl: string;
  codeProfile: CodeRuleValidationProfile;
  verificationProfile: StandardVerificationProfile;
  configureApi: (settings: Record<string, string>) => Promise<void>;
  verify: (taskId: string, readyRun: (runId: string) => boolean) => Promise<{ current: RecordedVerificationView; task: TaskDto }>;
  publish: (task: TaskDto, verification: RecordedVerificationView) => Promise<ScopedRelease>;
  prepareReuseTarget: (projectId: string, authorization: string) => Promise<{ environmentId: string; fingerprint: string; assertUnchanged: () => Promise<void> }>;
  sourceUrl: string;
};

async function readReceipt(database: Database, runId: string) {
  const { rows } = await database.pool.query(
    "SELECT i.document AS input, v.document AS result, v.sha256, a.receipt FROM itervane.formal_verification_results v " +
    "JOIN itervane.formal_verification_inputs i ON i.run_id=v.run_id " +
    "JOIN itervane.formal_rescan_attempts a ON a.request_id=v.request_id AND a.state='recorded' WHERE v.run_id=$1", [runId],
  );
  equal(rows.length, 1);
  const row = rows[0]!;
  const input = formalVerificationInputSchema.parse(row.input);
  const result = formalVerificationResultSchema.parse(row.result);
  const receipt = qualifiedVerificationResponseSchema.parse(row.receipt);
  ok(result.status === 'reviewed' && receipt.kind === 'verification_receipt' && receipt.cleanupConfirmed);
  equal(result.runId, runId);
  equal(result.receiptSha256, sha256(JSON.stringify(receipt)));
  equal(row.sha256, sha256(JSON.stringify(result)));
  return { ...row, input, result, receipt };
}

async function referenceOwner(page: Page, origin: string, taskId: string) {
  await page.bringToFront();
  await page.evaluate(id => { location.hash = '#/tasks/' + id; }, taskId);
  const watched = await page.waitForRequest(origin + '/v1/tasks/' + taskId);
  const authorization = await watched.headerValue('authorization');
  ok(authorization && authorization.startsWith('Bearer '));
  return authorization;
}

async function provePublishedCodeReuse(input: CodeRuleInput, repaired: TaskDto, publication: ReferenceRule) {
  const { page, origin, read, database } = input;
  let authorization = await referenceOwner(page, origin, repaired.id);
  const request = async (path: string, payload?: object, _human?: boolean, locale = 'en', status = payload ? 201 : 200) => {
    const response = await fetch(origin + path, {
      method: payload ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(8_000),
      headers: { Authorization: authorization, 'Content-Type': 'application/json', 'Accept-Language': locale },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    equal(response.status, status);
    if (!response.ok) { await response.body?.cancel(); return null; }
    return response.json() as Promise<unknown>;
  };
  const project = projectDtoSchema.parse(await request('/v1/projects', { name: 'Reference code rule reuse', slug: 'reference-code-rule-reuse' }));
  notEqual(project.id, input.originalTask.projectId);
  const repository = repositoryDtoSchema.parse(await request('/v1/projects/' + project.id + '/repositories', {
    name: 'Fixed readiness examples', url: input.sourceUrl,
  }));
  const mapping = await input.prepareReuseTarget(project.id, authorization);
  const run = async (example: keyof typeof ruleReuseRevisions) => {
    const violates = example === 'violation';
    const source = { repositoryId: repository.id, commit: ruleReuseRevisions[example] };
    const { task } = admissionDtoSchema.parse(await read('start_audit', { projectId: project.id, source,
      purpose: 'Verify published code rule with fixed ' + example + ' example', dataClass: 'synthetic', locale: 'en', idempotencyKey: randomUUID() }));
    equal(task.projectId, project.id);
    deepStrictEqual(task.source, source);
    const final = await untilResult(async () => {
      const current = taskDtoSchema.parse(await read('get_task', { taskId: task.id }));
      ok(!['failed', 'cancelled', 'reconciling'].includes(current.state));
      return current.state === (violates ? 'needs_human' : 'waiting_input') ? current : undefined;
    }, 340_000);
    equal(final.runId, task.runId);
    const [runtime] = (await database.pool.query('SELECT reason FROM itervane.run_runtime WHERE run_id=$1', [final.runId])).rows;
    equal(runtime?.reason, violates ? 'audit_published_rule_review' : 'verification_observed');
    authorization = await referenceOwner(page, origin, final.id);
    const context = { request, mcp: input.client, admin: database.pool, locale: 'en' as const };
    return { task: final, evidence: await readNativeRuleReuse(final, publication, violates ? 1 : 0, context) };
  };
  const violation = await run('violation');
  await request('/v1/tasks/' + violation.task.id + '/release-candidate', {
    environmentId: mapping.environmentId, expectedVersion: violation.task.version,
  }, true, 'en', 409);
  equal((await database.pool.query('SELECT run_id FROM itervane.formal_verification_inputs WHERE run_id=$1', [violation.task.runId])).rowCount, 0);
  const clean = await run('clean');
  const receipt = await readReceipt(database, clean.task.runId);
  ok(receipt.receipt.snapshot.publishedCode && receipt.input.publishedCode);
  const scan = summarizePublishedRuleScan(receipt.receipt.snapshot.publishedCode.scan);
  const initialScan = clean.evidence.scan;
  equal(scan.ruleSnapshotSha256, initialScan.ruleSnapshotSha256);
  equal(scan.ruleSetSha256, initialScan.ruleSetSha256);
  equal(scan.manifestSha256, initialScan.manifestSha256);
  equal(receipt.input.publishedCode.inspectionScanSha256, initialScan.evidenceSha256);
  deepStrictEqual(scan.findings, []);
  equal(new Set([violation.evidence.domainId, clean.evidence.domainId, receipt.receipt.domainId]).size, 3);
  const candidate = formalReleaseCandidateDtoSchema.parse(await read('request_release', {
    taskId: clean.task.id, environmentId: mapping.environmentId, expectedVersion: clean.task.version,
  }));
  equal(candidate.status, 'pending');
  equal(candidate.operationId, null);
  equal(candidate.manifest.projectId, project.id);
  equal(candidate.manifest.target.mappingSha256, mapping.fingerprint);
  equal(candidate.manifest.verification.ruleSnapshotSha256, initialScan.ruleSnapshotSha256);
  equal(candidate.manifest.verification.resultSha256, receipt.sha256);
  await mapping.assertUnchanged();
  return { projectId: project.id, candidateId: candidate.id, violation: { taskId: violation.task.id,
    scanDomainId: violation.evidence.domainId, findings: violation.evidence.scan.findings.length, blocked: true },
  clean: { taskId: clean.task.id, scanDomainId: clean.evidence.domainId, verificationDomainId: receipt.receipt.domainId,
    findings: scan.findings.length, snapshotSha256: scan.ruleSnapshotSha256, waitingApproval: true } };
}

export async function proveReferenceCodeRule(input: CodeRuleInput) {
  const { directory, page, database, databaseUrl, shared, deployment, ingress, mapping, release, originalTask, read } = input;
  let phase = 'installation';
  const workers: Awaited<ReturnType<typeof startScopedWorker>>[] = [];
  const native = await openNativeWhiskersReadScope();
  try {
    const enrollment = await registerReferenceTarget(directory, 'operations-target', { environmentId: mapping.environmentId,
      releaseTargetRevision: mapping.revision, releaseTargetSha256: mapping.fingerprint, whiskers: { origin: native.origin, serverId: native.serverId },
    }) as { environmentId: string; fingerprint: string };
    equal(enrollment.environmentId, mapping.environmentId);
    const reader = await deployment.provisionRestartReader();
    notEqual(reader.actorId, deployment.credentials.actorId);
    const provider = { ITERVANE_AUDIT_MODEL_PROVIDER: 'anthropic', ANTHROPIC_BASE_URL: input.modelUrl, ANTHROPIC_MODEL: auditFixtureModel };
    const model = workerConfig({ DATABASE_URL: databaseUrl, ...provider, ANTHROPIC_API_KEY: auditFixtureKey }).auditModel;
    ok(model);
    const { providerSha256 } = configuredAuditModel(model);
    const installed = { ITERVANE_OPERATIONS_ENVIRONMENT_ID: mapping.environmentId,
      ITERVANE_OPERATIONS_ENROLLMENT_SHA256: enrollment.fingerprint,
      ITERVANE_OPERATIONS_DIAGNOSIS_PROVIDER_SHA256: providerSha256, ITERVANE_OPERATIONS_RELEASE_TARGET_SHA256: mapping.fingerprint };
    const learning = { ITERVANE_RULE_EXTRACTION_PROVIDER_SHA256: providerSha256, ITERVANE_CANDIDATE_VALIDATION_ENABLED: '1',
      ITERVANE_CODE_RULE_VALIDATION_PROFILE: JSON.stringify(input.codeProfile) };
    const monitor = await registerReferenceTarget(directory, 'operations-incident-monitor', {
      action: 'register', environmentId: mapping.environmentId, expectedActiveId: null, enrollmentSha256: enrollment.fingerprint,
      mappingSha256: mapping.fingerprint, providerSha256, locale: 'en', validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    }) as { monitorId: string };
    const monitorId = idSchema.parse(monitor.monitorId);
    const coordinates = Object.entries(installed).map(([key, value]) => key + '=' + value);
    await input.configureApi({ ...installed, ...learning, ITERVANE_OPERATIONS_API_ENABLED: '1' });
    workers.push(await startScopedWorker(input.workerBundle, [...input.runnerEnvironment, ...coordinates,
      'ITERVANE_WORKER_POLL_MS=100', 'ITERVANE_FORMAL_REPAIR=1', 'ITERVANE_VERIFICATION_PROFILE=' + JSON.stringify(input.verificationProfile),
      ...Object.entries({ ...provider, ...learning }).map(([key, value]) => key + '=' + value),
    ], { DATABASE_URL: databaseUrl, ANTHROPIC_API_KEY: auditFixtureKey, ITERVANE_OPERATIONS_WHISKERS_READ_KEY: native.readKey }));
    const health = await startScopedWorker(join(shared, 'health-worker.mjs'), [
      'PATH=/usr/bin:/bin', 'LANG=C.UTF-8', 'NODE_EXTRA_CA_CERTS=' + input.ca, ...coordinates, 'ITERVANE_HEALTH_POLL_MS=5000',
      'ITERVANE_HEALTH_KOMODO_READER_ID=' + reader.actorId, 'ITERVANE_HEALTH_INCIDENT_MONITOR_ID=' + monitorId,
    ], { DATABASE_URL: databaseUrl, ITERVANE_HEALTH_KOMODO_READER_KEY: reader.key,
      ITERVANE_HEALTH_KOMODO_READER_SECRET: reader.secret, ITERVANE_HEALTH_PROBE_SECRET: ingress.probeSecret });
    workers.push(health);

    phase = 'health_diagnosis';
    const incident = await untilResult(async () => (await database.pool.query<{
      incident_id: string; task_id: string; run_id: string; sample_sequence: string; evidence: string; deployment: string; container: string; reason: string;
    }>("SELECT d.incident_id, d.task_id, d.run_id, d.sample_sequence::text, s.signal->>'evidenceSha256' AS evidence, s.signal->>'reason' AS reason, " +
      "s.binding->>'releaseOperationId' AS deployment, s.binding->>'containerId' AS container FROM itervane.operations_incident_diagnoses d " +
      'JOIN itervane.operations_health_samples s ON s.sequence=d.sample_sequence WHERE d.monitor_id=$1 AND d.attempt=1', [monitorId])).rows[0], 100_000);
    equal(incident.deployment, release.operationId);
    equal(incident.container, release.runtime.containerId);
    equal(incident.reason, 'application_unhealthy');
    const diagnosis = await untilResult(async () => {
      const current = operationsObservationViewSchema.parse(await read('get_operations_result', { taskId: incident.task_id }));
      ok(!['failed', 'needs_human', 'cancelled'].includes(current.state));
      return current.state === 'succeeded' && current.diagnosis ? current.diagnosis : undefined;
    });
    equal(diagnosis.recommendation.code, 'investigate_code');
    const logs = diagnosis.facts.find(fact => fact.section === 'logs');
    ok(logs && logs.result.errorLines > 0);

    phase = 'linked_repair_approval';
    await page.bringToFront();
    await page.getByRole('combobox', { name: '显示语言', exact: true }).selectOption('en');
    await page.evaluate(id => { location.hash = '#/tasks/' + id; }, incident.task_id);
    const incidentScope = '/v1/projects/' + originalTask.projectId + '/environments/' + mapping.environmentId + '/operations-incidents';
    const stopButton = { name: 'Stop automatic diagnosis', exact: true };
    await page.getByTestId('task-health-incident').getByRole('button', stopButton).click();
    const stopped = operationsIncidentStopResultSchema.parse(await portalPost(page,
      incidentScope + '/' + incident.incident_id + '/stop-diagnosis',
      page.getByRole('dialog', { name: 'Stop automatic diagnosis for this incident?' }).getByRole('button', stopButton), 200));
    equal(stopped.incidentId, incident.incident_id);
    equal(stopped.reason, 'operator_stopped');
    const stopProof = taskIncidentViewSchema.parse(await read('get_task_incident', { taskId: incident.task_id }));
    equal(stopProof.incident?.diagnosisStop?.reason, 'operator_stopped');
    equal(stopProof.incident?.diagnoses.length, 1);
    const proposed = operationsRepairViewSchema.parse(await read('request_operations_repair', {
      taskId: incident.task_id, diagnosisSha256: diagnosis.receiptSha256,
    })).proposal;
    ok(proposed?.status === 'pending' && proposed.source.requiresMaterializedCommit === false);
    equal(proposed.incidentId, incident.incident_id);
    equal(proposed.target.releaseOperationId, release.operationId);
    equal(proposed.source.commit, referenceHealthRevision);
    const confirmationPath = '/v1/operations/repair-proposals/' + proposed.id + '/confirm';
    const denied = await fetch(input.origin + confirmationPath, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5_000),
      headers: { Authorization: 'Bearer ' + await input.mcpToken(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ fingerprint: proposed.fingerprint, locale: 'en' }),
    });
    await denied.body?.cancel();
    equal(denied.status, 401);
    const label = { name: 'Queue linked repair', exact: true };
    await page.getByTestId('operations-linked-repair').getByRole('button', label).click();
    const { task, replayed } = admissionDtoSchema.parse(await portalPost(page, confirmationPath,
      page.getByRole('dialog', { name: 'Queue a repair for this version?' }).getByRole('button', label), 202));
    equal(replayed, false);
    equal(task.projectId, originalTask.projectId);
    equal(task.source.commit, referenceHealthRevision);

    phase = 'independent_recheck';
    const repaired = await input.verify(task.id, runId => runId !== task.runId);
    const originalProof = await readReceipt(database, task.runId);
    const repairedProof = await readReceipt(database, repaired.task.runId);
    equal(originalProof.input.healthRegression?.sampleSequence, Number(incident.sample_sequence));
    equal(originalProof.input.healthRegression?.sampleEvidenceSha256, incident.evidence);
    equal(repairedProof.input.healthReproduction?.receiptSha256, originalProof.result.receiptSha256);
    const before = originalProof.result.evidence.baseline;
    const after = repairedProof.result.evidence.baseline;
    ok(before.status === 'passed' && before.healthFollowup?.status === 'unhealthy');
    ok(after.status === 'passed' && after.healthFollowup?.status === 'passed');
    equal(before.healthFollowup.statusCode, 503);
    equal(after.healthFollowup.statusCode, 200);
    notEqual(originalProof.receipt.domainId, repairedProof.receipt.domainId);
    const repair = formalRepairDtoSchema.parse(await read('get_repair', { taskId: repaired.task.id }));
    ok(repair.status === 'recorded' && repair.result.status === 'candidate_ready' && repairedProof.input.subject.kind === 'repair');
    deepStrictEqual(repair.result.candidate.changes.map(change => change.path), ['server/app.mjs']);
    equal(repair.result.candidate.patchSha256, repairedProof.input.subject.patchSha256);

    phase = 'protected_recovery';
    const updated = await input.publish(repaired.task, repaired.current);
    notEqual(updated.proof.operationId, release.operationId);
    notEqual(updated.proof.runtime.containerId, release.runtime.containerId);
    const recovered = await untilResult(async () => {
      const history = operationsIncidentsViewSchema.parse(await read('list_operations_incidents', {
        projectId: originalTask.projectId, environmentId: mapping.environmentId,
      }));
      const previous = history.items.find(item => item.id === incident.incident_id);
      return history.latestHealth?.signal.status === 'healthy' && history.latestHealth.releaseOperationId === updated.proof.operationId
        && previous?.closedReason === 'target_changed' ? history.latestHealth : undefined;
    }, 65_000);
    await health.stop('TERM');
    phase = 'rule_publication';
    await page.getByRole('combobox', { name: '显示语言', exact: true }).selectOption('en');
    const learned = await publishReferenceRule({ page, client: input.client, origin: input.origin, projectId: originalTask.projectId,
      taskId: repaired.task.id, runId: repaired.task.runId, evidenceSha256: repaired.current.resultSha256, kind: 'code_rule' });
    ok(learned.validationGuestId);
    phase = 'rule_reuse';
    const reused = await provePublishedCodeReuse(input, repaired.task, learned.publication);
    equal(new Set([originalProof.receipt.domainId, repairedProof.receipt.domainId, learned.validationGuestId,
      reused.violation.scanDomainId, reused.clean.scanDomainId, reused.clean.verificationDomainId]).size, 6);
    return { originalProjectId: originalTask.projectId, originalOperationId: release.operationId, incidentId: incident.incident_id,
      diagnosisRunId: incident.run_id, repairTaskId: repaired.task.id, patchSha256: repair.result.candidate.patchSha256,
      before: { status: before.healthFollowup.statusCode, domainId: originalProof.receipt.domainId },
      after: { status: after.healthFollowup.statusCode, domainId: repairedProof.receipt.domainId,
        operationId: updated.proof.operationId, protectedHealthSequence: recovered.sequence },
      confirmationDeniedWithMcp: true, model: 'scripted_anthropic_fixture', learned, reused };
  } catch {
    throw new Error('reference_code_rule_' + phase);
  } finally {
    const stopped = await Promise.allSettled(workers.map(worker => worker.stop('TERM')));
    await native.close();
    if (stopped.some(result => result.status === 'rejected')) throw new Error('reference_code_rule_cleanup');
  }
}
