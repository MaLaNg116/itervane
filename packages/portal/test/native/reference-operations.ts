import { deepStrictEqual, equal, notEqual, ok } from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { promisify } from 'node:util';
import type { Client } from '@modelcontextprotocol/client';
import type { Page } from '@playwright/test';
import {
  idSchema, operationsDiagnosisReceiptSchema, operationsObservationViewSchema, operationsProposalViewSchema,
  operationsRestartExecutionViewSchema, operationsRestartInstallationSchema, operationsRestartRecoveryProofSchema,
  operationsRestartSubmissionSchema, sha256Schema, taskIncidentViewSchema, taskRuleSnapshotViewSchema,
  type FormalReleaseTarget, type ReleaseRegistryImageProof, type ReleaseRolloutProof,
} from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { workerConfig } from '../../../control-plane/src/config.js';
import type { Database } from '../../../control-plane/src/persistence/database.js';
import { configuredAuditModel } from '../../../control-plane/src/runtime/formal-audit.js';
import { KomodoReleaseClient } from '../../../control-plane/src/runtime/release-komodo.js';
import { createKeycloakRolloutTokenSource, ReleaseRolloutVerifier } from '../../../control-plane/src/runtime/release-rollout.js';
import { auditFixtureKey, auditFixtureModel } from '../../../control-plane/test/native/audit-provider.js';
import type { openProtectedIngress } from '../../../control-plane/test/native/protected-ingress.js';
import { startScopedWorker } from '../../../control-plane/test/native/scoped-worker.js';
import type { openNativeReleaseKomodo } from '../../../verification/src/native/komodo-probe.js';
import { portalPost, untilResult } from './reference-browser.js';
import { publishReferenceRule, type ReferenceRule } from './reference-learning.js';
import { registerReferenceTarget } from './reference-registration.js';
import { openNativeWhiskersRestartScope } from './whiskers-restart-scope.js';

const execute = promisify(execFile);
type InstalledKomodo = Awaited<ReturnType<typeof openNativeReleaseKomodo>>;
type OperationInputs = {
  origin: string;
  directory: string;
  projectId: string;
  runbook: boolean;
  page: Page;
  client: Client;
  mcpToken: () => Promise<string>;
  configureApi: (settings: Record<string, string>) => Promise<void>;
  database: Database;
  databaseUrl: string;
  modelUrl: string;
  shared: string;
  ca: string;
  deployment: Awaited<ReturnType<InstalledKomodo['prepare']>>;
  ingress: Awaited<ReturnType<typeof openProtectedIngress>>;
  mapping: { environmentId: string; revision: number; fingerprint: string };
  registryOrigin: string;
  imageRepository: FormalReleaseTarget['imageRepository'];
  release: ReleaseRolloutProof;
  image: ReleaseRegistryImageProof;
};

