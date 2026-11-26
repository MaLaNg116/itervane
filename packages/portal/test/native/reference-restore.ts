import { deepStrictEqual, equal, notEqual, ok } from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  admissionDtoSchema, operationsObservationViewSchema, operationsProposalViewSchema, operationsRestoreExecutionViewSchema,
  operationsRestorePlanSchema, operationsRestoreRecoveryProofSchema, operationsSubmissionSchema, releaseKomodoUpdateSchema,
  sha256Schema, translate, type ReleaseRolloutProof,
} from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { workerConfig } from '../../../control-plane/src/config.js';
import type { Database } from '../../../control-plane/src/persistence/database.js';
import { configuredAuditModel } from '../../../control-plane/src/runtime/formal-audit.js';
import { KomodoReleaseClient } from '../../../control-plane/src/runtime/release-komodo.js';
import { readPublishedOperationsDeployment } from '../../../control-plane/src/service/operations-deployment.js';
import { auditFixtureKey, auditFixtureModel } from '../../../control-plane/test/native/audit-provider.js';
import type { openProtectedIngress } from '../../../control-plane/test/native/protected-ingress.js';
import { startScopedWorker } from '../../../control-plane/test/native/scoped-worker.js';
import type { openNativeReleaseKomodo } from '../../../verification/src/native/komodo-probe.js';
import { portalPost, untilResult } from './reference-browser.js';
import { registerReferenceTarget } from './reference-registration.js';
import type { ReferenceToolCall } from './reference-release.js';
import { openNativeWhiskersReadScope } from './whiskers-read.js';

type InstalledKomodo = Awaited<ReturnType<typeof openNativeReleaseKomodo>>;
type ReferenceRestoreInput = {
  directory: string;
  origin: string;
  projectId: string;
  page: Page;
  read: ReferenceToolCall;
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
  current: ReleaseRolloutProof;
  previous: ReleaseRolloutProof;
};

const summary = ({ operationId, manifestDigest }: ReleaseRolloutProof) => ({ operationId, manifestDigest });

