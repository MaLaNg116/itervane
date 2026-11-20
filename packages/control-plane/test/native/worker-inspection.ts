import { deepStrictEqual, equal, match, notEqual, ok } from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  admissionDtoSchema, projectDtoSchema, repositoryDtoSchema, sourceInspectionDtoSchema, taskDtoSchema, taskEventDtoSchema, translate,
} from '@itervane/contracts';
import { createApi } from '../../src/api.js';
import { bootstrapOwner } from '../../src/service/resources.js';
import { databaseFixture } from '../helpers/database.js';
import { identityFixture } from '../helpers/identity.js';
import { temporaryPostgres } from '../../../verification/src/postgres-fixture.js';
import { sourceFingerprint } from '../../../verification/src/report.js';

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

async function startWorker(bundle: string, socket: string, controllerUid: string, image: string, databaseUrl: string) {
  const child = spawn('/usr/bin/sudo', ['-n', '-u', workerAccount, '--', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'LANG=C.UTF-8',
    `ITERVANE_RUNNER_SOCKET=${socket}`, `ITERVANE_RUNNER_UID=${controllerUid}`, `ITERVANE_RUNNER_IMAGE_SHA256=${image}`,
    'ITERVANE_WORKER_LEASE_SECONDS=6', 'ITERVANE_WORKER_POLL_MS=100', '/usr/bin/setpriv', '--no-new-privs', '/bin/bash', '-c',
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
  const [bundle, socket, controllerUid, imageSha256, staging, ...extra] = process.argv.slice(2);
  if (process.platform !== 'linux' || process.env.PROBE_HOST_ENVIRONMENT !== 'github-hosted' || process.env.DATABASE_URL
    || process.env.ITERVANE_POSTGRES_IMAGE || extra.length || !bundle?.startsWith('/var/lib/libvirt/images/itervane-native.')
    || !socket?.endsWith('/qualified/inspection.sock') || !controllerUid || !/^[1-9][0-9]{0,9}$/.test(controllerUid)
    || !imageSha256 || !/^[a-f0-9]{64}$/.test(imageSha256) || !staging?.endsWith('/staging')) throw new Error('worker_probe_config');

  phase = 'postgres';
  const postgres = await temporaryPostgres();
  let database: Awaited<ReturnType<typeof databaseFixture>> | undefined;
  let identity: Awaited<ReturnType<typeof identityFixture>> | undefined;
  let api: ReturnType<typeof createApi> | undefined;
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
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
    const running = taskDtoSchema.parse(await request(`/v1/tasks/${cancelled.id}`));
    equal(taskDtoSchema.parse(await request(`/v1/tasks/${cancelled.id}/cancel`, { expectedVersion: running.version })).state, 'cancel_requested');
    await cancelledGuest.confirm(); await reached(cancelled.id, 'cancelled'); await assertDrained(controllerUid, staging);
    const [cancelledAttempt] = await attempts(cancelled.id);
    equal(cancelledAttempt.state, 'closed'); equal(cancelledAttempt.receipt_sha256, null);

    phase = 'revocation';
    const revoked = await start('Revoke project permission during native inspection');
    const revokedGuest = await watchGuest(controllerUid);
    const [grant] = (await db.admin.query('DELETE FROM itervane.workspace_members RETURNING workspace_id, principal_id')).rows;
    equal((await fetch(`${address}/v1/tasks/${revoked.id}/source-inspection`, { headers: { Authorization: await authorization() } })).status, 404);
    await revokedGuest.confirm(); await reached(revoked.id, 'needs_human'); await assertDrained(controllerUid, staging);
    const [revokedAttempt] = await attempts(revoked.id);
    equal(revokedAttempt.state, 'closed'); equal(revokedAttempt.receipt_sha256, null);
    await db.admin.query('INSERT INTO itervane.workspace_members(workspace_id,principal_id) VALUES($1,$2)', [grant.workspace_id, grant.principal_id]);

    phase = 'worker_crash_and_recovery';
    const recovered = await start('Recover a crashed Worker in the original native workspace');
    const crashedGuest = await watchGuest(controllerUid);
    const oldPid = worker.pid;
    await worker.stop('KILL'); worker = undefined;
    await crashedGuest.confirm(); await assertDrained(controllerUid, staging);
    const [unsettled] = await attempts(recovered.id);
    equal(unsettled.state, 'reserved'); equal(unsettled.receipt_sha256, null);
    worker = await startWorker(bundle, socket, controllerUid, imageSha256, db.runtimeUrl);
    notEqual(worker.pid, oldPid);
    await reached(recovered.id, 'waiting_input');
    const recoveredScan = await checkedScan(recovered.id);
    const [closed, replacement] = await attempts(recovered.id);
    equal(closed.state, 'closed'); equal(closed.request_id, unsettled.request_id);
    equal(closed.receipt_sha256, null); equal(closed.settled_fence, replacement.fence);
    equal(closed.workspace_sha256, replacement.workspace_sha256);
    ok(replacement.fence > closed.fence); equal(replacement.receipt_sha256, recoveredScan.result.receiptSha256);
    await assertDrained(controllerUid, staging);
    const domains = [recorded.domain_id, cancelledGuest.domainId, revokedGuest.domainId, crashedGuest.domainId, replacement.domain_id];
    equal(new Set(domains).size, 5);
    return { sourceFingerprint: await sourceFingerprint(), postgres: postgres.version, imageSha256, commit, domains,
      initial: scan.result, replacement: recoveredScan.result, previousFence: closed.fence, recoveredFence: replacement.fence,
      cancellation: { processExited: true, closed: true, receiptPublished: false },
      revocation: { processExited: true, closed: true, receiptPublished: false },
      recovery: { processExited: true, originalWorkspace: true, replacedWorker: true },
      httpMcpAgreement: true, stagedFilesRemaining: false };
  } finally {
    try { await worker?.stop('TERM'); }
    finally {
      await client.close(); await api?.close(); await identity?.close(); await database?.close(); await postgres.close();
    }
  }
}

try { console.log(JSON.stringify(await probe())); }
catch { console.error(`Native Worker inspection failed during ${phase}.`); process.exitCode = 1; }
