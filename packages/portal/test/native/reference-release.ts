import { deepStrictEqual, equal, notEqual, ok } from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { Client } from '@modelcontextprotocol/client';
import type { Page } from '@playwright/test';
import {
  admissionDtoSchema, applicationDtoSchema, environmentDtoSchema, formalAuditDtoSchema, formalReleaseCandidateDtoSchema,
  formalReleaseDecisionResultSchema, formalReleaseResultSchema, formalReleaseViewSchema, formalRepairDtoSchema,
  idSchema, releaseRegistryImageProofSchema, releaseRolloutProofSchema, sourceInspectionDtoSchema, taskDtoSchema,
  verificationViewSchema, type StandardVerificationProfile,
} from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { openDatabase } from '../../../control-plane/src/persistence/database.js';
import { fingerprintRolloutCheck } from '../../../control-plane/src/service/release-targets.js';
import { verificationProfileFingerprint } from '../../../control-plane/src/service/repair-retry.js';
import { openProtectedIngress } from '../../../control-plane/test/native/protected-ingress.js';
import { temporaryRegistry } from '../../../control-plane/test/native/registry-fixture.js';
import { startScopedWorker } from '../../../control-plane/test/native/scoped-worker.js';
import { openNativeReleaseKomodo } from '../../../verification/src/native/komodo-probe.js';
import { standardNpmReleaseFiles } from '../../../verification/src/native/npm-release-fixture.js';
import { registerReferenceTarget } from './reference-registration.js';
import { proveReferenceOperations } from './reference-operations.js';

const execute = promisify(execFile);
export const referenceReleaseRevision = '37ac62431fd9bf7b2a6c0f4b3f15d5d5f1f030b8';
const standardRuntimePort = 38171;