export async function proveReferenceOperations(input: OperationInputs) {
  const { directory, page, database, databaseUrl, shared, deployment, ingress, mapping, release } = input;
  const { environmentId, revision, fingerprint } = mapping;
  const { containerId, imageReference, configDigest, version } = release.runtime;
  const readerEnvironment = ['PATH=/usr/bin:/bin', 'LANG=C.UTF-8', 'NODE_EXTRA_CA_CERTS=' + input.ca,
    'ITERVANE_WORKER_LEASE_SECONDS=30', 'ITERVANE_WORKER_POLL_MS=250'];
  const trusted = getCACertificates('default');
  const workers: Awaited<ReturnType<typeof startScopedWorker>>[] = [];
  let native: Awaited<ReturnType<typeof openNativeWhiskersRestartScope>> | undefined;
  let phase = 'registration';
  try {
    native = await openNativeWhiskersRestartScope();
    const enrollment = await registerReferenceTarget(directory, 'operations-target', { environmentId,
      releaseTargetRevision: revision, releaseTargetSha256: fingerprint, whiskers: { origin: native.origin, serverId: native.serverId },
    }) as { environmentId: string; fingerprint: string };
    equal(enrollment.environmentId, environmentId);
    const fixture = await native.installationFiles({ environmentId, enrollmentSha256: enrollment.fingerprint });
    const installation = operationsRestartInstallationSchema.parse(JSON.parse(await readFile(fixture.installation, 'utf8')));
    const registered = await registerReferenceTarget(directory, 'operations-restart-installation', {
      action: 'register', expectedActiveId: null, installation,
    }) as { installationSha256: string };
    equal(registered.installationSha256, sha256(JSON.stringify(installation)));
    const files = { installation: join(shared, 'reference-restart-installation.json'), guardrails: join(shared, 'reference-restart-guardrails.json'),
      roles: join(shared, 'reference-restart-roles.json') };
    for (const name of ['installation', 'guardrails', 'roles'] as const) {
      await execute('/usr/bin/sudo', ['-n', 'install', '-m', '0444', fixture[name], files[name]], { timeout: 5_000 });
    }
    const reader = await deployment.provisionRestartReader();
    notEqual(reader.actorId, deployment.credentials.actorId);
    const provider = { ITERVANE_AUDIT_MODEL_PROVIDER: 'anthropic', ANTHROPIC_BASE_URL: input.modelUrl, ANTHROPIC_MODEL: auditFixtureModel };
    const model = workerConfig({ DATABASE_URL: databaseUrl, ...provider, ANTHROPIC_API_KEY: auditFixtureKey }).auditModel;
    ok(model);
    const { providerSha256 } = configuredAuditModel(model);
    const installed = { ITERVANE_OPERATIONS_ENVIRONMENT_ID: environmentId, ITERVANE_OPERATIONS_ENROLLMENT_SHA256: enrollment.fingerprint,
      ITERVANE_OPERATIONS_DIAGNOSIS_PROVIDER_SHA256: providerSha256, ITERVANE_OPERATIONS_RELEASE_TARGET_SHA256: fingerprint };
    const monitor = await registerReferenceTarget(directory, 'operations-incident-monitor', {
      action: 'register', environmentId, expectedActiveId: null, enrollmentSha256: enrollment.fingerprint,
      mappingSha256: fingerprint, providerSha256, locale: 'en', validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    }) as { monitorId: string };
    const monitorId = idSchema.parse(monitor.monitorId);
    const coordinates = Object.entries(installed).map(([key, value]) => key + '=' + value);

    phase = 'worker_activation';
    const learning = input.runbook ? { ITERVANE_RULE_EXTRACTION_PROVIDER_SHA256: providerSha256, ITERVANE_CANDIDATE_VALIDATION_ENABLED: '1' } : {};
    await input.configureApi({ ...installed, ...learning, ITERVANE_OPERATIONS_API_ENABLED: '1', ITERVANE_RESTART_API_INSTALLATION_FILE: files.installation });
    workers.push(await startScopedWorker(join(shared, 'worker.mjs'), [...readerEnvironment, ...coordinates,
      ...Object.entries({ ...provider, ...learning }).map(([key, value]) => key + '=' + value),
    ], { DATABASE_URL: databaseUrl, ITERVANE_OPERATIONS_WHISKERS_READ_KEY: native.readKey, ANTHROPIC_API_KEY: auditFixtureKey }));
    workers.push(await startScopedWorker(join(shared, 'health-worker.mjs'), [...readerEnvironment, ...coordinates,
      'ITERVANE_HEALTH_POLL_MS=5000', 'ITERVANE_HEALTH_KOMODO_READER_ID=' + reader.actorId,
      'ITERVANE_HEALTH_INCIDENT_MONITOR_ID=' + monitorId,
    ], { DATABASE_URL: databaseUrl, ITERVANE_HEALTH_KOMODO_READER_KEY: reader.key,
      ITERVANE_HEALTH_KOMODO_READER_SECRET: reader.secret, ITERVANE_HEALTH_PROBE_SECRET: ingress.probeSecret }));
    workers.push(await startScopedWorker(join(shared, 'restart-worker.mjs'), [...readerEnvironment, ...coordinates,
      'ITERVANE_RESTART_INSTALLATION_FILE=' + files.installation, 'ITERVANE_RESTART_GUARDRAILS_FILE=' + files.guardrails,
      'ITERVANE_RESTART_ROLES_FILE=' + files.roles, 'ITERVANE_RESTART_KOMODO_READER_ID=' + reader.actorId,
    ], { DATABASE_URL: databaseUrl, ITERVANE_RESTART_KOMODO_READER_KEY: reader.key, ITERVANE_RESTART_KOMODO_READER_SECRET: reader.secret,
      ITERVANE_RESTART_WHISKERS_WRITE_KEY: native.writeKey, ITERVANE_RESTART_PROBE_SECRET: ingress.probeSecret }));

    const whiskers = native;
    const trial = async (round: 1 | 2, published?: ReferenceRule) => {
      phase = 'health_incident';
      const first = await untilResult(async () => (await database.pool.query<{ sequence: string }>(
        "SELECT sequence::text FROM itervane.operations_health_samples WHERE environment_id=$1 AND binding->>'releaseOperationId'=$2 AND signal->>'status'='healthy' ORDER BY sequence DESC LIMIT 1",
        [environmentId, release.operationId],
      )).rows[0]);
      await deployment.setOwnedContainerRunning(false, { containerId, configDigest, reference: imageReference });
      const admitted = await untilResult(async () => (await database.pool.query<{
        incident_id: string; task_id: string; run_id: string; sample_sequence: string; attempt: number; reason: string; deployment: string; container: string;
      }>("SELECT d.incident_id, d.task_id, d.run_id, d.sample_sequence::text, d.attempt, s.signal->>'reason' AS reason, " +
        "s.binding->>'releaseOperationId' AS deployment, s.binding->>'containerId' AS container " +
        'FROM itervane.operations_incident_diagnoses d JOIN itervane.operations_health_samples s ON s.sequence=d.sample_sequence ' +
        'WHERE d.monitor_id=$1 AND d.sample_sequence > $2', [monitorId, first.sequence])).rows[0], round === 1 ? 65_000 : 160_000);
      equal(admitted.attempt, 1);
      equal(admitted.reason, 'runtime_stopped');
      equal(admitted.deployment, release.operationId);
      equal(admitted.container, containerId);
      ok(Number(admitted.sample_sequence) > Number(first.sequence));
      const taskId = idSchema.parse(admitted.task_id);
      const runId = idSchema.parse(admitted.run_id);
      const call = async (name: string) => (await input.client.callTool({ name, arguments: { taskId } })).structuredContent;
      const observed = await untilResult(async () => {
        const view = operationsObservationViewSchema.parse(await call('get_operations_result'));
        ok(!['failed', 'needs_human', 'cancelled'].includes(view.state));
        return view.diagnosis && view.state === 'succeeded' ? view : undefined;
      });
      equal(observed.runId, runId);
      equal(observed.releaseOperationId, release.operationId);
      equal(observed.observation?.state, 'exited');
      equal(observed.diagnosis?.recommendation.code, 'review_restart');
      const [diagnosisRecord] = (await database.pool.query('SELECT document, sha256 FROM itervane.operations_diagnosis_results WHERE run_id=$1', [runId])).rows;
      const diagnosis = operationsDiagnosisReceiptSchema.parse(diagnosisRecord?.document);
      equal(diagnosis.providerSha256, providerSha256);
      deepStrictEqual(diagnosis.reads.map(item => item.section), ['container', 'release']);
      equal(diagnosisRecord?.sha256, sha256(JSON.stringify(diagnosis)));
      equal(observed.diagnosis?.receiptSha256, diagnosisRecord?.sha256);

      let ruleSnapshotSha256: string | undefined;
      if (published) {
        const pin = taskRuleSnapshotViewSchema.parse(await call('get_task_rule_snapshot'));
        ok(pin.snapshot);
        const { validationSha256, ...coordinates } = published;
        const rule = { ...coordinates, kind: 'runbook' };
        equal(pin.snapshot.document.purpose, 'operations');
        deepStrictEqual(pin.snapshot.document.entries, [rule]);
        equal(pin.snapshot.sha256, sha256(JSON.stringify(pin.snapshot.document)));
        const evidence = observed.diagnosis?.facts.find(fact => fact.section === 'release')?.result.runbooks;
        ok(evidence && evidence.snapshotSha256 === pin.snapshot.sha256);
        const selection = evidence.byState.exited;
        ok(selection.status === 'available');
        deepStrictEqual(selection.rule, rule);
        equal(selection.validationSha256, validationSha256);
        equal(selection.controls.approval, 'portal_and_whiskers');
        equal(selection.controls.publicationBinding, 'exact');
        equal(selection.controls.maxNativeAttempts, 1);
        ruleSnapshotSha256 = pin.snapshot.sha256;
      }

      phase = 'portal_proposal';
      await page.bringToFront();
      if (round === 1) await page.getByRole('combobox', { name: '显示语言', exact: true }).selectOption('en');
      await page.evaluate(id => { location.hash = '#/tasks/' + id; }, taskId);
      const panel = page.getByTestId('operations-proposal');
      const taskPath = '/v1/tasks/' + taskId;
      const proposal = operationsProposalViewSchema.parse(await portalPost(page, taskPath + '/operations-proposal',
        panel.getByRole('button', { name: 'Prepare restart proposal', exact: true }), 201)).proposal;
      ok(proposal?.kind === 'restart' && proposal.status === 'pending');
      equal(proposal.current.operationId, release.operationId);
      equal(proposal.current.manifestDigest, release.manifestDigest);
      if (published) {
        equal(proposal.runbook?.rule.versionId, published.versionId);
        equal(proposal.runbook?.rule.versionSha256, published.versionSha256);
        equal(proposal.runbook?.controls.maxNativeAttempts, 1);
      }
      equal((await database.pool.query('SELECT id FROM itervane.operations_executions WHERE proposal_id=$1', [proposal.id])).rowCount, 0);
      const proposalPath = '/v1/operations/proposals/' + proposal.id;
      const denied = await fetch(input.origin + proposalPath + '/execution', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5_000),
        headers: { Authorization: 'Bearer ' + await input.mcpToken(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ fingerprint: proposal.fingerprint, decisionVersion: 1 }),
      });
      await denied.body?.cancel();
      equal(denied.status, 401);
      await panel.getByRole('button', { name: 'Approve action', exact: true }).click();
      const approved = operationsProposalViewSchema.parse(await portalPost(page, proposalPath + '/decisions',
        page.getByRole('dialog', { name: 'Review this action decision' }).getByRole('button', { name: 'Approve action', exact: true }), 200)).proposal;
      equal(approved?.status, 'confirmed');
      equal(approved?.fingerprint, proposal.fingerprint);
      const receiptPanel = page.getByTestId('operations-restart-execution');
      await receiptPanel.getByRole('button', { name: 'Queue restart', exact: true }).click();
      const queued = operationsRestartSubmissionSchema.parse(await portalPost(page, proposalPath + '/execution',
        page.getByRole('dialog', { name: 'Queue this approved restart?' }).getByRole('button', { name: 'Queue restart', exact: true }), 202));
      equal(queued.replayed, false);

      phase = 'native_approval';
      const certificates = (await readFile(input.ca, 'utf8')).match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
      ok(certificates?.length === 2);
      setDefaultCACertificates([...trusted, ...certificates]);
      const target = { ...deployment.binding, imageRepository: input.imageRepository, registryOrigin: input.registryOrigin };
      const adapter = KomodoReleaseClient.readOnly(target, reader);
      await adapter.verifyInstallation();
      const verifier = new ReleaseRolloutVerifier(adapter, createKeycloakRolloutTokenSource(ingress.check.probeIdentity, ingress.probeSecret));
      const subject = { containerId, version, image: input.image, rolloutCheckSha256: release.runtime.rolloutCheckSha256, check: ingress.check, target };
      const baseline = await verifier.captureRestartBaseline(subject, async () => {});
      equal(baseline.state, 'exited');
      const waiting = await untilResult(async () => {
        const view = operationsRestartExecutionViewSchema.parse(await call('get_operations_execution'));
        if (view.execution?.state === 'waiting_approval') return view.execution;
        ok(!view.execution || !['failed', 'needs_human', 'cancelled', 'succeeded'].includes(view.execution.state));
        return undefined;
      }, 40_000);
      equal(waiting.id, queued.executionId);
      equal(waiting.environmentHeld, true);
      ok(waiting.nativeApprovalId);
      deepStrictEqual(await verifier.captureRestartBaseline(subject, async () => {}), baseline);
      await whiskers.approve(containerId, round);
      deepStrictEqual(await verifier.captureRestartBaseline(subject, async () => {}), baseline);
      await receiptPanel.getByRole('button', { name: 'Resume restart', exact: true }).click();
      const continued = operationsRestartSubmissionSchema.parse(await portalPost(page,
        '/v1/operations/executions/' + queued.executionId + '/continue',
        page.getByRole('dialog', { name: 'Resume this restart?' }).getByRole('button', { name: 'Resume restart', exact: true }), 202));
      equal(continued.executionId, queued.executionId);

      phase = 'independent_recovery';
      const receipt = await untilResult(async () => {
        const view = operationsRestartExecutionViewSchema.parse(await call('get_operations_execution'));
        if (view.execution?.state === 'succeeded') return view.execution;
        ok(!view.execution || !['failed', 'needs_human', 'cancelled'].includes(view.execution.state));
        return undefined;
      }, 60_000);
      equal(receipt.nativeApprovalId, waiting.nativeApprovalId);
      equal(receipt.environmentHeld, false);
      equal(receipt.recovery?.state, 'verified');
      const browserReceipt = await page.waitForResponse(async response => {
        if (!response.ok() || new URL(response.url()).pathname !== taskPath + '/operations-execution') return false;
        const view = operationsRestartExecutionViewSchema.safeParse(await response.json().catch(() => null));
        return view.success && view.data.execution?.state === 'succeeded';
      });
      const portal = operationsRestartExecutionViewSchema.parse(await browserReceipt.json());
      deepStrictEqual(portal.execution, receipt);
      const { rows } = await database.pool.query(
        "SELECT recovery.proof, recovery.proof_sha256, recovery.fence AS read_fence, send.fence AS send_fence, send.state AS send_state " +
        "FROM itervane.operations_restart_recoveries recovery JOIN itervane.operations_restart_resumes send ON send.execution_id=recovery.execution_id " +
        "WHERE recovery.execution_id=$1 AND recovery.state='verified'", [queued.executionId],
      );
      equal(rows.length, 1);
      const row = rows[0]!;
      const proof = operationsRestartRecoveryProofSchema.parse(row?.proof);
      equal(row?.proof_sha256, sha256(JSON.stringify(proof)));
      equal(receipt.recovery?.proofSha256, row?.proof_sha256);
      equal(proof.proposalFingerprint, proposal.fingerprint);
      equal(proof.releaseOperationId, release.operationId);
      equal(proof.executionId, queued.executionId);
      equal(proof.native?.approvalId, waiting.nativeApprovalId);
      equal(proof.runtimeBaselineSha256, sha256(JSON.stringify(baseline)));
      equal(row?.send_state, 'acknowledged');
      ok(row.read_fence > row.send_fence);
      deepStrictEqual(proof.observation.runtime, release.runtime);
      ok(proof.observation.startedAt > baseline.startedAt);
      await whiskers.verifyAudit(deployment.endpoint.container, round);
      equal((await database.pool.query('SELECT task_id FROM itervane.execution_slot WHERE id=1')).rows[0]?.task_id, null);
      const recovered = await untilResult(async () => {
        const incident = taskIncidentViewSchema.parse(await call('get_task_incident'));
        return incident.incident?.closedReason === 'recovered' ? incident.incident : undefined;
      }, 45_000);
      equal(recovered.id, admitted.incident_id);
      equal(recovered.releaseOperationId, release.operationId);
      equal(recovered.diagnoses.length, 1);
      equal(recovered.latestSample.signal.status, 'healthy');
      const anonymousStatus = await ingress.anonymousHealthStatus();
      ok(anonymousStatus === 401 || anonymousStatus === 403);
      return { taskId, runId, incidentId: recovered.id, releaseOperationId: release.operationId, executionId: queued.executionId,
        approvalId: waiting.nativeApprovalId, diagnosisSha256: sha256Schema.parse(diagnosisRecord?.sha256),
        recoverySha256: sha256Schema.parse(row?.proof_sha256), sampleSequence: Number(admitted.sample_sequence), admissions: recovered.diagnoses.length,
        healthStatus: proof.observation.runtime.healthStatus, anonymousStatus, portalApproval: true, nativeApproval: true, stoppedBeforeBothApproved: true,
        independentReader: true, incidentRecovered: true, executionSlotReleased: true, httpMcpAgreement: true, model: 'scripted_anthropic_fixture', ...(ruleSnapshotSha256 ? { ruleSnapshotSha256 } : {}) };
    };
    const first = await trial(1);
    if (!input.runbook) return first;
    phase = 'runbook_publication';
    const learned = await publishReferenceRule({ page, client: input.client, origin: input.origin, projectId: input.projectId,
      taskId: first.taskId, runId: first.runId, evidenceSha256: first.recoverySha256, kind: 'runbook' });
    const reused = await trial(2, learned.publication);
    notEqual(reused.incidentId, first.incidentId);
    notEqual(reused.runId, first.runId);
    notEqual(reused.approvalId, first.approvalId);
    notEqual(reused.executionId, first.executionId);
    ok(reused.sampleSequence > first.sampleSequence && reused.ruleSnapshotSha256);
    return { ...first, runbook: { ...learned, recoverySha256: learned.evidenceSha256, reused } };
  } catch {
    throw new Error('reference_operations_' + phase);
  } finally {
    setDefaultCACertificates(trusted);
    const stopped = await Promise.allSettled(workers.map(worker => worker.stop('TERM')));
    await native?.close();
    if (stopped.some(result => result.status === 'rejected')) throw new Error('reference_operations_cleanup');
  }
}
