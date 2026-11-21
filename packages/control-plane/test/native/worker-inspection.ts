import { deepStrictEqual, equal, match, notEqual, ok } from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  admissionDtoSchema, auditFindingsPerScan, formalAuditDtoSchema, formalRepairDtoSchema, formalRepairPatchDtoSchema, idSchema, projectDtoSchema,
  repositoryDtoSchema, sha256Schema, sourceInspectionDtoSchema,
  qualifiedRepairObservationResponseSchema, qualifiedRepairResponseSchema, taskDtoSchema, taskEventDtoSchema, translate,
} from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { createApi } from '../../src/api.js';
import { bootstrapOwner } from '../../src/service/resources.js';
import { databaseFixture } from '../helpers/database.js';
import { identityFixture } from '../helpers/identity.js';
import { temporaryPostgres } from '../../../verification/src/postgres-fixture.js';
import { sourceFingerprint } from '../../../verification/src/report.js';
import { auditFixtureKey, auditFixtureModel, auditProtocolFixture } from './audit-provider.js';

const execute = promisify(execFile);
const commit = '9167604c888416d7b6518e1c76485d7308cffb5c';
const origin = 'https://github.com/MaLaNg116/itervane.git';
const publicUrl = 'https://itervane.example';
const controllerAccount = 'itervane-probe';
const workerAccount = 'itervane-inspection-client';
const domainName = /^itervane-d2-[a-f0-9-]{36}$/;
let phase = 'configuration';

async function poll<T>(read: () => Promise<T | undefined>, timeoutMs: number, label: string): Promise<T> {
  const until = performance.now() + timeoutMs;
  while (performance.now() < until) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(200);
  }
  throw new Error(`${label}_timeout`);
}

function exitStatus(child: ChildProcess) {
  return new Promise<number | null>(resolve => {
    child.once('error', () => resolve(null));
    child.once('close', code => resolve(code));
  });
}

async function firstLine(child: ChildProcess) {
  if (!child.stdout) throw new Error('probe_stdout');
  const lines = createInterface({ input: child.stdout });
  try {
    const [first] = await once(lines, 'line', { signal: AbortSignal.timeout(8_000) });
    return String(first);
  } finally { lines.close(); child.stdout.resume(); }
}

async function boundedExit(child: ChildProcess, exit: Promise<number | null>, timeMs: number) {
  const timeout = new AbortController();
  try {
    return await Promise.race([exit, delay(timeMs, undefined, { signal: timeout.signal }).then(() => {
      child.kill();
      throw new Error('process_exit_timeout');
    })]);
  } finally { timeout.abort(); }
}

function sourceWorkerEnvironment(socket: string, controllerUid: string, image: string) {
  return ['PATH=/usr/bin:/bin', 'LANG=C.UTF-8', `ITERVANE_RUNNER_SOCKET=${socket}`,
    `ITERVANE_RUNNER_UID=${controllerUid}`, `ITERVANE_RUNNER_IMAGE_SHA256=${image}`, 'ITERVANE_WORKER_LEASE_SECONDS=30'];
}