export async function proveReferenceRestore(input: ReferenceRestoreInput) {
  const { page, read, database, databaseUrl, deployment, ingress, mapping, previous, current } = input;
  const scope = { projectId: input.projectId, environmentId: mapping.environmentId };
  const history = () => database.db.transaction(tx => readPublishedOperationsDeployment(tx, scope, { includePrevious: true }));
  let phase = 'installation';
  const workers: Awaited<ReturnType<typeof startScopedWorker>>[] = [];
  const native = await openNativeWhiskersReadScope();
  try {
    const publication = await history();
    equal(publication.mappingSha256, mapping.fingerprint);
    equal(publication.deploymentId, deployment.binding.deploymentId);
    equal(publication.releaseOperationId, current.operationId);
    equal(publication.containerId, current.runtime.containerId);
    equal(publication.previous?.releaseOperationId, previous.operationId);
    equal(publication.previous?.manifestDigest, previous.manifestDigest);
    const enrollment = await registerReferenceTarget(input.directory, 'operations-target', {
      environmentId: mapping.environmentId, releaseTargetRevision: mapping.revision, releaseTargetSha256: mapping.fingerprint,
      whiskers: { origin: native.origin, serverId: native.serverId },
    }) as { environmentId: string; fingerprint: string };
    equal(enrollment.environmentId, mapping.environmentId);
    const reader = await deployment.provisionRestartReader();
    notEqual(reader.actorId, deployment.credentials.actorId);
    const adapter = KomodoReleaseClient.readOnly(publication.releaseTarget, reader);
    await adapter.verifyInstallation();
    const provider = { ITERVANE_AUDIT_MODEL_PROVIDER: 'anthropic', ANTHROPIC_BASE_URL: input.modelUrl, ANTHROPIC_MODEL: auditFixtureModel };
    const model = workerConfig({ DATABASE_URL: databaseUrl, ...provider, ANTHROPIC_API_KEY: auditFixtureKey }).auditModel;
    ok(model);
    const { providerSha256 } = configuredAuditModel(model);
    const installed = { ITERVANE_OPERATIONS_ENVIRONMENT_ID: mapping.environmentId,
      ITERVANE_OPERATIONS_ENROLLMENT_SHA256: enrollment.fingerprint, ITERVANE_OPERATIONS_DIAGNOSIS_PROVIDER_SHA256: providerSha256,
      ITERVANE_OPERATIONS_RELEASE_TARGET_SHA256: mapping.fingerprint };
    await input.configureApi({ ...installed, ITERVANE_OPERATIONS_API_ENABLED: '1', ITERVANE_RESTORE_API_ENABLED: '1' });
    const workerEnv = ['PATH=/usr/bin:/bin', 'LANG=C.UTF-8', 'ITERVANE_WORKER_POLL_MS=250', 'ITERVANE_WORKER_LEASE_SECONDS=30',
      ...Object.entries(installed).map(([key, value]) => `${key}=${value}`)];
    workers.push(await startScopedWorker(join(input.shared, 'worker.mjs'), [...workerEnv,
      ...Object.entries(provider).map(([key, value]) => `${key}=${value}`),
    ], { DATABASE_URL: databaseUrl, ANTHROPIC_API_KEY: auditFixtureKey, ITERVANE_OPERATIONS_WHISKERS_READ_KEY: native.readKey }));

    phase = 'stopped_diagnosis';
    await deployment.setOwnedContainerRunning(false, { containerId: current.runtime.containerId,
      reference: current.runtime.imageReference, configDigest: current.runtime.configDigest });
    const activeImage = { manifestDigest: current.manifestDigest, configDigest: current.runtime.configDigest };
    const inspectStopped = () => adapter.inspectStoppedRuntime(publication.releaseTarget, activeImage, current.runtime.network, async () => {});
    const stopped = await inspectStopped();
    equal(stopped.containerId, current.runtime.containerId);
    const { task } = admissionDtoSchema.parse(await read('start_operations_diagnosis', {
      ...scope, expectedReleaseOperationId: current.operationId, idempotencyKey: randomUUID(), locale: 'en',
    }));
    const diagnosis = await untilResult(async () => {
      const result = operationsObservationViewSchema.parse(await read('get_operations_result', { taskId: task.id }));
      ok(!['failed', 'cancelled', 'needs_human'].includes(result.state));
      return result.state === 'succeeded' && result.diagnosis ? result.diagnosis : undefined;
    });
    equal(diagnosis.recommendation.code, 'review_rollback');
    equal(diagnosis.previousReleaseOperationId, previous.operationId);

    phase = 'portal_approval';
    const proposal = operationsProposalViewSchema.parse(await read('request_operations_proposal', {
      taskId: task.id, diagnosisSha256: diagnosis.receiptSha256,
    })).proposal;
    ok(proposal?.kind === 'rollback' && proposal.status === 'pending');
    deepStrictEqual(proposal.current, summary(current));
    deepStrictEqual(proposal.restore, summary(previous));
    const proposalPath = '/v1/operations/proposals/' + proposal.id;
    const receiptPath = '/v1/tasks/' + task.id + '/operations-restore';
    const payload = { fingerprint: proposal.fingerprint, decisionVersion: 1 };
    const submit = (authorization: string) => fetch(input.origin + proposalPath + '/restore', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5_000),
      headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    await page.bringToFront();
    await page.getByRole('combobox', { name: '显示语言', exact: true }).selectOption('en');
    const portalRequest = page.waitForRequest(input.origin + receiptPath);
    await page.evaluate(taskId => { location.hash = '#/tasks/' + taskId; }, task.id);
    const portalAuthorization = await (await portalRequest).headerValue('authorization');
    ok(portalAuthorization && portalAuthorization.startsWith('Bearer '));
    const unapproved = await submit(portalAuthorization);
    await unapproved.body?.cancel();
    equal(unapproved.status, 409);
    equal((await database.pool.query('SELECT id FROM itervane.operations_executions WHERE proposal_id=$1', [proposal.id])).rowCount, 0);
    const decision = page.getByTestId('operations-proposal');
    await decision.getByRole('button', { name: 'Approve action', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Review this action decision' });
    await dialog.getByText(previous.manifestDigest, { exact: true }).waitFor();
    const approved = operationsProposalViewSchema.parse(await portalPost(page, proposalPath + '/decisions',
      dialog.getByRole('button', { name: 'Approve action', exact: true }), 200)).proposal;
    ok(approved?.status === 'confirmed');
    equal(approved.fingerprint, proposal.fingerprint);
    const invalidAudience = await submit('Bearer ' + await input.mcpToken());
    await invalidAudience.body?.cancel();
    equal(invalidAudience.status, 401);
    deepStrictEqual(await inspectStopped(), stopped);

    phase = 'restore_worker';
    const panel = page.getByTestId('operations-restore-execution');
    const queue = { name: 'Queue version restore', exact: true };
    await panel.getByRole('button', queue).click();
    const confirmation = page.getByRole('dialog', { name: 'Queue this approved version restore?' });
    await confirmation.getByText(previous.manifestDigest, { exact: true }).waitFor();
    const { executionId, replayed } = operationsSubmissionSchema.parse(await portalPost(page, proposalPath + '/restore',
      confirmation.getByRole('button', queue), 202));
    equal(replayed, false);
    workers.push(await startScopedWorker(join(input.shared, 'restore-worker.mjs'), [...workerEnv,
      'NODE_EXTRA_CA_CERTS=' + input.ca, 'ITERVANE_RESTORE_KOMODO_READER_ID=' + reader.actorId,
    ], { DATABASE_URL: databaseUrl, ITERVANE_RESTORE_KOMODO_WRITER_KEY: deployment.credentials.key,
      ITERVANE_RESTORE_KOMODO_WRITER_SECRET: deployment.credentials.secret, ITERVANE_RESTORE_KOMODO_READER_KEY: reader.key,
      ITERVANE_RESTORE_KOMODO_READER_SECRET: reader.secret, ITERVANE_RESTORE_PROBE_SECRET: ingress.probeSecret }));

    phase = 'independent_readback';
    const mcp = await untilResult(async () => {
      const result = operationsRestoreExecutionViewSchema.parse(await read('get_operations_restore', { taskId: task.id }));
      ok(!['failed', 'needs_human', 'cancelled'].includes(result.execution?.state ?? ''));
      return result.execution?.state === 'succeeded' ? result : undefined;
    }, 90_000);
    const english = await page.waitForResponse(async response => {
      if (!response.ok() || new URL(response.url()).pathname !== receiptPath) return false;
      const view = operationsRestoreExecutionViewSchema.safeParse(await response.json().catch(() => null));
      return view.success && view.data.locale === 'en' && view.data.execution?.state === 'succeeded';
    });
    deepStrictEqual(operationsRestoreExecutionViewSchema.parse(await english.json()), mcp);
    equal(mcp.action, null);
    equal(mcp.execution?.id, executionId);
    equal(mcp.execution?.environmentHeld, false);
    equal(mcp.execution?.recovery?.state, 'verified');
    deepStrictEqual(mcp.execution?.restore, summary(previous));
    await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN');
    await panel.getByText(translate('zh-CN', 'reason.operations_restore_recovery_verified'), { exact: true }).waitFor();

    const { rows } = await database.pool.query(`SELECT recovery.proof, recovery.proof_sha256, intent.restore_plan, effect.state,
      sent.receipt, sent.fence AS send_fence, schedule.wakeup_job_id
      FROM itervane.operations_restore_recoveries recovery
      JOIN itervane.operations_executions effect ON effect.id=recovery.execution_id
      JOIN itervane.operations_execution_intents intent ON intent.execution_id=effect.id
      JOIN itervane.operations_execution_schedules schedule ON schedule.execution_id=effect.id
      JOIN itervane.operations_restore_steps sent ON sent.execution_id=effect.id AND sent.kind='deploy' AND sent.recorded_at IS NOT NULL
      WHERE effect.id=$1 AND recovery.state='verified'`, [executionId]);
    equal(rows.length, 1);
    const row = rows[0]!;
    const proof = operationsRestoreRecoveryProofSchema.parse(row.proof);
    const plan = operationsRestorePlanSchema.parse(row.restore_plan);
    equal(row.proof_sha256, sha256(JSON.stringify(proof)));
    equal(row.proof_sha256, mcp.execution?.recovery?.proof?.proofSha256);
    equal(row.state, 'recovered');
    equal(row.wakeup_job_id, null);
    equal(proof.executionId, executionId);
    equal(proof.planSha256, sha256(JSON.stringify(plan)));
    equal(plan.mappingSha256, mapping.fingerprint);
    equal(plan.current.operationId, current.operationId);
    equal(plan.current.containerId, stopped.containerId);
    equal(plan.restore.manifestDigest, previous.manifestDigest);
    equal(proof.restoreOperationId, previous.operationId);
    equal(proof.runtime.version, previous.runtime.version);
    equal(proof.runtime.imageReference, previous.runtime.imageReference);
    equal(proof.runtime.configDigest, previous.runtime.configDigest);
    equal(proof.runtime.healthStatus, 200);
    notEqual(proof.runtime.containerId, stopped.containerId);
    equal(proof.update.updateId, releaseKomodoUpdateSchema.parse(row.receipt).updateId);
    equal(proof.update.updateId, mcp.execution?.nativeUpdateId);
    notEqual(proof.update.updateId, current.update.updateId);
    notEqual(proof.update.updateId, previous.update.updateId);
    ok(proof.fence > row.send_fence);
    const observed = await adapter.inspectRuntime(publication.releaseTarget, { manifestDigest: previous.manifestDigest,
      configDigest: previous.runtime.configDigest }, previous.runtime.network, async () => {});
    equal(observed.containerId, proof.runtime.containerId);
    const restored = await history();
    ok('restoreExecutionId' in restored);
    equal(restored.releaseOperationId, previous.operationId);
    equal(restored.restoreExecutionId, executionId);
    equal(restored.containerId, observed.containerId);
    const anonymousStatus = await ingress.anonymousHealthStatus();
    ok(anonymousStatus === 401 || anonymousStatus === 403);
    equal((await database.pool.query('SELECT task_id FROM itervane.execution_slot WHERE id=1')).rows[0]?.task_id, null);
    return { taskId: task.id, runId: task.runId, executionId, current: summary(current), previous: summary(previous),
      restored: { operationId: restored.releaseOperationId, manifestDigest: restored.manifestDigest, version: proof.runtime.version,
        updateId: proof.update.updateId, containerId: observed.containerId },
      currentContainerId: stopped.containerId, sendFence: row.send_fence as number, readFence: proof.fence,
      diagnosisSha256: diagnosis.receiptSha256, proposalSha256: proposal.fingerprint, planSha256: proof.planSha256,
      recoverySha256: sha256Schema.parse(row.proof_sha256), healthStatus: proof.runtime.healthStatus, anonymousStatus,
      pendingDenied: true, mcpSubmissionDenied: true, portalApproval: true, independentReader: true, bilingualPortalAndMcp: true,
      executionSlotReleased: true };
  } catch {
    throw new Error('reference_restore_' + phase);
  } finally {
    const stopped = await Promise.allSettled(workers.map(worker => worker.stop('TERM')));
    await native.close();
    if (stopped.some(result => result.status === 'rejected')) throw new Error('reference_restore_cleanup');
  }
}