export async function proveReferenceDevelopment(options: {
  directory: string;
  origin: string;
  page: Page;
  client: Client;
  mcpToken: () => Promise<string>;
  projectId: string;
  repositoryId: string;
  databaseUrl: string;
  workerBundle: string;
  runnerEnvironment: string[];
  verificationProfile: StandardVerificationProfile;
  operations?: { modelUrl: string; configureApi: (settings: Record<string, string>) => Promise<void> };
}) {
  const { client, page, projectId, repositoryId } = options;
  const shared = dirname(options.workerBundle);
  let phase = 'admission';
  const resources = {
    database: undefined as Awaited<ReturnType<typeof openDatabase>> | undefined,
    registry: undefined as Awaited<ReturnType<typeof temporaryRegistry>> | undefined,
    komodo: undefined as Awaited<ReturnType<typeof openNativeReleaseKomodo>> | undefined,
    ingress: undefined as Awaited<ReturnType<typeof openProtectedIngress>> | undefined,
    worker: undefined as Awaited<ReturnType<typeof startScopedWorker>> | undefined,
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await client.callTool({ name, arguments: args });
    ok(!response.isError, 'reference_mcp_call_failed');
    return response.structuredContent;
  };
  const create = async (authorization: string, resource: 'applications' | 'environments', value: object) => {
    const response = await fetch(options.origin + '/v1/projects/' + projectId + '/' + resource, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5_000),
      headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body: JSON.stringify(value),
    });
    equal(response.status, 201);
    return response.json() as Promise<unknown>;
  };
  try {
    const { task: initial } = admissionDtoSchema.parse(await call('start_audit', {
      projectId, source: { repositoryId, commit: referenceReleaseRevision }, dataClass: 'public',
      purpose: 'Repair and release the pinned synthetic reference application', locale: 'en', idempotencyKey: randomUUID(),
    }));
    equal(initial.projectId, projectId);
    const taskId = initial.id;
    phase = 'verification';
    let verified;
    const deadline = performance.now() + 720_000;
    while (performance.now() < deadline) {
      const current = verificationViewSchema.parse(await call('get_verification', { taskId })).current;
      const task = taskDtoSchema.parse(await call('get_task', { taskId }));
      if (current.status === 'recorded' && task.state === 'waiting_input') {
        equal(current.outcome, 'observed');
        equal(current.runId, initial.runId);
        verified = { current, task };
        break;
      }
      ok(!['needs_human', 'failed', 'cancelled', 'reconciling'].includes(task.state));
      await delay(1_000);
    }
    ok(verified);
    const { current: verification, task } = verified;
    equal(verification.source.status, 'compared');
    ok(verification.source.status === 'compared');
    deepStrictEqual({ introduced: verification.source.introduced, resolved: verification.source.resolved,
      remaining: verification.source.remaining }, { introduced: 0, resolved: 1, remaining: 0 });
    ok(verification.build.status === 'built' && verification.baseline.status === 'passed' && verification.image.status === 'scanned');
    const inspection = sourceInspectionDtoSchema.parse(await call('get_source_inspection', { taskId }));
    const audit = formalAuditDtoSchema.parse(await call('get_audit', { taskId }));
    const repair = formalRepairDtoSchema.parse(await call('get_repair', { taskId }));
    ok(inspection.status === 'completed' && inspection.scanCompleted && audit.status === 'recorded'
      && audit.result.status === 'completed' && repair.status === 'recorded' && repair.result.status === 'candidate_ready');
    equal(inspection.requestedSource.commit, referenceReleaseRevision);
    equal(audit.result.inspectionSha256, inspection.result.receiptSha256);
    equal(audit.result.snapshotSha256, inspection.result.snapshotSha256);
    const approvedFiles = standardNpmReleaseFiles('approved');
    deepStrictEqual(repair.result.candidate.changes.map(change => [change.path, change.afterSha256]), [
      ['package-lock.json', sha256(approvedFiles.lock)], ['package.json', sha256(approvedFiles.manifest)],
    ]);
    equal(repair.result.candidate.manifestSha256, verification.candidateManifestSha256);
    notEqual(inspection.result.receiptSha256, verification.receiptSha256);

    phase = 'downstream_installation';
    await page.bringToFront();
    // Use the current owner session for project resource endpoints with no portal form.
    const ownerRequest = await page.waitForRequest(options.origin + '/v1/projects/' + projectId + '/access');
    const authorization = await ownerRequest.headerValue('authorization');
    ok(authorization && authorization.startsWith('Bearer '));
    const application = applicationDtoSchema.parse(await create(authorization, 'applications', { name: 'Reference release' }));
    const environment = environmentDtoSchema.parse(await create(authorization, 'environments', {
      name: 'Protected reference application', applicationId: application.id,
    }));
    const proxyDirectory = process.env.ITERVANE_NATIVE_RELEASE_PROXIES;
    ok(proxyDirectory && proxyDirectory.startsWith('/'));
    const registry = resources.registry = await temporaryRegistry();
    const komodo = resources.komodo = await openNativeReleaseKomodo();
    const target = await komodo.prepare();
    await target.allowContainerInspection();
    const ingress = resources.ingress = await openProtectedIngress({ ...target.endpoint, port: standardRuntimePort }, {
      traefik: join(proxyDirectory, 'traefik'), oauth2: join(proxyDirectory, 'oauth2-proxy'),
    });
    const rolloutCheckSha256 = fingerprintRolloutCheck(ingress.check);
    const mapping = await registerReferenceTarget(options.directory, 'release-target', {
      environmentId: environment.id, ...target.binding, imageRepository: 'testing/standard', registryOrigin: registry.origin,
      verificationProfileSha256: verificationProfileFingerprint(options.verificationProfile),
      rolloutCheckSha256, rolloutCheck: ingress.check, recoveryPlanSha256: sha256('reference protected release recovery plan'),
    }) as { environmentId: string; revision: number; fingerprint: string };
    equal(mapping.environmentId, environment.id);
    equal(mapping.revision, 1);
    const database = resources.database = await openDatabase(options.databaseUrl);

    phase = 'portal_approval';
    const candidate = formalReleaseCandidateDtoSchema.parse(await call('request_release', {
      taskId, environmentId: environment.id, expectedVersion: task.version,
    }));
    equal(candidate.status, 'pending');
    equal(candidate.operationId, null);
    equal(candidate.fingerprint, sha256(JSON.stringify(candidate.manifest)));
    equal(candidate.manifest.target.mappingSha256, mapping.fingerprint);
    equal(candidate.manifest.verification.resultSha256, verification.resultSha256);
    equal(candidate.manifest.image.manifestDigest, verification.image.manifestDigest);
    equal(candidate.manifest.rolloutCheckSha256, rolloutCheckSha256);
    const decisionPath = '/v1/release-candidates/' + candidate.id + '/decisions';
    const illegal = await fetch(options.origin + decisionPath, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5_000),
      headers: { Authorization: 'Bearer ' + await options.mcpToken(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'confirm', fingerprint: candidate.fingerprint, expectedVersion: 0, idempotencyKey: randomUUID() }),
    });
    await illegal.body?.cancel();
    equal(illegal.status, 401);
    equal((await database.pool.query('SELECT id FROM itervane.release_operations WHERE candidate_id=$1', [candidate.id])).rowCount, 0);
    await page.bringToFront();
    await page.evaluate(id => { location.hash = '#/tasks/' + id; }, taskId);
    await page.getByTestId('formal-release').getByRole('button', { name: 'Approve release', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Approve this release candidate?' });
    await dialog.getByText(candidate.fingerprint, { exact: true }).waitFor();
    const decisionResponse = page.waitForResponse(response => new URL(response.url()).pathname === decisionPath
      && response.request().method() === 'POST', { timeout: 15_000 });
    await dialog.getByRole('button', { name: 'Approve release', exact: true }).click();
    const approved = formalReleaseDecisionResultSchema.parse(await (await decisionResponse).json()).candidate;
    equal(approved.status, 'confirmed');
    equal(approved.fingerprint, candidate.fingerprint);
    equal(approved.decisionVersion, 1);
    const operationId = idSchema.parse(approved.operationId);

    phase = 'release_worker';
    const ca = join(shared, 'reference-release-ca.pem');
    await execute('/usr/bin/sudo', ['-n', 'install', '-m', '0444', ingress.caFile, ca], { timeout: 5_000 });
    resources.worker = await startScopedWorker(join(shared, 'release-worker.mjs'), [
      ...options.runnerEnvironment, 'ITERVANE_WORKER_POLL_MS=250', 'NODE_EXTRA_CA_CERTS=' + ca,
      'ITERVANE_RELEASE_ENVIRONMENT_ID=' + environment.id, 'ITERVANE_RELEASE_TARGET_SHA256=' + mapping.fingerprint,
      'ITERVANE_RELEASE_MATERIALIZER=' + join(shared, 'release-tools/materialize_oci.py'), 'ITERVANE_RELEASE_SKOPEO=/usr/bin/skopeo',
    ], { DATABASE_URL: options.databaseUrl, ITERVANE_RELEASE_KOMODO_KEY: target.credentials.key,
      ITERVANE_RELEASE_KOMODO_SECRET: target.credentials.secret, ITERVANE_RELEASE_PROBE_SECRET: ingress.probeSecret });

    phase = 'release_result';
    const settled = await page.waitForResponse(async response => {
      if (new URL(response.url()).pathname !== '/v1/tasks/' + taskId + '/release' || !response.ok()) return false;
      const view = formalReleaseViewSchema.safeParse(await response.json().catch(() => null));
      return view.success && ['verified', 'manual_review', 'blocked'].includes(view.data.result?.status ?? '');
    }, { timeout: 190_000 });
    const portal = formalReleaseViewSchema.parse(await settled.json());
    ok(portal.result?.status === 'verified');
    const release = formalReleaseResultSchema.parse(await call('get_release_result', { taskId }));
    deepStrictEqual(release, { taskId, runId: task.runId, taskVersion: portal.taskVersion, result: portal.result });
    equal(portal.result.operationId, operationId);
    equal(portal.result.evidence.manifestDigest, verification.image.manifestDigest);
    equal(portal.result.evidence.version, 'candidate-' + candidate.manifest.repairedSnapshotSha256.slice(0, 16));
    equal(taskDtoSchema.parse(await call('get_task', { taskId })).state, 'succeeded');
    await page.getByTestId('release-result').getByText(verification.image.manifestDigest, { exact: true }).waitFor();
    await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN');
    await page.getByTestId('release-result').getByRole('heading', { name: '发布结果', exact: true }).waitFor();
    await page.getByTestId('release-result').getByText(verification.image.manifestDigest, { exact: true }).waitFor();

    phase = 'independent_readback';
    const [rollout] = (await database.pool.query(
      "SELECT proof FROM itervane.formal_release_rollout_attempts WHERE operation_id=$1 AND state='verified'", [operationId],
    )).rows;
    const proof = releaseRolloutProofSchema.parse(rollout?.proof);
    equal(proof.operationId, operationId);
    equal(proof.candidateId, candidate.id);
    equal(proof.mappingSha256, mapping.fingerprint);
    equal(proof.fingerprint, candidate.fingerprint);
    equal(proof.update.updateId, portal.result.updateId);
    equal(proof.update.deploymentId, target.binding.deploymentId);
    equal(proof.decisionVersion, approved.decisionVersion);
    equal(proof.runtime.configDigest, portal.result.evidence.configDigest);
    equal(proof.runtime.rolloutCheckSha256, rolloutCheckSha256);
    equal(proof.runtime.healthStatus, 200);
    const running = await target.observeContainer(proof.runtime.imageReference, proof.runtime.configDigest);
    equal(running.containerId, proof.runtime.containerId);
    const [stored] = (await database.pool.query(
      "SELECT proof FROM itervane.formal_release_steps WHERE operation_id=$1 AND kind='registry' AND state='confirmed'", [operationId],
    )).rows;
    const imported = releaseRegistryImageProofSchema.parse(stored?.proof);
    equal(imported.manifestDigest, proof.manifestDigest);
    equal(imported.configDigest, proof.runtime.configDigest);
    equal(imported.reference, proof.runtime.imageReference);
    const anonymousStatus = await ingress.anonymousHealthStatus();
    ok(anonymousStatus === 401 || anonymousStatus === 403);
    equal((await database.pool.query('SELECT task_id FROM itervane.execution_slot WHERE id=1')).rows[0]?.task_id, null);
    const [guests] = (await database.pool.query(
      "SELECT (SELECT receipt->>'domainId' FROM itervane.inspection_attempts WHERE task_id=$1 AND receipt_sha256=$2) AS inspection, " +
      "(SELECT receipt->>'domainId' FROM itervane.formal_rescan_attempts WHERE run_id=$3 AND state='recorded') AS verification",
      [taskId, inspection.result.receiptSha256, task.runId],
    )).rows;
    const inspectionGuestId = idSchema.parse(guests?.inspection);
    const verificationGuestId = idSchema.parse(guests?.verification);
    notEqual(inspectionGuestId, verificationGuestId);
    let operations: Awaited<ReturnType<typeof proveReferenceOperations>> | undefined;
    if (options.operations) {
      phase = 'operations';
      await resources.worker.stop('TERM');
      operations = await proveReferenceOperations({ origin: options.origin, directory: options.directory, page, client,
        mcpToken: options.mcpToken, ...options.operations, database, databaseUrl: options.databaseUrl, shared, ca, deployment: target,
        ingress, mapping, registryOrigin: registry.origin, imageRepository: 'testing/standard', release: proof, image: imported });
    }
    return { taskId, runId: task.runId, projectId, candidateId: candidate.id, operationId, updateId: proof.update.updateId,
      revision: referenceReleaseRevision, inspectionGuestId, verificationGuestId, auditSha256: audit.sha256,
      patchSha256: repair.result.candidate.patchSha256, verificationSha256: verification.resultSha256,
      manifestDigest: proof.manifestDigest, runtimeVersion: proof.runtime.version, anonymousStatus, healthStatus: proof.runtime.healthStatus,
      controlPlaneIdentity: 'native_keycloak', ingressIdentity: 'native_keycloak', model: 'scripted_anthropic_fixture',
      mcpApprovalDenied: true, portalApproval: true, operationObserved: true, executionSlotReleased: true, ...(operations ? { operations } : {}) };
  } catch (error) {
    if (phase === 'operations' && error instanceof Error && /^reference_operations_[a-z_]+$/.test(error.message)) throw error;
    throw new Error('reference_release_' + phase);
  } finally {
    try { await resources.worker?.stop('TERM'); }
    finally {
      try { await resources.ingress?.close(); }
      finally {
        const closed = await Promise.allSettled([resources.komodo?.close(), resources.registry?.close(), resources.database?.close()]);
        if (closed.some(result => result.status === 'rejected')) throw new Error('reference_release_cleanup');
      }
    }
  }
}