async function startWorker(bundle: string, socket: string, controllerUid: string, image: string, databaseUrl: string, auditURL?: string) {
  const child = spawn('/usr/bin/sudo', ['-n', '-u', workerAccount, '--', '/usr/bin/env', '-i', ...sourceWorkerEnvironment(socket, controllerUid, image),
    ...(auditURL ? ['ITERVANE_AUDIT_MODEL_PROVIDER=anthropic', `ANTHROPIC_BASE_URL=${auditURL}`,
      `ANTHROPIC_MODEL=${auditFixtureModel}`, `ANTHROPIC_API_KEY=${auditFixtureKey}`] : []),
    'ITERVANE_WORKER_POLL_MS=100', '/usr/bin/setpriv', '--no-new-privs', '/bin/bash', '-c',
    'set -eu; IFS= read -r DATABASE_URL; export DATABASE_URL; printf "%s\\n" "$$"; exec "$@"', 'itervane-worker', process.execPath, bundle,
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exit = exitStatus(child);
  child.stderr.resume();
  child.stdin.on('error', () => undefined);
  const pidLine = firstLine(child);
  child.stdin.end(`${databaseUrl}\n`);
  try {
    const pid = await pidLine;
    match(pid, /^[1-9][0-9]{0,9}$/);
    let stopped = false;
    return { pid, async stop(mode: 'TERM' | 'KILL') {
      if (stopped) return;
      stopped = true;
      await execute('/usr/bin/sudo', ['-n', '-u', workerAccount, '--', '/bin/kill', `-${mode}`, pid], { timeout: 5_000 });
      const code = await boundedExit(child, exit, 15_000);
      if (mode === 'TERM') equal(code, 0);
      else notEqual(code, 0);
    } };
  } catch (error) { child.kill(); await boundedExit(child, exit, 5_000); throw error; }
}

async function runRepairWorker(bundle: string, socket: string, controllerUid: string, image: string, databaseUrl: string, args: string[]) {
  const child = spawn('/usr/bin/sudo', ['-n', '-u', workerAccount, '--', '/usr/bin/env', '-i', ...sourceWorkerEnvironment(socket, controllerUid, image),
    '/usr/bin/setpriv', '--no-new-privs', '/bin/bash', '-c', 'set -eu; IFS= read -r DATABASE_URL; export DATABASE_URL; exec "$@"',
    'itervane-repair-worker', process.execPath, bundle, ...args,
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exit = exitStatus(child);
  child.stderr.resume();
  child.stdin.on('error', () => undefined);
  child.stdin.end(databaseUrl + '\n');
  let size = 0;
  const output: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > 32768) child.kill();
    else output.push(chunk);
  });
  equal(await boundedExit(child, exit, 385_000), 0);
  const response = JSON.parse(Buffer.concat(output).toString('utf8'));
  const receipt = qualifiedRepairResponseSchema.parse(response.receipt);
  const observation = qualifiedRepairObservationResponseSchema.parse(response.observation);
  if (receipt.kind !== 'repair_receipt' || observation.kind !== 'repair_observation') throw new Error('worker_repair_missing_receipt');
  const { checkpointId, callKeySha256, trace, usage, releaseEligible, resultSha256 } = response.agent;
  deepStrictEqual(trace, ['read_repair_targets', 'apply_repair_patch']);
  deepStrictEqual(usage, { turns: 3, toolCalls: 2, tokens: 90 });
  equal(releaseEligible, false);
  return { receipt, observation, agent: { checkpointId: idSchema.parse(checkpointId), callKeySha256: sha256Schema.parse(callKeySha256),
    trace, usage, releaseEligible, resultSha256: sha256Schema.parse(resultSha256),
  } };
}

async function hostsDomains(controllerUid: string, filter: '--all' | '--state-running') {
  const result = await execute('/usr/bin/sudo', ['-n', '-u', controllerAccount, '--', '/usr/bin/env', '-i',
    `XDG_RUNTIME_DIR=/run/user/${controllerUid}`, '/usr/bin/virsh', '--connect', 'qemu:///session', 'list', '--name', filter], { timeout: 5_000 });
  return result.stdout.trim();
}

async function assertDrained(controllerUid: string, staging: string) {
  await poll(async () => {
    const [domains, work] = await Promise.all([
      hostsDomains(controllerUid, '--all'), execute('/usr/bin/sudo', ['-n', '/usr/bin/find', staging, '-mindepth', '1', '-print', '-quit'], { timeout: 5_000 }),
    ]);
    return !domains && !work.stdout ? true : undefined;
  }, 8_000, 'workspace_cleanup');
}

async function watchGuest(controllerUid: string) {
  const domain = await poll(async () => {
    const name = await hostsDomains(controllerUid, '--state-running');
    return domainName.test(name) ? name : undefined;
  }, 80_000, 'running_domain');
  const child = spawn('/usr/bin/sudo', ['-n', '/usr/bin/python3', '-I', '-B', 'fixtures/runner/watch-guest-exit.py', controllerUid, domain],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = exitStatus(child);
  child.stderr?.resume();
  try { equal(await firstLine(child), 'ready'); }
  catch (error) { child.kill(); await boundedExit(child, exit, 5_000); throw error; }
  return { domainId: domain.slice('itervane-d2-'.length), async confirm() { equal(await boundedExit(child, exit, 28_000), 0); } };
}

async function probe() {
  const [bundle, socket, controllerUid, imageSha256, staging, repairBundle, ...extra] = process.argv.slice(2);
  if (process.platform !== 'linux' || process.env.PROBE_HOST_ENVIRONMENT !== 'github-hosted' || process.env.DATABASE_URL
    || process.env.ITERVANE_POSTGRES_IMAGE || extra.length || !bundle?.startsWith('/var/lib/libvirt/images/itervane-native.')
    || !socket?.endsWith('/qualified/inspection.sock') || !controllerUid || !/^[1-9][0-9]{0,9}$/.test(controllerUid)
    || !imageSha256 || !/^[a-f0-9]{64}$/.test(imageSha256) || !staging?.endsWith('/staging')
    || repairBundle !== bundle.replace(/\/worker\.mjs$/, '/repair-worker.mjs')) throw new Error('worker_probe_config');

  phase = 'postgres';
  const postgres = await temporaryPostgres();
  let database: Awaited<ReturnType<typeof databaseFixture>> | undefined;
  let identity: Awaited<ReturnType<typeof identityFixture>> | undefined;
  let api: ReturnType<typeof createApi> | undefined;
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  let auditProvider: Awaited<ReturnType<typeof auditProtocolFixture>> | undefined;
  const client = new Client({ name: 'itervane-native-worker', version: '0.0.0' });
  try {
    const db = database = await databaseFixture(postgres.url);
    const oidc = identity = await identityFixture();
    await bootstrapOwner(db.storage, { issuer: oidc.config.issuer, subject: 'owner' });
    api = createApi(db.storage, { ...oidc.config, publicUrl }, { logger: false });
    const address = await api.listen({ host: '127.0.0.1', port: 0 });
    const authorization = async () => `Bearer ${await oidc.token()}`;
    const request = async (path: string, payload?: object) => {
      const response = await fetch(`${address}${path}`, { method: payload ? 'POST' : 'GET', signal: AbortSignal.timeout(5_000),
        headers: { Authorization: await authorization(), ...(payload ? { 'content-type': 'application/json' } : {}) },
        ...(payload ? { body: JSON.stringify(payload) } : {}) });
      equal(response.ok, true, path);
      return response.json() as Promise<unknown>;
    };
    const project = projectDtoSchema.parse(await request('/v1/projects', { name: 'Native inspection fixture', slug: 'native-inspection' }));
    const repository = repositoryDtoSchema.parse(await request(`/v1/projects/${project.id}/repositories`, { name: 'Fixed source', url: origin }));
    const mcpToken = await oidc.token('owner', { aud: `${publicUrl}/mcp`, scope: 'itervane:read itervane:write', exp: Math.floor(Date.now() / 1_000) + 1_200 });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${mcpToken}`, 'Accept-Language': 'zh-CN' } },
    }));
    const start = async (purpose: string) => admissionDtoSchema.parse((await client.callTool({ name: 'start_audit', arguments: {
      projectId: project.id, source: { repositoryId: repository.id, commit }, dataClass: 'public', purpose, locale: 'zh-CN', idempotencyKey: randomUUID(),
    } })).structuredContent).task;
    const reached = (taskId: string, state: string) => poll(async () => {
      const row = (await db.admin.query('SELECT state FROM itervane.tasks WHERE id=$1', [taskId])).rows[0];
      return row?.state === state ? true : undefined;
    }, 190_000, state);
    const attempts = async (taskId: string) => (await db.admin.query(`SELECT request_id, state, fence, settled_fence, workspace_sha256,
      receipt_sha256, receipt->>'domainId' AS domain_id, receipt#>>'{snapshot,tree}' AS tree
      FROM itervane.inspection_attempts WHERE task_id=$1 ORDER BY fence`, [taskId])).rows;
    const summary = async (taskId: string) => {
      const mcp = sourceInspectionDtoSchema.parse((await client.callTool({ name: 'get_source_inspection', arguments: { taskId } })).structuredContent);
      deepStrictEqual(sourceInspectionDtoSchema.parse(await request(`/v1/tasks/${taskId}/source-inspection`)), mcp);
      return mcp;
    };
    const checkedScan = async (taskId: string) => {
      const scan = await summary(taskId);
      if (scan.status !== 'completed') throw new Error('native_scan_missing');
      equal(scan.result.files, 305);
      const [gitleaks, trivy] = scan.result.scans;
      equal(gitleaks.scanner, 'gitleaks'); equal(gitleaks.findingsCount, 1);
      equal(trivy.scanner, 'trivy'); ok(trivy.findingsCount > 0 && trivy.database?.sha256);
      return scan;
    };

    phase = 'scan_and_shared_reads';
    worker = await startWorker(bundle, socket, controllerUid, imageSha256, db.runtimeUrl);
    const first = await start('Scan a fixed native test revision');
    await reached(first.id, 'waiting_input');
    const scan = await checkedScan(first.id);
    const [recorded] = await attempts(first.id);
    equal(recorded.receipt_sha256, scan.result.receiptSha256);
    equal(recorded.request_id, scan.result.requestId);
    equal(recorded.tree, '8eef89792444aea73d0aa90b87e552bbfc2d25d9');
    const messages = (await client.callTool({ name: 'get_task_events', arguments: { taskId: first.id } })).structuredContent as { items: unknown[] };
    equal(taskEventDtoSchema.parse(messages.items.at(-1)).reasonMessage, translate('zh-CN', 'tool.inspection_ready'));
    await assertDrained(controllerUid, staging);

    phase = 'cancellation';
    const cancelled = await start('Cancel a running native inspection');
    const cancelledGuest = await watchGuest(controllerUid);
    phase = 'cancellation_request';
    const running = taskDtoSchema.parse(await request(`/v1/tasks/${cancelled.id}`));
    equal(taskDtoSchema.parse(await request(`/v1/tasks/${cancelled.id}/cancel`, { expectedVersion: running.version })).state, 'cancel_requested');
    phase = 'cancellation_process_exit';
    await cancelledGuest.confirm();
    phase = 'cancellation_task_state';
    await reached(cancelled.id, 'cancelled'); await assertDrained(controllerUid, staging);
    phase = 'cancellation_settlement';
    const [cancelledAttempt] = await attempts(cancelled.id);
    equal(cancelledAttempt.state, 'closed'); equal(cancelledAttempt.receipt_sha256, null);

    phase = 'revocation';
    const revoked = await start('Revoke project permission during native inspection');
    const revokedGuest = await watchGuest(controllerUid);
    const [grant] = (await db.admin.query('DELETE FROM itervane.workspace_members RETURNING workspace_id, principal_id')).rows;
    phase = 'revocation_read_permission';
    equal((await fetch(`${address}/v1/tasks/${revoked.id}/source-inspection`, { headers: { Authorization: await authorization() } })).status, 404);
    phase = 'revocation_process_exit';
    await revokedGuest.confirm(); await reached(revoked.id, 'needs_human'); await assertDrained(controllerUid, staging);
    phase = 'revocation_settlement';
    const [revokedAttempt] = await attempts(revoked.id);
    equal(revokedAttempt.state, 'closed'); equal(revokedAttempt.receipt_sha256, null);
    equal((await db.admin.query('SELECT reason FROM itervane.run_runtime WHERE run_id=$1', [revoked.runId])).rows[0]?.reason, 'permission_revoked');
    await db.admin.query('INSERT INTO itervane.workspace_members(workspace_id,principal_id) VALUES($1,$2)', [grant.workspace_id, grant.principal_id]);

    phase = 'worker_crash_and_recovery';
    const recovered = await start('Recover a crashed Worker in the original native workspace');
    const crashedGuest = await watchGuest(controllerUid);
    phase = 'worker_crash_process_exit';
    const oldPid = worker.pid;
    await worker.stop('KILL'); worker = undefined;
    await crashedGuest.confirm(); await assertDrained(controllerUid, staging);
    const [unsettled] = await attempts(recovered.id);
    equal(unsettled.state, 'reserved'); equal(unsettled.receipt_sha256, null);
    phase = 'worker_replacement';
    worker = await startWorker(bundle, socket, controllerUid, imageSha256, db.runtimeUrl);
    notEqual(worker.pid, oldPid);
    await reached(recovered.id, 'waiting_input');
    phase = 'worker_recovery_settlement';
    const recoveredScan = await checkedScan(recovered.id);
    const [closed, replacement] = await attempts(recovered.id);
    equal(closed.state, 'closed'); equal(closed.request_id, unsettled.request_id);
    equal(closed.receipt_sha256, null); equal(closed.settled_fence, replacement.fence);
    equal(closed.workspace_sha256, replacement.workspace_sha256);
    ok(replacement.fence > closed.fence); equal(replacement.receipt_sha256, recoveredScan.result.receiptSha256);
    await assertDrained(controllerUid, staging);
    const domains = [recorded.domain_id, cancelledGuest.domainId, revokedGuest.domainId, crashedGuest.domainId, replacement.domain_id];
    equal(new Set(domains).size, 5);

    phase = 'formal_audit_start';
    await worker.stop('TERM'); worker = undefined;
    const provider = auditProvider = await auditProtocolFixture();
    worker = await startWorker(bundle, socket, controllerUid, imageSha256, db.runtimeUrl, provider.baseURL);
    const finishAudit = async (taskId: string) => {
      const waiting = taskDtoSchema.parse(await request(`/v1/tasks/${taskId}`));
      equal(waiting.state, 'waiting_input');
      equal(taskDtoSchema.parse(await request(`/v1/tasks/${taskId}/resume`, { expectedVersion: waiting.version })).state, 'queued');
      const [pointer] = await poll(async () => {
        const rows = (await db.admin.query(`SELECT result.checkpoint_id, result.sha256, runtime.reason
          FROM itervane.formal_audit_results result
          JOIN itervane.run_runtime runtime ON runtime.run_id = result.run_id WHERE result.run_id=$1`, [waiting.runId])).rows;
        return rows.length ? rows : undefined;
      }, 90_000, 'formal_audit_record');
      const view = formalAuditDtoSchema.parse((await client.callTool({ name: 'get_audit', arguments: { taskId } })).structuredContent);
      const http = formalAuditDtoSchema.parse(await request(`/v1/tasks/${taskId}/audit`));
      if (view.status !== 'recorded' || http.status !== 'recorded') throw new Error('formal_audit_unpublished');
      deepStrictEqual(http.result, view.result); equal(http.sha256, view.sha256);
      equal(view.locale, 'zh-CN'); equal(http.locale, 'en'); notEqual(http.message, view.message);
      equal(view.result.checkpointId, pointer.checkpoint_id); equal(view.sha256, pointer.sha256);
      return { ...view, taskReason: pointer.reason };
    };
    phase = 'formal_audit_checklist';
    const reviewed = await finishAudit(first.id);
    const partial = scan.result.scans.some(item => item.findingsCount > auditFindingsPerScan);
    equal(reviewed.result.reason, partial ? 'audit_incomplete' : 'audit_complete');
    equal(reviewed.taskReason, partial ? 'audit_needs_human' : 'audit_ready');
    equal(reviewed.result.inspectionSha256, recorded.receipt_sha256);
    equal(reviewed.result.snapshotSha256, scan.result.snapshotSha256);
    const checklist = reviewed.result.checklist;
    ok(checklist);
    equal(checklist.coverage, partial ? 'partial' : 'complete');
    ok(checklist.findings.some(item => item.scanner === 'gitleaks' && item.certainty === 'suspected'));
    ok(checklist.findings.some(item => item.scanner === 'trivy' && item.certainty === 'confirmed'));
    deepStrictEqual(reviewed.result.trace.map(item => item.tool), ['read_scan', 'read_rule', 'read_scan']);
    deepStrictEqual(reviewed.result.usage, { turns: 4, toolCalls: 3, tokens: 188 });
    deepStrictEqual(await attempts(first.id), [recorded]);

    phase = 'formal_audit_provider_failure';
    provider.fail();
    const failed = await finishAudit(recovered.id);
    equal(failed.result.reason, 'provider_error'); equal(failed.taskReason, 'audit_needs_human');
    equal(failed.result.checklist, null); equal(failed.result.inspectionSha256, replacement.receipt_sha256);
    deepStrictEqual(failed.result.usage, { turns: 2, toolCalls: 1, tokens: 47 });
    deepStrictEqual(failed.result.evidence.map(item => item.kind === 'scan' && item.scanner), ['gitleaks']);
    deepStrictEqual(provider.calls, ['read_scan', 'read_rule', 'read_scan', 'finish_role', 'read_scan', 'unavailable']);
    deepStrictEqual(await attempts(recovered.id), [closed, replacement]);
    await assertDrained(controllerUid, staging);

    phase = 'formal_repair_execution';
    await worker.stop('TERM'); worker = undefined;
    const fixture = checklist.findings.find(item => item.scanner === 'gitleaks'
      && item.path === 'fixtures/runner/inspection-input/original/config.txt');
    ok(fixture);
    const audited = taskDtoSchema.parse(await request(`/v1/tasks/${first.id}`));
    const queuedRepair = taskDtoSchema.parse(await request(`/v1/tasks/${first.id}/resume`, { expectedVersion: audited.version }));
    equal(queuedRepair.state, 'queued');
    equal(queuedRepair.runId, audited.runId);
    const { receipt, observation, agent } = await runRepairWorker(repairBundle, socket, controllerUid, imageSha256, db.runtimeUrl,
      [first.id, first.runId, scan.result.snapshotSha256, fixture.id]);
    equal(receipt.scope.taskId, first.id); equal(receipt.scope.runId, first.runId);
    equal(receipt.snapshot.manifestSha256, scan.result.snapshotSha256);
    ok(!domains.includes(receipt.domainId));
    equal(observation.scope.taskId, first.id);
    equal(observation.scope.runId, first.runId);
    equal(observation.scope.fence, receipt.scope.fence);
    equal(observation.snapshot.manifestSha256, scan.result.snapshotSha256);
    ok(!domains.includes(observation.domainId) && observation.domainId !== receipt.domainId);
    const [target] = observation.snapshot.observation.targets;
    ok(target?.range && target.file);
    equal(target.findingId, fixture.id); equal(target.path, fixture.path); equal(target.line, fixture.line);
    const expectedRanges = [
      { startByte: 0, endByte: 64, sha256: '9e731d16ffa25e5ab728cbf80aa67ba3deb9f130f9e30e243dc02b317944360d' },
      { startByte: 64, endByte: 158, sha256: '50541d94c77cbc185ee497cfcba79834161ad445f55c99466a4c7ece414e5659' },
    ];
    ok(fixture.line !== null);
    deepStrictEqual(target.range, expectedRanges[fixture.line - 1]);
    const [change] = receipt.snapshot.candidate.changes;
    const expectedChanges = [
      { afterBytes: 132, afterSha256: 'fb91303fd77793f09cf354f0640130d40dba8ad64ce3b2e64fc42d4a9b8a8624' },
      { afterBytes: 102, afterSha256: 'f0d9a041c470d2a1c77ec6ce2a042a3f8eccb2cc98fc3d79ad0770709364a3f9' },
    ];
    deepStrictEqual(change, { path: fixture.path, beforeBytes: 158, edits: 1,
      beforeSha256: '3812bc54c3579d8c67275c573f0ff1bf7dde70bfb4a9150621459ae510a87afc',
      ...expectedChanges[fixture.line - 1] });
    const saved = (await db.admin.query(`SELECT operation.command_sha256, operation.finding_ids, operation.call_key_sha256,
      attempt.state, attempt.receipt_sha256, runtime.checkpoint_id, runtime.published_fence
      FROM itervane.formal_repair_operations operation JOIN itervane.formal_repair_attempts attempt USING(operation_id)
      JOIN itervane.formal_repair_runtime runtime ON runtime.run_id=operation.run_id
      WHERE operation.run_id=$1`, [first.runId])).rows;
    const receiptSha256 = sha256(JSON.stringify(receipt));
    deepStrictEqual(saved, [{ command_sha256: receipt.scope.commandSha256, finding_ids: [fixture.id], state: 'recorded',
      receipt_sha256: receiptSha256, checkpoint_id: agent.checkpointId, published_fence: receipt.scope.fence, call_key_sha256: agent.callKeySha256,
    }]);
    const repairUrl = `/v1/tasks/${first.id}/repair`;
    const repairView = formalRepairDtoSchema.parse(await request(repairUrl));
    const externalView = formalRepairDtoSchema.parse((await client.callTool({ name: 'get_repair', arguments: { taskId: first.id } })).structuredContent);
    if (repairView.status !== 'recorded' || externalView.status !== 'recorded'
      || repairView.result.status !== 'candidate_ready') throw new Error('native_repair_candidate_missing');
    equal(repairView.sha256, agent.resultSha256);
    equal(externalView.sha256, repairView.sha256);
    deepStrictEqual(repairView.result, externalView.result);
    equal(repairView.result.candidate.receiptSha256, receiptSha256);
    deepStrictEqual(repairView.result.candidate.changes, receipt.snapshot.candidate.changes);
    const exported = formalRepairPatchDtoSchema.parse(await request(`${repairUrl}/patch?expectedSha256=${repairView.sha256}`));
    equal(exported.patchSha256, receipt.snapshot.candidate.patchSha256);
    equal(sha256(JSON.stringify(exported.patch)), exported.patchSha256);
    const resultTask = taskDtoSchema.parse(await request(`/v1/tasks/${first.id}`));
    equal(resultTask.state, 'waiting_input');
    const repairEvents = (await client.callTool({ name: 'get_task_events', arguments: { taskId: first.id } })).structuredContent as { items: unknown[] };
    equal(taskEventDtoSchema.parse(repairEvents.items.at(-1)).reason, 'repair_ready');
    const activeSlot = (await db.admin.query('SELECT task_id FROM itervane.execution_slot WHERE id=1')).rows[0];
    equal(activeSlot?.task_id, null);
    await assertDrained(controllerUid, staging);
    return { sourceFingerprint: await sourceFingerprint(), postgres: postgres.version, imageSha256, commit, domains,
      initial: scan.result, replacement: recoveredScan.result, previousFence: closed.fence, recoveredFence: replacement.fence,
      cancellation: { processExited: true, closed: true, receiptPublished: false },
      revocation: { processExited: true, closed: true, receiptPublished: false },
      recovery: { processExited: true, originalWorkspace: true, replacedWorker: true },
      httpMcpAgreement: true, stagedFilesRemaining: false,
      audit: { mode: 'deterministic_anthropic_http_fixture',
        checklist: { sha256: reviewed.sha256, inspectionSha256: reviewed.result.inspectionSha256, reason: reviewed.result.reason,
          coverage: checklist.coverage, findings: checklist.findings.length, trace: reviewed.result.trace.map(item => item.tool), usage: reviewed.result.usage },
        interrupted: { sha256: failed.sha256, inspectionSha256: failed.result.inspectionSha256, reason: failed.result.reason, usage: failed.result.usage },
        httpMcpAgreement: true, reusedRecordedScans: true },
      repair: { operationId: receipt.scope.operationId, requestId: receipt.scope.requestId, fence: receipt.scope.fence,
        domainId: receipt.domainId, receiptSha256, baseSnapshotSha256: receipt.scope.baseSnapshotSha256,
        candidateManifestSha256: receipt.snapshot.candidate.candidateManifestSha256, change, cleanupConfirmed: true,
        agent: { ...agent, mode: 'deterministic_model_fixture' },
        candidatePublished: true, queuedThroughApi: true, httpMcpAgreement: true, patchSha256: exported.patchSha256, slotReleased: true,
        observation: { domainId: observation.domainId, status: target.status, file: target.file, range: target.range, cleanupConfirmed: true } },
    };
  } finally {
    try { await worker?.stop('TERM'); }
    finally {
      await auditProvider?.close(); await client.close(); await api?.close(); await identity?.close(); await database?.close(); await postgres.close();
    }
  }
}

try { console.log(JSON.stringify(await probe())); }
catch (error) {
  const message = error instanceof Error && /^[a-z_]+_timeout$/.test(error.message) ? ` (${error.message})` : '';
  console.error(`Native Worker inspection failed during ${phase}${message}.`);
  process.exitCode = 1;
}
