import { deepStrictEqual, equal, match, notEqual, ok, rejects } from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { promisify } from 'node:util';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  admissionDtoSchema, applicationDtoSchema, auditFindingsPerScan, environmentDtoSchema, formalAuditDtoSchema, formalReleaseCandidateDtoSchema,
  formalRepairDtoSchema, formalRepairPatchDtoSchema, formalReleaseResultSchema, formalReleaseViewSchema, idSchema, komodoResourceIdSchema, projectDtoSchema,
  formalRepairRetrySchema, formalVerificationInputSchema, formalVerificationResultSchema, operationsDiagnosisReceiptSchema,
  operationsObservationReceiptSchema, operationsObservationViewSchema, operationsRestartInstallationSchema,
  qualifiedVerificationResponseSchema, standardVerificationProfileSchema,
  repositoryDtoSchema, releaseRegistryImageProofSchema, releaseRolloutProofSchema, sha256Schema, sourceInspectionDtoSchema,
  qualifiedImageArchiveSchema, qualifiedRepairObservationResponseSchema, qualifiedRepairResponseSchema, qualifiedStandardBuildProofSchema,
  taskDtoSchema, taskEventDtoSchema, taskEventReasonSchema, translate,
  type FormalAuditResult, type Locale, type NpmUpgradeApproval, type StandardVerificationProfile, type TaskDto,
} from '@itervane/contracts';
import { scannerProfiles, sha256 } from '@itervane/runner';
import { createApi } from '../../src/api.js';
import { createIdentityVerifier } from '../../src/auth/identity.js';
import { restoreWorkerConfig, runtimeConfig, workerConfig } from '../../src/config.js';
import { formalReleaseQueue } from '../../src/persistence/database.js';
import { ExecutionCoordinator } from '../../src/runtime/coordinator.js';
import { configuredAuditModel } from '../../src/runtime/formal-audit.js';
import { FormalReleaseCoordinator } from '../../src/runtime/formal-release-claim.js';
import { createInstalledApi } from '../../src/runtime/installed-api.js';
import { createInstalledRestoreWorker } from '../../src/runtime/installed-restore-worker.js';
import { KomodoReleaseClient } from '../../src/runtime/release-komodo.js';
import { createKeycloakRolloutTokenSource, ReleaseRolloutVerifier } from '../../src/runtime/release-rollout.js';
import { ReleaseIngressError } from '../../src/runtime/release-traefik.js';
import { readPublishedOperationsDeployment } from '../../src/service/operations-deployment.js';
import { changeOperationsRestartInstallation } from '../../src/service/operations-restart-installations.js';
import { verificationProfileFingerprint } from '../../src/service/repair-retry.js';
import { registerOperationsTarget } from '../../src/service/operations-targets.js';
import { fingerprintRolloutCheck, registerReleaseTarget } from '../../src/service/release-targets.js';
import { bootstrapOwner } from '../../src/service/resources.js';
import { TaskService } from '../../src/service/tasks.js';
import { databaseFixture } from '../helpers/database.js';
import { identityFixture } from '../helpers/identity.js';
import { npmFixtureApproval, npmFixtureFiles, npmFixturePaths } from '../../../verification/src/agent/npm-repair-fixture.js';
import { temporaryPostgres } from '../../../verification/src/postgres-fixture.js';
import { sourceFingerprint } from '../../../verification/src/report.js';
import { openNativeReleaseKomodo } from '../../../verification/src/native/komodo-probe.js';
import { npmReleaseApproval, standardNpmReleaseFiles } from '../../../verification/src/native/npm-release-fixture.js';
import { openNativeWhiskersReadScope } from '../../../portal/test/native/whiskers-read.js';
import { openNativeWhiskersRestartScope } from '../../../portal/test/native/whiskers-restart-scope.js';
import { auditFixtureKey, auditFixtureModel, auditProtocolFixture } from './audit-provider.js';
import { proveKnownKomodoRecovery, proveUnknownKomodoDispatch, recoverRecordedReleaseForRollout } from './komodo-release-proof.js';
import type { KomodoInterruption, runKomodoReleaseFixture } from './komodo-release-worker.js';
import type { RegistryImportMarker } from './release-recovery.js';
import { temporaryRegistry } from './registry-fixture.js';
import { openProtectedIngress } from './protected-ingress.js';
import { proveDeniedNativeRestore, proveInterruptedNativeRestore, proveNativeRestore } from './restore-proof.js';
import { proveNativeRestart, type DiagnosisHttp, type DiagnosisReaders } from './restart-proof.js';

type NativeDiagnosisPublication = {
  taskId: string; operationId: string; containerId: string; restoreExecutionId?: string;
};
type NativeDiagnosisAcceptance<T> = (
  { kind: 'restart'; installationFile: string } | { kind: 'rollback'; previousOperationId: string }
) & { verify: (diagnosis: TaskDto, diagnosisSha256: string, readers: DiagnosisReaders) => Promise<T> };

const execute = promisify(execFile);
const commit = '9167604c888416d7b6518e1c76485d7308cffb5c';
const repairFixtureCommit = 'f41a940ffe4ec24221b873e1cd74b8ec2125873e';
const cleanVerificationCommit = '49799e18f4f63cf22767a9cd8054cab979b9b6d2';
const standardBuildCommit = '3a719ca44f306d30cdf2d27e9a6d3b954ed656f0';
const standardLockDriftCommit = '03e5d18a27d23960f040c0d5d70afefac15ec46e';
const standardHealthRegressionCommit = '1eac5c8776c6e81613cfb5adf6edd2cd6b163ba3';
const repairRetryCommit = '39e9b7f34fdd01ec55fe4dda5358ffce5d68cbf8';
const dependencyReleaseCommit = '37ac62431fd9bf7b2a6c0f4b3f15d5d5f1f030b8';
const runtimeFaultCommit = '5b9db1015069be891233231a7b947831ac46fe39';
const origin = 'https://github.com/MaLaNg116/itervane.git';
const publicUrl = 'https://itervane.example';
const standardRuntimePort = 38171; // The port sealed in the OCI runtime plan by runtime_guest.py.
const controllerAccount = 'itervane-probe';
const workerAccount = 'itervane-inspection-client';
const domainName = /^itervane-d2-[a-f0-9-]{36}$/;
let phase = 'configuration';
type NativeKomodo = Awaited<ReturnType<typeof openNativeReleaseKomodo>>;
type NativeKomodoTarget = Awaited<ReturnType<NativeKomodo['prepare']>>;

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

async function firstLine(child: ChildProcess, timeoutMs = 8_000) {
  if (!child.stdout) throw new Error('probe_stdout');
  const lines = createInterface({ input: child.stdout });
  try {
    const [first] = await once(lines, 'line', { signal: AbortSignal.timeout(timeoutMs) });
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

async function withReplacementArchive<T>(shared: string, raw: unknown, exercise: () => Promise<T>) {
  const archive = qualifiedImageArchiveSchema.parse(raw);
  const child = spawn('/usr/bin/sudo', ['-n', '-u', controllerAccount, '--', '/usr/bin/python3', '-I', '-B',
    join(shared, 'release-tools/release-drift-archive.py'), join(dirname(shared), 'artifacts'), archive.sha256, String(archive.bytes),
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exit = exitStatus(child);
  child.stdin.on('error', () => {});
  child.stderr.resume();
  try {
    equal(await firstLine(child), 'replacement_ready');
    return await exercise();
  } finally {
    // The caller stops the installed Worker before restoring the only approved archive.
    child.stdin.end();
    equal(await boundedExit(child, exit, 12_000), 0);
  }
}

function sourceWorkerEnvironment(socket: string, controllerUid: string, image: string) {
  return ['PATH=/usr/bin:/bin', 'LANG=C.UTF-8', `ITERVANE_RUNNER_SOCKET=${socket}`,
    `ITERVANE_RUNNER_UID=${controllerUid}`, `ITERVANE_RUNNER_IMAGE_SHA256=${image}`, 'ITERVANE_WORKER_LEASE_SECONDS=30'];
}

function startWorker(bundle: string, socket: string, controllerUid: string, image: string, databaseUrl: string,
  auditURL?: string, verification?: StandardVerificationProfile, repair: boolean | NpmUpgradeApproval = false) {
  return startScopedWorker(bundle, [...sourceWorkerEnvironment(socket, controllerUid, image),
    ...(auditURL ? ['ITERVANE_AUDIT_MODEL_PROVIDER=anthropic', `ANTHROPIC_BASE_URL=${auditURL}`,
      `ANTHROPIC_MODEL=${auditFixtureModel}`, `ANTHROPIC_API_KEY=${auditFixtureKey}`] : []),
    ...(verification ? [`ITERVANE_VERIFICATION_PROFILE=${JSON.stringify(verification)}`] : []),
    ...(repair ? ['ITERVANE_FORMAL_REPAIR=1'] : []),
    ...(typeof repair === 'object' ? [`ITERVANE_NPM_REPAIR_APPROVALS=${JSON.stringify([repair])}`] : []),
    'ITERVANE_WORKER_POLL_MS=100'], { DATABASE_URL: databaseUrl });
}

async function startScopedWorker(bundle: string, environment: string[], secrets: Record<string, string>) {
  const entries = Object.entries(secrets);
  const loadSecrets = entries.map(([name, value]) => {
    match(name, /^[A-Z][A-Z0-9_]*$/);
    ok(!/[\r\n]/.test(value));
    return `IFS= read -r ${name}; export ${name};`;
  }).join(' ');
  const child = spawn('/usr/bin/sudo', ['-n', '-u', workerAccount, '--', '/usr/bin/env', '-i', ...environment,
    '/usr/bin/setpriv', '--no-new-privs', '/bin/bash', '-c',
    `set -eu; ${loadSecrets} printf "%s\\n" "$$"; exec "$@"`, 'itervane-worker', process.execPath, bundle,
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exit = exitStatus(child);
  child.stderr.resume();
  child.stdin.on('error', () => undefined);
  const pidLine = firstLine(child);
  child.stdin.end(entries.map(([, value]) => value + '\n').join(''));
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

function launchScopedFixtureWorker(bundle: string, socket: string, controllerUid: string, image: string,
  databaseUrl: string, args: string[], fixturePayload?: string) {
  const script = 'set -eu; IFS= read -r DATABASE_URL; export DATABASE_URL; '
    + (fixturePayload ? 'IFS= read -r ITERVANE_NATIVE_KOMODO_FIXTURE; export ITERVANE_NATIVE_KOMODO_FIXTURE; ' : '')
    + 'exec "$@"';
  const child = spawn('/usr/bin/sudo', ['-n', '-u', workerAccount, '--', '/usr/bin/env', '-i', ...sourceWorkerEnvironment(socket, controllerUid, image),
    '/usr/bin/setpriv', '--no-new-privs', '/bin/bash', '-c', script,
    'itervane-fixture-worker', process.execPath, bundle, ...args,
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exit = exitStatus(child);
  child.stdin.on('error', () => undefined);
  child.stdin.end(databaseUrl + '\n' + (fixturePayload ? fixturePayload + '\n' : ''));
  return { child, exit };
}

async function runScopedFixtureWorker(bundle: string, socket: string, controllerUid: string, image: string,
  databaseUrl: string, probe: 'repair' | 'verification', args: string[], fixturePayload?: string) {
  const { child, exit } = launchScopedFixtureWorker(bundle, socket, controllerUid, image, databaseUrl, args, fixturePayload);
  let diagnostic = '';
  child.stderr.on('data', (chunk: Buffer) => {
    if (probe === 'verification' && diagnostic.length < 256) diagnostic += chunk.subarray(0, 256).toString('utf8');
  });
  let size = 0;
  const output: Buffer[] = [];
  const limit = probe === 'verification' ? 2 * 1024 * 1024 : 32768;
  child.stdout.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > limit) child.kill();
    else output.push(chunk);
  });
  const status = await boundedExit(child, exit, probe === 'repair' ? 385_000 : 205_000);
  if (status !== 0 || size > limit) throw new Error(/\bverification_fixture_phase_[a-z_]{1,56}\b/.exec(diagnostic)?.[0] ?? 'scoped_fixture_worker_failed');
  return JSON.parse(Buffer.concat(output).toString('utf8'));
}

async function interruptFixture<T extends { pid: number; operationId: string; fence: number }>(
  { child, exit }: ReturnType<typeof launchScopedFixtureWorker>, operationId: string, validate: (marker: T) => T, before: string) {
  child.stderr.resume();
  let markedPid: number | undefined;
  let stopped = false;
  const kill = (pid: number) => execute('/usr/bin/sudo', ['-n', '-u', workerAccount, '--', '/bin/kill', '-KILL', String(pid)], { timeout: 5_000 });
  try {
    const line = await Promise.race([firstLine(child, 205_000), exit.then(() => { throw new Error(before); })]);
    const marker = JSON.parse(line) as T;
    ok(Number.isSafeInteger(marker.pid) && marker.pid > 1 && marker.pid <= 2_147_483_647);
    markedPid = marker.pid;
    equal(marker.operationId, operationId);
    ok(Number.isSafeInteger(marker.fence) && marker.fence > 0);
    const checked = validate(marker);
    await kill(markedPid);
    notEqual(await boundedExit(child, exit, 15_000), 0);
    stopped = true;
    return checked;
  } finally {
    if (!stopped) {
      if (markedPid) await kill(markedPid).catch(() => undefined);
      else child.kill();
      await boundedExit(child, exit, 5_000).catch(() => undefined);
    }
  }
}

async function killAfterRegistryImport(bundle: string, socket: string, controllerUid: string, image: string,
  databaseUrl: string, operationId: string, registryOrigin: string, materializer: string) {
  return interruptFixture<RegistryImportMarker>(launchScopedFixtureWorker(bundle, socket, controllerUid, image, databaseUrl,
    ['interrupt-registry-import', operationId, registryOrigin, materializer]), operationId, marker => {
    equal(marker.stagingEmpty, true);
    return { ...marker, imported: releaseRegistryImageProofSchema.parse(marker.imported) };
  }, 'registry_worker_exited_before_import');
}

async function runRepairWorker(bundle: string, socket: string, controllerUid: string, image: string, databaseUrl: string, args: string[],
  variant: 'patch' | 'template' | 'npm') {
  const response = await runScopedFixtureWorker(bundle, socket, controllerUid, image, databaseUrl, 'repair', [...args, variant]);
  const receipt = qualifiedRepairResponseSchema.parse(response.receipt);
  const observation = qualifiedRepairObservationResponseSchema.parse(response.observation);
  if (receipt.kind !== 'repair_receipt' || observation.kind !== 'repair_observation') throw new Error('worker_repair_missing_receipt');
  const { checkpointId, callKeySha256, trace, usage, releaseEligible, resultSha256 } = response.agent;
  deepStrictEqual(trace, ['read_repair_targets', variant === 'template' ? 'apply_repair_template' : 'apply_repair_patch']);
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
  const [bundle, socket, controllerUid, imageSha256, staging, repairBundle, verificationBundle, ...extra] = process.argv.slice(2);
  const [buildMode, buildProfile, baseline, oci] = extra;
  const dependencyRun = buildMode === 'protected-release-npm';
  const driftRun = buildMode === 'protected-release-drift';
  const faultRun = buildMode === 'protected-release-faults';
  const operationsRun = buildMode === 'protected-release-operations';
  const restoreAuthorityRun = buildMode === 'protected-release-restore-authorization';
  const restoreRun = buildMode === 'protected-release-restore' || restoreAuthorityRun;
  const protectedRun = buildMode === 'protected-release' || dependencyRun || driftRun || faultRun || operationsRun || restoreRun;
  const ociRun = buildMode === 'standard-oci' || protectedRun;
  const buildRun = buildMode === 'standard-build' || buildMode === 'standard-build-missing-cache' || ociRun;
  if (process.platform !== 'linux' || process.env.PROBE_HOST_ENVIRONMENT !== 'github-hosted' || process.env.DATABASE_URL
    || process.env.ITERVANE_POSTGRES_IMAGE || (extra.length !== 0 && (extra.length !== (ociRun ? 4 : 3) || !buildRun))
    || !bundle?.startsWith('/var/lib/libvirt/images/itervane-native.')
    || !socket?.endsWith('/qualified/inspection.sock') || !controllerUid || !/^[1-9][0-9]{0,9}$/.test(controllerUid)
    || !imageSha256 || !/^[a-f0-9]{64}$/.test(imageSha256) || !staging?.endsWith('/staging')
    || repairBundle !== bundle.replace(/\/worker\.mjs$/, '/repair-worker.mjs')
    || verificationBundle !== bundle.replace(/\/worker\.mjs$/, '/verification-worker.mjs')) throw new Error('worker_probe_config');
  const build = buildRun ? {
    profile: sha256Schema.parse(buildProfile), baseline: sha256Schema.parse(baseline),
    oci: ociRun ? sha256Schema.parse(oci) : undefined,
  } : undefined;

  phase = 'postgres';
  const postgres = await temporaryPostgres();
  let database: Awaited<ReturnType<typeof databaseFixture>> | undefined;
  let identity: Awaited<ReturnType<typeof identityFixture>> | undefined;
  let api: ReturnType<typeof createApi> | undefined;
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  let auditProvider: Awaited<ReturnType<typeof auditProtocolFixture>> | undefined;
  let releaseRegistry: Awaited<ReturnType<typeof temporaryRegistry>> | undefined;
  let releaseKomodo: NativeKomodo | undefined;
  let protectedIngress: Awaited<ReturnType<typeof openProtectedIngress>> | undefined;
  const closeReleaseFixtures = async () => {
    const ingress = protectedIngress;
    const komodo = releaseKomodo;
    const registry = releaseRegistry;
    protectedIngress = undefined;
    releaseKomodo = undefined;
    releaseRegistry = undefined;
    // The edge must leave the owned application network before Komodo removes it.
    try { await ingress?.close(); }
    finally { await Promise.all([komodo?.close(), registry?.close()]); }
  };
  const client = new Client({ name: 'itervane-native-worker', version: '0.0.0' });
  try {
    const db = database = await databaseFixture(postgres.url);
    const oidc = identity = await identityFixture();
    await bootstrapOwner(db.storage, { issuer: oidc.config.issuer, subject: 'owner' });
    const portalClientId = 'itervane-native-portal';
    api = createApi(db.storage, { ...oidc.config, publicUrl, portalClientId }, { logger: false });
    const address = await api.listen({ host: '127.0.0.1', port: 0 });
    const authorization = async () => `Bearer ${await oidc.token()}`;
    const request = async (path: string, payload?: object, human = false, locale?: Locale) => {
      const response = await fetch(`${address}${path}`, { method: payload ? 'POST' : 'GET', signal: AbortSignal.timeout(5_000),
        headers: { Authorization: human ? `Bearer ${await oidc.token('owner', { azp: portalClientId })}` : await authorization(),
          ...(locale ? { 'Accept-Language': locale } : {}),
          ...(payload ? { 'content-type': 'application/json' } : {}) },
        ...(payload ? { body: JSON.stringify(payload) } : {}) });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`fixture_http_${response.status}`);
      }
      return response.json() as Promise<unknown>;
    };
    const project = projectDtoSchema.parse(await request('/v1/projects', { name: 'Native inspection fixture', slug: 'native-inspection' }));
    const repository = repositoryDtoSchema.parse(await request(`/v1/projects/${project.id}/repositories`, { name: 'Fixed source', url: origin }));
    const mcpToken = await oidc.token('owner', { aud: `${publicUrl}/mcp`, scope: 'itervane:read itervane:write', exp: Math.floor(Date.now() / 1_000) + 1_200 });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${mcpToken}`, 'Accept-Language': 'zh-CN' } },
    }));
    const start = async (purpose: string, revision = commit, locale: 'en' | 'zh-CN' = 'zh-CN') => admissionDtoSchema.parse((await client.callTool({ name: 'start_audit', arguments: {
      projectId: project.id, source: { repositoryId: repository.id, commit: revision }, dataClass: 'public', purpose, locale, idempotencyKey: randomUUID(),
    } })).structuredContent).task;
    const reached = (taskId: string, state: string, timeoutMs = 190_000) => poll(async () => {
      const row = (await db.admin.query('SELECT state FROM itervane.tasks WHERE id=$1', [taskId])).rows[0];
      return row?.state === state ? true : undefined;
    }, timeoutMs, state);
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

    const rescanFixture = async (task: Awaited<ReturnType<typeof start>>, findingId: string | null, buildArgs: string[] = []) => {
      // Runner-only subcases use a scoped fixture Worker and a normal database lease.
      equal((await db.admin.query("UPDATE itervane.tasks SET state='queued' WHERE id=$1 AND state='waiting_input'", [task.id])).rowCount, 1);
      equal((await db.admin.query("UPDATE itervane.task_runs SET state='queued' WHERE id=$1 AND state='waiting_input'", [task.runId])).rowCount, 1);
      const result = await runScopedFixtureWorker(verificationBundle, socket, controllerUid, imageSha256, db.runtimeUrl,
        'verification', [task.id, task.runId, findingId ?? 'original', ...buildArgs]);
      equal(result.commit, task.source.commit);
      idSchema.parse(result.domainId);
      for (const value of [result.inputSha256, result.receiptSha256, result.commandSha256, result.baseSnapshotSha256,
        result.targetManifestSha256, result.originalReportsSha256]) sha256Schema.parse(value);
      equal(result.cleanupConfirmed, true);
      equal(result.dispatches, 1);
      equal(result.newFindingGroups, 0);
      equal((await db.admin.query('SELECT task_id FROM itervane.execution_slot WHERE id=1')).rows[0]?.task_id, null);
      await assertDrained(controllerUid, staging);
      return result;
    };
    const komodoTrial = (registryOrigin: string, fixture: NativeKomodoTarget, taskId: string, releaseId: string,
      image: { reference: string; configDigest: string }) => {
      const credentials = JSON.stringify({ origin: fixture.binding.komodo.origin, ...fixture.credentials });
      const args = (boundary: string, materializer = '-') =>
        ['komodo-release-step', releaseId, registryOrigin, materializer, boundary];
      return {
        database: db.storage, taskId, operationId: releaseId, reference: image.reference, configDigest: image.configDigest,
        tick: (materializer?: string): ReturnType<typeof runKomodoReleaseFixture> =>
          runScopedFixtureWorker(verificationBundle, socket, controllerUid, imageSha256, db.runtimeUrl,
            'verification', args('tick', materializer), credentials),
        interrupt: (boundary: KomodoInterruption['boundary']) =>
          interruptFixture<KomodoInterruption>(launchScopedFixtureWorker(verificationBundle, socket, controllerUid, imageSha256,
            db.runtimeUrl, args(boundary), credentials), releaseId, marker => {
            equal(marker.boundary, boundary);
            if (boundary !== 'configured') komodoResourceIdSchema.parse(marker.updateId);
            return marker;
          }, 'komodo_worker_exited_before_interruption'),
        observeContainer: fixture.observeContainer,
      };
    };

    if (build) {
      const audit = auditProvider = await auditProtocolFixture({
        repairRetry: ociRun && !dependencyRun && !driftRun && !faultRun && !restoreRun, dependencyRepair: dependencyRun,
      });
      const automaticProfile = build.oci ? standardVerificationProfileSchema.parse({
        id: 'isolated-rescan-fixture', baselineSha256: build.baseline, policySha256: sha256(JSON.stringify(scannerProfiles)),
        scannerInputsSha256: JSON.parse(readFileSync('.reports/p0/kvm-inspection-inputs.json', 'utf8')).inputsSha256,
        runnerImageSha256: imageSha256, buildProfileSha256: build.profile, runStandardBaseline: true,
        ociInputsSha256: build.oci, retainStandardImage: true,
      }) : undefined;
      const recordedVerification = async (task: Awaited<ReturnType<typeof start>>, failed: boolean, subject: 'original' | 'repair' = 'original') => {
        const { rows } = await db.admin.query<{
          result: unknown; result_sha: string; input: unknown; input_sha: string; receipt: unknown;
          attempt_fence: number; finalized_fence: number;
        }>(`SELECT v.document AS result, v.sha256 AS result_sha, i.document AS input, i.sha256 AS input_sha,
          a.receipt, a.fence AS attempt_fence, v.finalized_fence
          FROM itervane.formal_verification_results v
          JOIN itervane.formal_verification_inputs i ON i.run_id=v.run_id
          JOIN itervane.formal_rescan_attempts a ON a.request_id=v.request_id AND a.state='recorded'
          WHERE v.run_id=$1`, [task.runId]);
        equal(rows.length, 1);
        const stored = rows[0]!;
        const input = formalVerificationInputSchema.parse(stored.input);
        const result = formalVerificationResultSchema.parse(stored.result);
        const receipt = qualifiedVerificationResponseSchema.parse(stored.receipt);
        if (result.status !== 'reviewed' || receipt.kind !== 'verification_receipt' || result.evidence.source.status !== 'compared') {
          throw new Error('native_verification_result');
        }
        equal(sha256(JSON.stringify(result)), stored.result_sha);
        equal(sha256(JSON.stringify(input)), stored.input_sha);
        equal(result.inputSha256, stored.input_sha);
        equal(result.receiptSha256, sha256(JSON.stringify(receipt)));
        equal(result.taskId, task.id);
        equal(input.subject.kind, subject);
        equal(receipt.scope.fence, stored.attempt_fence);
        equal(stored.finalized_fence, stored.attempt_fence);
        equal(result.review.outcome, failed ? 'checks_failed' : 'observed');
        if (failed) equal(result.archiveVerification, undefined);
        else {
          const image = result.evidence.image;
          ok(image.status === 'scanned' && image.archive);
          deepStrictEqual(result.archiveVerification, { kind: 'archive_verified', version: 1, runnerImageSha256: imageSha256,
            archive: image.archive });
        }
        const sections = result.observations.map(item => item.section);
        deepStrictEqual(sections, failed ? ['baseline', 'source', 'build'] : ['baseline', 'image', 'source', 'build']);
        const [last] = (await db.admin.query(`SELECT type,detail FROM itervane.task_events
          WHERE task_id=$1 AND type='task.verification_recorded' AND detail->>'runId'=$2 ORDER BY sequence DESC LIMIT 1`,
          [task.id, task.runId])).rows;
        equal(last?.type, 'task.verification_recorded');
        equal(last?.detail?.reason, failed ? 'verification_checks_failed' : 'verification_observed');
        equal(last?.detail?.verificationResultSha256, stored.result_sha);
        const [attempts] = (await db.admin.query('SELECT count(*)::int AS count FROM itervane.formal_rescan_attempts WHERE run_id=$1', [task.runId])).rows;
        equal(attempts?.count, 1);
        equal((await db.admin.query('SELECT task_id FROM itervane.execution_slot WHERE id=1')).rows[0]?.task_id, null);
        await assertDrained(controllerUid, staging);
        const { snapshot, scope } = receipt;
        const { status: _status, ...totals } = result.evidence.source;
        return {
          domainId: receipt.domainId, commit: scope.commit, inputSha256: result.inputSha256, receiptSha256: result.receiptSha256,
          commandSha256: scope.commandSha256, baseSnapshotSha256: scope.baseSnapshotSha256, targetManifestSha256: scope.targetManifestSha256,
          patchSha256: snapshot.target?.patchSha256 ?? null, originalReportsSha256: sha256(JSON.stringify(snapshot.reports)),
          targetReportsSha256: snapshot.target ? sha256(JSON.stringify(snapshot.target.reports)) : null,
          totals, targetRuleId: null, newFindingGroups: totals.introduced, remainingFindingGroups: totals.remaining,
          dispatches: 1, cleanupConfirmed: receipt.cleanupConfirmed, build: snapshot.build ?? null, verificationResultSha256: stored.result_sha,
          archiveVerification: result.archiveVerification ?? null,
          reviewTrial: { input: { sha256: stored.input_sha, document: input }, evidence: result.evidence,
            report: { sections, usage: result.usage, checkpointId: result.checkpointId, outcome: result.review.outcome } },
        };
      };
      const repairRetryFixture = async (profile: StandardVerificationProfile) => {
        phase = 'standard_repair_retry_run';
        worker = await startWorker(bundle, socket, controllerUid, imageSha256, db.runtimeUrl, audit.baseURL, profile, true);
        const first = await start('Apply a bounded repair and verify the retry after a real health regression', repairRetryCommit);
        await poll(async () => {
          const [row] = (await db.admin.query(`SELECT t.state, r.reason FROM itervane.tasks t
            JOIN itervane.task_runs run ON run.task_id=t.id AND run.generation=t.generation
            JOIN itervane.run_runtime r ON r.run_id=run.id WHERE t.id=$1`, [first.id])).rows;
          if (row?.state === 'waiting_input') return true;
          if (row && ['needs_human', 'failed', 'cancelled', 'reconciling'].includes(row.state)) {
            if (typeof row.reason === 'string' && /^[a-z_]{1,58}$/.test(row.reason)) phase = `standard_retry_${row.reason}`;
            throw new Error('retry_fixture_stopped');
          }
        }, 780_000, 'standard_repair_retry_run');
        const current = taskDtoSchema.parse(await request(`/v1/tasks/${first.id}`));
        notEqual(first.runId, current.runId);
        await worker.stop('TERM'); worker = undefined;
        phase = 'standard_repair_retry_receipts';
        const before = await recordedVerification(first, true, 'repair');
        const after = await recordedVerification(current, false, 'repair');
        equal(before.commit, repairRetryCommit);
        equal(after.commit, repairRetryCommit);
        equal(before.baseSnapshotSha256, after.baseSnapshotSha256);
        notEqual(before.targetManifestSha256, after.targetManifestSha256);
        ok(before.patchSha256 && after.patchSha256);
        notEqual(before.patchSha256, after.patchSha256);
        deepStrictEqual(after.totals, { introduced: 0, resolved: 1, remaining: 0 });
        const [stored] = (await db.admin.query(
          'SELECT document,sha256,run_id,previous_run_id FROM itervane.formal_repair_retries WHERE task_id=$1', [first.id],
        )).rows;
        ok(stored);
        const retrySha256 = sha256Schema.parse(stored.sha256);
        const handoff = formalRepairRetrySchema.parse(stored.document);
        equal(sha256(JSON.stringify(handoff)), retrySha256);
        equal(stored.run_id, current.runId);
        equal(stored.previous_run_id, first.runId);
        equal(handoff.previous.verificationResultSha256, before.verificationResultSha256);
        equal(handoff.previous.receiptSha256, before.receiptSha256);
        equal(handoff.generation, 2);
        const events = (await client.callTool({ name: 'get_task_events', arguments: { taskId: first.id } })).structuredContent as { items: unknown[] };
        const lifecycle = events.items.map(event => taskEventDtoSchema.parse(event));
        equal(lifecycle.filter(event => event.type === 'task.repair_retry_queued').length, 1);
        match(lifecycle.find(event => event.type === 'task.repair_retry_queued')!.message, /返修/);
        return { current, before, after, retrySha256, generation: handoff.generation };
      };
      const dependencyFixture = async (profile: StandardVerificationProfile) => {
        phase = 'protected_npm_audit_repair';
        worker = await startWorker(bundle, socket, controllerUid, imageSha256, db.runtimeUrl, audit.baseURL, profile, npmReleaseApproval);
        const task = await start('Verify and release the scoped npm dependency repair', dependencyReleaseCommit, 'en');
        await poll(async () => {
          const [row] = (await db.admin.query(`SELECT t.state, r.reason FROM itervane.tasks t
            JOIN itervane.task_runs run ON run.task_id=t.id AND run.generation=t.generation
            JOIN itervane.run_runtime r ON r.run_id=run.id WHERE t.id=$1`, [task.id])).rows;
          if (row?.state === 'waiting_input' && row.reason === 'verification_observed') return true;
          if (row && ['waiting_input', 'needs_human', 'failed', 'cancelled', 'reconciling'].includes(row.state)) {
            if (typeof row.reason === 'string' && /^[a-z_]{1,58}$/.test(row.reason)) phase = `protected_npm_${row.reason}`;
            throw new Error('npm_fixture_stopped');
          }
        }, 720_000, 'protected_npm_evidence');
        const current = taskDtoSchema.parse(await request(`/v1/tasks/${task.id}`));
        equal(current.runId, task.runId);
        await worker.stop('TERM'); worker = undefined;
        phase = 'protected_npm_receipts';
        const after = await recordedVerification(current, false, 'repair');
        deepStrictEqual(after.totals, { introduced: 0, resolved: 1, remaining: 0 });
        equal(after.commit, dependencyReleaseCommit);
        const repair = formalRepairDtoSchema.parse(await request(`/v1/tasks/${current.id}/repair`));
        ok(repair.status === 'recorded' && repair.result.status === 'candidate_ready');
        const sealed = standardNpmReleaseFiles('approved');
        deepStrictEqual(repair.result.candidate.changes.map(change => [change.path, change.afterSha256]), [
          ['package-lock.json', sha256(sealed.lock)], ['package.json', sha256(sealed.manifest)],
        ]);
        equal(repair.result.candidate.patchSha256, after.patchSha256);
        equal(repair.result.candidate.manifestSha256, after.targetManifestSha256);
        return { current, after, generation: repair.result.generation, dependencyPatchSha256: repair.result.candidate.patchSha256 };
      };
      const buildFixture = async (revision: string, outcome: 'built' | 'profile_mismatch' | 'offline_install',
        baselineOutcome?: 'passed' | 'failed') => {
        phase = `standard_build_audit_${outcome}`;
        const profile = baselineOutcome ? automaticProfile : undefined;
        const failed = baselineOutcome === 'failed';
        worker = await startWorker(bundle, socket, controllerUid, imageSha256, db.runtimeUrl, audit.baseURL, profile);
        const task = await start('Verify the standard build from this fixed source', revision,
          build.oci && baselineOutcome === 'passed' ? 'en' : 'zh-CN');
        await reached(task.id, profile && failed ? 'needs_human' : 'waiting_input', profile ? 380_000 : undefined);
        const reviewed = formalAuditDtoSchema.parse(await request(`/v1/tasks/${task.id}/audit`));
        if (reviewed.status !== 'recorded' || reviewed.result.status !== 'completed') throw new Error('standard_build_audit');
        if (reviewed.result.checklist?.findings.length !== 0) {
          phase = 'standard_build_initial_findings';
          throw new Error('standard_build_findings');
        }
        await worker.stop('TERM'); worker = undefined;
        phase = baselineOutcome ? `standard_baseline_${baselineOutcome}` : `standard_build_execution_${outcome}`;
        const fact: Record<string, unknown> = profile ? await recordedVerification(task, failed)
          : await rescanFixture(task, null, [build.profile, build.baseline, outcome,
            ...(baselineOutcome ? [baselineOutcome, ...(build.oci ? [build.oci] : [])] : [])]);
        const evidence = qualifiedStandardBuildProofSchema.parse(fact.build);
        equal(evidence.baselineSha256, build.baseline);
        equal(evidence.subjectManifestSha256, reviewed.result.snapshotSha256);
        equal(evidence.verificationInputSha256, fact.inputSha256);
        equal(evidence.runId, fact.domainId);
        return { ...fact, build: evidence, taskId: task.id };
      };
      const runProtectedCase = async (fault?: 'health' | 'identity') => {
        ok(automaticProfile);
        const proxyDir = process.env.ITERVANE_NATIVE_RELEASE_PROXIES;
        ok(proxyDir && proxyDir.startsWith('/') && proxyDir.endsWith('/itervane-release-proxies'));
        const cleanReleaseFixture = async (revision = fault === 'health' ? runtimeFaultCommit : standardBuildCommit) => {
          const after = await buildFixture(revision, 'built', 'passed');
          const current = taskDtoSchema.parse(await request(`/v1/tasks/${after.taskId}`));
          return { current, after, generation: 1 };
        };
        const prepared = driftRun || fault || restoreRun ? await cleanReleaseFixture()
          : dependencyRun ? await dependencyFixture(automaticProfile) : await repairRetryFixture(automaticProfile);
        const { current, after, generation } = prepared;
        phase = fault ? `protected_release_${fault}_target` : 'protected_release_target';
        const application = applicationDtoSchema.parse(await request(`/v1/projects/${project.id}/applications`, {
          name: fault ? `Protected release ${fault} fixture` : 'Protected standard release',
        }));
        const environment = environmentDtoSchema.parse(await request(`/v1/projects/${project.id}/environments`, {
          name: 'Protected application', applicationId: application.id,
        }));
        const registry = releaseRegistry = await temporaryRegistry();
        const komodo = releaseKomodo = await openNativeReleaseKomodo();
        const target = await komodo.prepare();
        await target.allowContainerInspection();

        phase = 'protected_release_ingress';
        const ingress = protectedIngress = await openProtectedIngress({ ...target.endpoint, port: standardRuntimePort }, {
          traefik: join(proxyDir, 'traefik'), oauth2: join(proxyDir, 'oauth2-proxy'),
        });
        const rolloutCheckSha256 = fingerprintRolloutCheck(ingress.check);
        const targetSettings = {
          environmentId: environment.id, ...target.binding, imageRepository: 'testing/standard', registryOrigin: registry.origin,
          verificationProfileSha256: verificationProfileFingerprint(automaticProfile), rolloutCheckSha256, rolloutCheck: ingress.check,
          recoveryPlanSha256: sha256('native protected release recovery plan'),
          ...(restoreAuthorityRun ? { approvalTtlSeconds: 60 } : {}),
        };
        const mapping = await registerReleaseTarget(db.storage, targetSettings);

        const approve = async (task: typeof current, fact: Record<string, unknown>, generation: number, mapping: string) => {
          phase = 'protected_release_approval';
          const built = qualifiedStandardBuildProofSchema.parse(fact.build);
          ok(built.status === 'built' && built.baseline?.status === 'passed' && built.baseline.image?.status === 'scanned');
          const image = built.baseline.image;
          const candidate = formalReleaseCandidateDtoSchema.parse((await client.callTool({ name: 'request_release',
            arguments: { taskId: task.id, environmentId: environment.id, expectedVersion: task.version },
          })).structuredContent);
          equal(candidate.status, 'pending');
          equal(candidate.manifest.taskId, task.id);
          equal(candidate.manifest.runId, task.runId);
          equal(candidate.manifest.generation, generation);
          equal(candidate.manifest.verification.resultSha256, fact.verificationResultSha256);
          equal(candidate.manifest.image.manifestDigest, image.manifestDigest);
          equal(candidate.manifest.image.configDigest, image.configDigest);
          equal(candidate.manifest.rolloutCheckSha256, rolloutCheckSha256);
          equal(candidate.manifest.target.mappingSha256, mapping);
          equal(candidate.fingerprint, sha256(JSON.stringify(candidate.manifest)));
          const decisionPath = `/v1/release-candidates/${candidate.id}/decisions`;
          const decision = { action: 'confirm', fingerprint: candidate.fingerprint, expectedVersion: 0, idempotencyKey: randomUUID() };
          const denied = await fetch(address + decisionPath, { method: 'POST', signal: AbortSignal.timeout(5_000),
            headers: { Authorization: await authorization(), 'content-type': 'application/json' }, body: JSON.stringify(decision) });
          await denied.body?.cancel();
          equal(denied.status, 403);
          const { rowCount: beforeApproval } = await db.admin.query('SELECT id FROM itervane.release_operations WHERE candidate_id=$1', [candidate.id]);
          equal(beforeApproval, 0);
          const outcome = (await request(decisionPath, decision, true)) as { candidate: unknown };
          const approved = formalReleaseCandidateDtoSchema.parse(outcome.candidate);
          equal(approved.status, 'confirmed');
          equal(approved.fingerprint, candidate.fingerprint);
          return { candidate, approved, image, operationId: idSchema.parse(approved.operationId) };
        };
        const decision = await approve(current, after, generation, mapping.fingerprint);
        const { candidate, approved, image, operationId } = decision;

        const shared = dirname(bundle);
        const ca = join(shared, 'release-test-ca.pem');
        await execute('/usr/bin/sudo', ['-n', 'install', '-m', '0444', ingress.caFile, ca], { timeout: 5_000 });
        const startReleaseWorker = (mapping: string) => startScopedWorker(join(shared, 'release-worker.mjs'), [
          ...sourceWorkerEnvironment(socket, controllerUid, imageSha256), 'ITERVANE_WORKER_POLL_MS=250',
          `NODE_EXTRA_CA_CERTS=${ca}`, `ITERVANE_RELEASE_ENVIRONMENT_ID=${environment.id}`,
          `ITERVANE_RELEASE_TARGET_SHA256=${mapping}`,
          `ITERVANE_RELEASE_MATERIALIZER=${join(shared, 'release-tools/materialize_oci.py')}`, 'ITERVANE_RELEASE_SKOPEO=/usr/bin/skopeo',
        ], { DATABASE_URL: db.runtimeUrl, ITERVANE_RELEASE_KOMODO_KEY: target.credentials.key,
          ITERVANE_RELEASE_KOMODO_SECRET: target.credentials.secret, ITERVANE_RELEASE_PROBE_SECRET: ingress.probeSecret });
        const readResult = async (locale: Locale, taskId = current.id) =>
          formalReleaseViewSchema.parse(await request(`/v1/tasks/${taskId}/release`, undefined, false, locale));
        const withEnglishReader = async <T>(read: (lookup: Client) => Promise<T>, endpoint = address) => {
          const reader = new Client({ name: 'itervane-native-release-reader', version: '0.0.0' });
          try {
            await reader.connect(new StreamableHTTPClientTransport(new URL(`${endpoint}/mcp`), {
              requestInit: { headers: { Authorization: `Bearer ${mcpToken}`, 'Accept-Language': 'en' } },
            }));
            return await read(reader);
          } finally { await reader.close(); }
        };

        if (driftRun) {
          const runBlocked = async (task: typeof current, decision: Awaited<ReturnType<typeof approve>>, installedMapping: string,
            reason: 'release_target_changed' | 'release_archive_unavailable') => {
            const { candidate, approved, operationId } = decision;
            worker = await startReleaseWorker(installedMapping);
            try {
              const blocked = await poll(async () => {
                const view = await readResult('zh-CN', task.id);
                if (view.result?.status === 'verified' || view.result?.status === 'manual_review') throw new Error('release_boundary_failed');
                return view.result?.status === 'blocked' ? view : undefined;
              }, 65_000, reason);
              ok(blocked.result?.status === 'blocked');
              equal(blocked.result.operationId, operationId);
              equal(blocked.result.reason, reason);
              equal(blocked.result.updateId, null);
              equal(blocked.candidate?.id, candidate.id);
              equal(blocked.candidate?.fingerprint, candidate.fingerprint);
              equal(blocked.candidate?.decisions.at(-1)?.version, approved.decisionVersion);
              deepStrictEqual(formalReleaseResultSchema.parse((await client.callTool({
                name: 'get_release_result', arguments: { taskId: task.id },
              })).structuredContent), { taskId: task.id, runId: task.runId, taskVersion: blocked.taskVersion, result: blocked.result });
              const english = await readResult('en', task.id);
              ok(english.result?.status === 'blocked');
              equal(english.result.reason, reason);
              equal(english.result.operationId, operationId);
              notEqual(english.result.reasonMessage, blocked.result.reasonMessage);
              await withEnglishReader(async lookup => {
                const output = await lookup.callTool({ name: 'get_release_result', arguments: { taskId: task.id } });
                deepStrictEqual(formalReleaseResultSchema.parse(output.structuredContent), {
                  taskId: task.id, runId: task.runId, taskVersion: english.taskVersion, result: english.result,
                });
              });

              const [record] = (await db.admin.query(`SELECT state, wakeup_job_id,
                (SELECT count(*)::int FROM itervane.formal_release_steps WHERE operation_id=$1 AND kind<>'archive') AS external_steps,
                (SELECT count(*)::int FROM itervane.formal_release_rollout_attempts WHERE operation_id=$1) AS rollouts
                FROM itervane.release_operations WHERE id=$1 AND candidate_id=$2`, [operationId, candidate.id])).rows;
              deepStrictEqual(record, { state: 'blocked', wakeup_job_id: null, external_steps: 0, rollouts: 0 });
              const [event] = (await db.admin.query(
                "SELECT detail FROM itervane.task_events WHERE task_id=$1 AND type='task.release_blocked' AND detail->>'operationId'=$2",
                [task.id, operationId],
              )).rows;
              equal(event?.detail?.reason, reason);
              equal(event?.detail?.fingerprint, candidate.fingerprint);
              equal(event?.detail?.decisionVersion, approved.decisionVersion);
              const archiveReadPrepared = reason === 'release_archive_unavailable';
              equal(Number.isSafeInteger(event?.detail?.fence), archiveReadPrepared);
              const { rows: archiveReads } = await db.admin.query(`SELECT state,prepared_fence,settled_fence,proof
                FROM itervane.formal_release_steps WHERE operation_id=$1 AND kind='archive'`, [operationId]);
              deepStrictEqual(archiveReads, archiveReadPrepared
                ? [{ state: 'prepared', prepared_fence: event?.detail?.fence, settled_fence: null, proof: null }] : []);
              equal(taskDtoSchema.parse(await request(`/v1/tasks/${task.id}`)).state, 'needs_human');
              const [slot] = (await db.admin.query('SELECT task_id FROM itervane.execution_slot WHERE id=1')).rows;
              equal(slot?.task_id, null);
              const response = await fetch(`${registry.origin}/v2/${targetSettings.imageRepository}/manifests/${candidate.manifest.image.manifestDigest}`, {
                redirect: 'error', signal: AbortSignal.timeout(5_000),
              });
              await response.body?.cancel();
              equal(response.status, 404);
              await target.assertUnchanged();
              await assertDrained(controllerUid, staging);
              return { taskId: task.id, candidateId: candidate.id, operationId, reason,
                archiveSha256: candidate.manifest.image.archive.sha256, approvalVersion: approved.decisionVersion,
                externalSteps: 0, archiveReadPrepared, registryManifestAbsent: true, komodoTargetUnchanged: true,
                httpMcpAgreement: true, slotReleased: true };
            } finally {
              await worker.stop('TERM');
              worker = undefined;
            }
          };
          phase = 'protected_release_target_drift';
          const newRollout = { ...ingress.check, backendPort: standardRuntimePort + 1 };
          const drifted = await registerReleaseTarget(db.storage, { ...targetSettings,
            rolloutCheck: newRollout, rolloutCheckSha256: fingerprintRolloutCheck(newRollout) });
          equal(drifted.revision, mapping.revision + 1);
          notEqual(drifted.fingerprint, mapping.fingerprint);
          const targetRejected = await runBlocked(current, decision, drifted.fingerprint, 'release_target_changed');

          const next = await cleanReleaseFixture();
          notEqual(next.current.id, current.id);
          const restored = await registerReleaseTarget(db.storage, targetSettings);
          equal(restored.revision, drifted.revision + 1);
          const nextApproval = await approve(next.current, next.after, next.generation, restored.fingerprint);
          phase = 'protected_release_archive_drift';
          const archiveRejected = await withReplacementArchive(shared, nextApproval.candidate.manifest.image.archive, () => {
            phase = 'protected_release_archive_drift_read';
            return runBlocked(next.current, nextApproval, restored.fingerprint, 'release_archive_unavailable');
          });
          return { sourceFingerprint: await sourceFingerprint(), postgres: postgres.version, imageSha256,
            drift: { target: targetRejected, archive: archiveRejected,
              targetBuild: after, archiveBuild: next.after, originalArchiveRestored: true } };
        }

        if (fault) {
          phase = 'protected_release_recorded_dispatch_recovery';
          const reference = `${new URL(registry.origin).host}/${targetSettings.imageRepository}@${image.manifestDigest}`;
          const trial = komodoTrial(registry.origin, target, current.id, operationId, { reference, configDigest: image.configDigest });
          const recovery = await recoverRecordedReleaseForRollout(trial, join(shared, 'release-tools/materialize_oci.py'));
          const anonymousBefore = await ingress.anonymousHealthStatus();
          ok(anonymousBefore === 401 || anonymousBefore === 403);
          phase = fault === 'health' ? 'protected_release_runtime_health_failure' : 'protected_release_identity_outage';
          const runtime = await target.exerciseFixtureHealth(reference, image.configDigest, standardRuntimePort, fault === 'health');
          if (fault === 'identity') await ingress.stopIdentity();
          const anonymousStatus = await ingress.anonymousHealthStatus();
          ok(anonymousStatus === 401 || anonymousStatus === 403);
          const expectedReason = fault === 'health' ? 'release_rollout_health_failed' : 'release_rollout_unavailable';
          worker = await startReleaseWorker(mapping.fingerprint);
          const review = await poll(async () => {
            const view = await readResult('zh-CN');
            if (view.result?.status === 'verified' || view.result?.status === 'blocked') throw new Error('protected_release_fault_verdict');
            return view.result?.status === 'manual_review' ? view : undefined;
          }, 55_000, 'protected_release_fault_result');
          await worker.stop('TERM'); worker = undefined;
          ok(review.result?.status === 'manual_review');
          equal(review.result.operationId, operationId);
          equal(review.result.updateId, recovery.updateId);
          equal(review.result.reason, expectedReason);
          equal(review.candidate?.fingerprint, candidate.fingerprint);
          equal(review.candidate?.decisions.at(-1)?.version, approved.decisionVersion);
          const zh = await client.callTool({ name: 'get_release_result', arguments: { taskId: current.id } });
          deepStrictEqual(formalReleaseResultSchema.parse(zh.structuredContent), {
            taskId: current.id, runId: current.runId, taskVersion: review.taskVersion, result: review.result,
          });
          const english = await readResult('en');
          ok(english.result?.status === 'manual_review');
          equal(english.result.reason, expectedReason);
          equal(english.result.updateId, recovery.updateId);
          notEqual(english.result.reasonMessage, review.result.reasonMessage);
          await withEnglishReader(async lookup => {
            const en = await lookup.callTool({ name: 'get_release_result', arguments: { taskId: current.id } });
            deepStrictEqual(formalReleaseResultSchema.parse(en.structuredContent), {
              taskId: current.id, runId: current.runId, taskVersion: english.taskVersion, result: english.result,
            });
          });

          const [record] = (await db.admin.query(`SELECT operation.state, operation.wakeup_job_id,
            observation.state AS observed_state, observation.failure, observation.proof
            FROM itervane.release_operations operation
            JOIN itervane.formal_release_rollout_attempts observation ON observation.operation_id=operation.id
            WHERE operation.id=$1 AND operation.candidate_id=$2`, [operationId, candidate.id])).rows;
          deepStrictEqual(record, { state: 'reconciling', wakeup_job_id: null, observed_state: 'rejected', failure: expectedReason, proof: null });
          const { rows: dispatches } = await db.admin.query(`SELECT state, external_update_id, prepared_fence, settled_fence
            FROM itervane.formal_release_steps WHERE operation_id=$1 AND kind='komodo_dispatch'`, [operationId]);
          deepStrictEqual(dispatches, [{ state: 'confirmed', external_update_id: recovery.updateId,
            prepared_fence: recovery.dispatchFence, settled_fence: recovery.observedFence }]);
          equal(taskDtoSchema.parse(await request(`/v1/tasks/${current.id}`)).state, 'needs_human');
          const [slot] = (await db.admin.query('SELECT task_id FROM itervane.execution_slot WHERE id=1')).rows;
          equal(slot?.task_id, null);
          equal((await target.observeContainer(reference, image.configDigest)).containerId, runtime.containerId);
          await assertDrained(controllerUid, staging);
          return { fault: { taskId: current.id, operationId, candidateId: candidate.id, reason: expectedReason, recovery,
            originStatusBefore: runtime.beforeStatus, originStatusAfter: runtime.afterStatus, anonymousStatus, after,
            manifestDigest: image.manifestDigest, configDigest: image.configDigest, httpMcpAgreement: true, environmentHeld: true } };
        }

        const publish = async (task: typeof current, approval: typeof decision) => {
          const { candidate, approved, image, operationId } = approval;
          phase = 'protected_release_installed_worker';
          worker = await startReleaseWorker(mapping.fingerprint);
          const verified = await poll(async () => {
            const view = await readResult('en', task.id);
            if (view.result?.status === 'manual_review' || view.result?.status === 'blocked') {
              throw new Error(view.result.reason ?? 'protected_release_manual_review');
            }
            return view.result?.status === 'verified' ? view : undefined;
          }, 155_000, 'protected_release_result');
          await worker.stop('TERM'); worker = undefined;

          phase = 'protected_release_evidence';
          const [record] = (await db.admin.query<{ state: string; proof: unknown; completed_at: Date; wakeup_job_id: string | null }>(
            `SELECT operation.state, attempt.proof, attempt.completed_at, operation.wakeup_job_id
              FROM itervane.release_operations operation JOIN itervane.formal_release_rollout_attempts attempt
                ON attempt.operation_id=operation.id AND attempt.state='verified'
              WHERE operation.id=$1 AND operation.candidate_id=$2`, [operationId, candidate.id])).rows;
          ok(record);
          equal(record.state, 'verified_formal');
          equal(record.wakeup_job_id, null);
          const proof = releaseRolloutProofSchema.parse(record.proof);
          equal(proof.operationId, operationId);
          equal(proof.candidateId, candidate.id);
          equal(proof.fingerprint, candidate.fingerprint);
          equal(proof.decisionVersion, approved.decisionVersion);
          equal(proof.mappingSha256, mapping.fingerprint);
          equal(proof.runtime.rolloutCheckSha256, rolloutCheckSha256);
          equal(proof.runtime.version, 'candidate-' + candidate.manifest.repairedSnapshotSha256.slice(0, 16));
          equal(proof.manifestDigest, image.manifestDigest);
          equal(proof.runtime.configDigest, image.configDigest);
          equal(proof.update.deploymentId, target.binding.deploymentId);
          equal(proof.update.actorId, target.binding.komodo.actorId);
          equal(proof.runtime.network, target.endpoint.network);
          const running = await target.observeContainer(proof.runtime.imageReference, image.configDigest);
          equal(running.containerId, proof.runtime.containerId);
          const [registryRecord] = (await db.admin.query(
            "SELECT proof FROM itervane.formal_release_steps WHERE operation_id=$1 AND kind='registry' AND state='confirmed'", [operationId],
          )).rows;
          const published = releaseRegistryImageProofSchema.parse(registryRecord?.proof);
          equal(published.manifestDigest, image.manifestDigest);
          equal(published.configDigest, image.configDigest);
          equal(published.reference, proof.runtime.imageReference);
          equal(taskDtoSchema.parse(await request(`/v1/tasks/${task.id}`)).state, 'succeeded');
          const [slot] = (await db.admin.query('SELECT task_id FROM itervane.execution_slot WHERE id=1')).rows;
          equal(slot?.task_id, null);
          await assertDrained(controllerUid, staging);

          const assertReader = async (view: typeof verified, lookup: Client) => {
            const seen = formalReleaseResultSchema.parse((await lookup.callTool({
              name: 'get_release_result', arguments: { taskId: task.id },
            })).structuredContent);
            deepStrictEqual(seen, { taskId: task.id, runId: task.runId, taskVersion: view.taskVersion, result: view.result });
            ok(seen.result?.status === 'verified');
            equal(seen.result.operationId, operationId);
            equal(seen.result.updateId, proof.update.updateId);
            deepStrictEqual(seen.result.evidence, { checkedAt: record.completed_at.toISOString(), version: proof.runtime.version,
              manifestDigest: image.manifestDigest, configDigest: image.configDigest, healthy: true, accessProtected: true });
            return seen.result;
          };
          const chinese = await assertReader(await readResult('zh-CN', task.id), client);
          const english = await withEnglishReader(lookup => assertReader(verified, lookup));
          equal(chinese.locale, 'zh-CN');
          equal(english.locale, 'en');
          notEqual(chinese.message, english.message);
          return { proof,
            report: { taskId: task.id, runId: task.runId, candidateId: candidate.id, operationId, fingerprint: candidate.fingerprint,
              decisionVersion: proof.decisionVersion, manifestDigest: proof.manifestDigest, configDigest: proof.runtime.configDigest,
              version: proof.runtime.version, updateId: proof.update.updateId, healthStatus: proof.runtime.healthStatus,
              anonymousStatus: proof.runtime.anonymousStatus, approvalDeniedWithoutPortal: true, httpMcpAgreement: true,
              model: 'scripted_anthropic_fixture', controlPlaneIdentity: 'signed_oidc_fixture', ingressIdentity: 'native_keycloak',
              repairCategory: restoreRun ? null : dependencyRun ? 'npm_dependency' : 'synthetic_secret',
              stagedFilesRemaining: false },
          };
        };
        const first = await publish(current, decision);
        const { proof } = first;
        const firstPublication = { taskId: current.id, operationId, containerId: proof.runtime.containerId };

        const verifyInstalledDiagnosis = async <T>(enrollmentSha256: string, readKey: string, publication: NativeDiagnosisPublication,
          acceptance?: NativeDiagnosisAcceptance<T>) => {
          phase = 'operations_formal_installation';
          const providerEnv = { ITERVANE_AUDIT_MODEL_PROVIDER: 'anthropic', ANTHROPIC_BASE_URL: audit.baseURL, ANTHROPIC_MODEL: auditFixtureModel };
          const configuration = workerConfig({ DATABASE_URL: db.runtimeUrl, ...providerEnv, ANTHROPIC_API_KEY: auditFixtureKey }).auditModel;
          ok(configuration);
          const { providerSha256 } = configuredAuditModel(configuration);
          const installed = { ITERVANE_OPERATIONS_ENVIRONMENT_ID: environment.id, ITERVANE_OPERATIONS_ENROLLMENT_SHA256: enrollmentSha256,
            ITERVANE_OPERATIONS_DIAGNOSIS_PROVIDER_SHA256: providerSha256 };
          const config = runtimeConfig({
            DATABASE_URL: db.runtimeUrl, ITERVANE_OIDC_ISSUER: oidc.config.issuer, ITERVANE_OIDC_AUDIENCE: oidc.config.audience,
            ITERVANE_PUBLIC_URL: publicUrl, ITERVANE_OPERATIONS_API_ENABLED: '1', ITERVANE_PORTAL_CLIENT_ID: portalClientId, ...installed,
            ITERVANE_RESTART_API_INSTALLATION_FILE: acceptance?.kind === 'restart' ? acceptance.installationFile : undefined,
          });
          const { app: diagnosisApi } = acceptance?.kind === 'rollback'
            ? { app: createApi(db.storage, config, { logger: false, operationsRestoreTarget: { environmentId: environment.id, mappingSha256: mapping.fingerprint } }) }
            : await createInstalledApi(db.storage, config, { logger: false });
          const reader = new Client({ name: 'itervane-native-diagnosis', version: '0.0.0' });
          try {
            const endpoint = await diagnosisApi.listen({ host: '127.0.0.1', port: 0 });
            const http: DiagnosisHttp = async (path, { locale = 'zh-CN', payload, portal = false, status } = {}) => {
              const token = portal ? `Bearer ${await oidc.token('owner', { azp: portalClientId })}` : await authorization();
              const response = await fetch(endpoint + path, { headers: { Authorization: token, 'Accept-Language': locale,
                ...(payload ? { 'content-type': 'application/json' } : {}) }, signal: AbortSignal.timeout(5_000),
                ...(payload ? { method: 'POST', body: JSON.stringify(payload) } : {}) });
              if (status !== undefined ? response.status !== status : !response.ok) {
                await response.body?.cancel();
                throw new Error(`fixture_diagnosis_http_${response.status}`);
              }
              if (!response.ok) { await response.body?.cancel(); return null; }
              return response.json() as Promise<unknown>;
            };
            await reader.connect(new StreamableHTTPClientTransport(new URL('/mcp', endpoint), {
              requestInit: { headers: { Authorization: `Bearer ${mcpToken}`, 'Accept-Language': 'zh-CN' } },
            }));
            const capability = await http('/v1/capabilities') as { stage: string; operations: boolean };
            equal(capability.stage, 'p3-b');
            equal(capability.operations, true);
            deepStrictEqual(await http(`/v1/tasks/${publication.taskId}/operations-option`), {
              option: { projectId: project.id, environmentId: environment.id, releaseOperationId: publication.operationId, diagnosis: true },
            });
            const { task: diagnosis } = admissionDtoSchema.parse((await reader.callTool({
              name: 'start_operations_diagnosis', arguments: { projectId: project.id, environmentId: environment.id,
                expectedReleaseOperationId: publication.operationId, idempotencyKey: randomUUID(), locale: 'zh-CN' },
            })).structuredContent);
            equal(diagnosis.state, 'queued');
            const initialCalls = audit.calls.length;
            worker = await startScopedWorker(bundle, ['PATH=/usr/bin:/bin', 'LANG=C.UTF-8', 'ITERVANE_WORKER_POLL_MS=100',
              'ITERVANE_WORKER_LEASE_SECONDS=30', ...Object.entries({ ...installed, ...providerEnv }).map(([name, value]) => `${name}=${value}`),
            ], { DATABASE_URL: db.runtimeUrl, ITERVANE_OPERATIONS_WHISKERS_READ_KEY: readKey, ANTHROPIC_API_KEY: auditFixtureKey });

            phase = 'operations_formal_investigation';
            await poll(async () => {
              const item = taskDtoSchema.parse(await http(`/v1/tasks/${diagnosis.id}`));
              if (item.state === 'needs_human' || item.state === 'failed') {
                const events = await http(`/v1/tasks/${item.id}/events`) as { items?: unknown[] };
                const reason = taskEventDtoSchema.safeParse(events.items?.at(-1)).data?.reason ?? 'operations_diagnosis_failed';
                const { rows } = await db.admin.query<{ section: string; state: string }>(
                  'SELECT section, state FROM itervane.operations_diagnosis_reads WHERE run_id=$1 ORDER BY created_at', [item.runId]);
                console.error(JSON.stringify({ phase, state: item.state, reason, evidence: rows, modelCalls: audit.calls.slice(initialCalls) }));
                throw new Error(reason);
              }
              return item.state === 'succeeded' ? true : undefined;
            }, 50_000, 'operations_diagnosis');
            phase = 'operations_formal_worker_stop';
            await worker.stop('TERM'); worker = undefined;
            phase = 'operations_formal_model_trace';
            const expectedSections = acceptance ? ['container', 'release'] : ['container', 'release', 'logs', 'metrics'];
            const previous = acceptance?.kind === 'rollback' ? acceptance.previousOperationId : null;
            const recommendation = previous ? 'review_rollback' : acceptance ? 'review_restart' : 'continue_observation';
            deepStrictEqual(audit.calls.slice(initialCalls), [...expectedSections.map(() => 'read_operations'), 'finish_role']);

            phase = 'operations_formal_evidence';
            const { rows } = await db.admin.query<{ document: unknown; sha256: string; container_id: string; tools_used: number; restore_id: string | null }>(
              `SELECT result.document, result.sha256, observation.document#>>'{observation,containerId}' AS container_id, runtime.tools_used,
                request.document->>'restoreExecutionId' AS restore_id
                FROM itervane.operations_diagnosis_results result
                JOIN itervane.operations_observations observation ON observation.run_id=result.run_id
                JOIN itervane.operations_requests request ON request.run_id=result.run_id
                JOIN itervane.run_runtime runtime ON runtime.run_id=result.run_id WHERE result.run_id=$1`, [diagnosis.runId]);
            equal(rows.length, 1);
            const row = rows[0]!;
            const receipt = operationsDiagnosisReceiptSchema.parse(row.document);
            equal(receipt.providerSha256, providerSha256);
            equal(receipt.runId, diagnosis.runId);
            equal(receipt.taskId, diagnosis.id);
            equal(sha256(JSON.stringify(receipt)), row.sha256);
            equal(row.tools_used, expectedSections.length);
            equal(row.container_id, publication.containerId);
            equal(row.restore_id, publication.restoreExecutionId ?? null);
            equal(receipt.result.previousReleaseOperationId, previous);
            deepStrictEqual(receipt.reads.map(item => item.section), expectedSections);
            const readDiagnosis = async (lookup: Client, locale: Locale) => {
              const response = operationsObservationViewSchema.parse(await http(`/v1/tasks/${diagnosis.id}/operations`, { locale }));
              const result = (await lookup.callTool({ name: 'get_operations_result', arguments: { taskId: diagnosis.id } })).structuredContent;
              deepStrictEqual(operationsObservationViewSchema.parse(result), response);
              equal(response.releaseOperationId, publication.operationId);
              equal(response.diagnosis?.receiptSha256, row.sha256);
              equal(response.observation?.state, acceptance ? 'exited' : 'running');
              equal(response.diagnosis?.recommendation.code, recommendation);
              const release = response.diagnosis?.facts.find(fact => fact.section === 'release');
              equal(release?.result.current.operationId, publication.operationId);
              if (previous) equal(release?.result.previous?.operationId, previous);
              const projected = JSON.stringify(response);
              for (const secret of [readKey, row.container_id]) ok(!projected.includes(secret));
              return response;
            };
            const zh = await readDiagnosis(reader, 'zh-CN');
            const en = await withEnglishReader(lookup => readDiagnosis(lookup, 'en'), endpoint);
            deepStrictEqual(zh.diagnosis?.facts, en.diagnosis?.facts);
            notEqual(zh.diagnosis?.recommendation.message, en.diagnosis?.recommendation.message);
            const accepted = await acceptance?.verify(diagnosis, row.sha256, { request: http, mcp: reader,
              withEnglishReader: read => withEnglishReader(read, endpoint) });
            return { runId: diagnosis.runId, releaseOperationId: publication.operationId, sha256: row.sha256,
              recommendation, previousReleaseOperationId: previous, restoreExecutionId: row.restore_id, accepted,
              sections: receipt.reads.map(item => item.section), matchedPublishedTarget: true, httpMcpAgreement: true, model: 'scripted_anthropic_fixture' };
          } finally {
            try { await reader.close(); } finally { await diagnosisApi.close(); }
          }
        };

        const verifyNativeRestore = async (second: Awaited<ReturnType<typeof publish>>) => {
          phase = 'operations_native_restore_enrollment';
          const native = await openNativeWhiskersReadScope();
          try {
            const enrollment = await registerOperationsTarget(db.storage, { environmentId: environment.id,
              releaseTargetRevision: mapping.revision, releaseTargetSha256: mapping.fingerprint,
              whiskers: { origin: native.origin, serverId: native.serverId } });
            const readerCredentials = await target.provisionRestartReader();
            notEqual(readerCredentials.actorId, target.credentials.actorId);
            const boundTarget = { ...target.binding, imageRepository: targetSettings.imageRepository, registryOrigin: targetSettings.registryOrigin };
            const reader = KomodoReleaseClient.readOnly(boundTarget, readerCredentials);
            await reader.verifyInstallation();
            const startRestoreProcess = async (leaseSeconds = 30) => {
              ok(!worker);
              worker = await startScopedWorker(join(shared, 'restore-worker.mjs'), [
                'PATH=/usr/bin:/bin', 'LANG=C.UTF-8', 'ITERVANE_WORKER_POLL_MS=250', `ITERVANE_WORKER_LEASE_SECONDS=${leaseSeconds}`,
                `NODE_EXTRA_CA_CERTS=${ca}`, `ITERVANE_OPERATIONS_ENVIRONMENT_ID=${environment.id}`,
                `ITERVANE_OPERATIONS_ENROLLMENT_SHA256=${enrollment.fingerprint}`,
                `ITERVANE_OPERATIONS_RELEASE_TARGET_SHA256=${mapping.fingerprint}`,
                `ITERVANE_RESTORE_KOMODO_READER_ID=${readerCredentials.actorId}`,
              ], { DATABASE_URL: db.runtimeUrl, ITERVANE_RESTORE_KOMODO_WRITER_KEY: target.credentials.key,
                ITERVANE_RESTORE_KOMODO_WRITER_SECRET: target.credentials.secret, ITERVANE_RESTORE_KOMODO_READER_KEY: readerCredentials.key,
                ITERVANE_RESTORE_KOMODO_READER_SECRET: readerCredentials.secret, ITERVANE_RESTORE_PROBE_SECRET: ingress.probeSecret });
            };
            const stopRestoreProcess = async (signal: 'TERM' | 'KILL') => {
              ok(worker);
              await worker.stop(signal);
              worker = undefined;
            };
            const authorizeRead = async () => {};
            const stopFixture = (instance: typeof proof.runtime) => target.setOwnedContainerRunning(false, {
              containerId: instance.containerId, reference: instance.imageReference, configDigest: instance.configDigest,
            });
            const observeApplied = async (expected: typeof proof) => {
              const { imageReference, configDigest } = expected.runtime;
              const observed = await target.observeContainer(imageReference, configDigest);
              const independent = await reader.inspectRuntime(boundTarget, { manifestDigest: expected.manifestDigest, configDigest },
                target.endpoint.network, authorizeRead);
              equal(independent.containerId, observed.containerId);
              equal(independent.imageReference, observed.reference);
              return observed;
            };
            const stopped = second.proof.runtime;
            phase = 'operations_native_restore_stop_bound_fixture';
            await stopFixture(stopped);
            const baseline = await reader.inspectStoppedRuntime(boundTarget, second.report, target.endpoint.network, authorizeRead);
            equal(baseline.state, 'exited');
            equal(baseline.containerId, stopped.containerId);
            const stoppedPublication = {
              taskId: second.report.taskId, operationId: second.report.operationId, containerId: stopped.containerId,
            };

            if (restoreAuthorityRun) {
              const proveDenied = async (kind: 'revoked' | 'expired' | 'target_changed') => {
                const result = await verifyInstalledDiagnosis(enrollment.fingerprint, native.readKey, stoppedPublication, {
                  kind: 'rollback', previousOperationId: first.report.operationId,
                  verify(diagnosis, diagnosisSha256, readers) {
                    phase = `operations_native_restore_denied_${kind}`;
                    return proveDeniedNativeRestore({ db, diagnosis, diagnosisSha256, current: second.proof, previous: first.proof,
                      ...readers, startWorker: startRestoreProcess,
                    }, kind === 'target_changed' ? {
                      kind, async startOriginal() {
                        await target.setOwnedContainerRunning(true, { containerId: stopped.containerId, reference: stopped.imageReference,
                          configDigest: stopped.configDigest });
                        equal((await observeApplied(second.proof)).containerId, stopped.containerId);
                      },
                    } : { kind });
                  },
                });
                ok(result.accepted);
                if (kind !== 'revoked') await stopRestoreProcess('TERM');
                const live = await reader.inspectTarget(boundTarget, authorizeRead);
                equal(live.imageReference, stopped.imageReference);
                if (kind === 'target_changed') equal((await observeApplied(second.proof)).containerId, stopped.containerId);
                else deepStrictEqual(await reader.inspectStoppedRuntime(boundTarget, second.report, target.endpoint.network, authorizeRead), baseline);
                return { ...result.accepted, diagnosisRunId: result.runId, originalContainerRetained: true };
              };
              const revoked = await proveDenied('revoked');
              const expired = await proveDenied('expired');
              const targetChanged = await proveDenied('target_changed');
              const anonymous = await ingress.anonymousHealthStatus();
              ok(anonymous === 401 || anonymous === 403);
              return { authorization: { revoked, expired, targetChanged, anonymousStatus: anonymous, distinctKomodoReader: true } };
            }

            const { accepted, ...stoppedDiagnosis } = await verifyInstalledDiagnosis(enrollment.fingerprint, native.readKey, stoppedPublication, {
              kind: 'rollback', previousOperationId: first.report.operationId,
              verify(diagnosis, diagnosisSha256, readers) {
                phase = 'operations_native_restore_submission';
                return proveNativeRestore({ db, diagnosis, diagnosisSha256, current: second.proof, previous: first.proof,
                  ...readers, async startWorker() {
                    phase = 'operations_native_restore_worker';
                    await startRestoreProcess();
                  },
                });
              },
            });
            ok(accepted);
            await stopRestoreProcess('TERM');

            phase = 'operations_native_restore_readback';
            const { runtime, update } = accepted.proof;
            deepStrictEqual(await reader.observeUpdate(boundTarget, update.updateId, authorizeRead), update);
            equal((await target.observeContainer(runtime.imageReference, runtime.configDigest)).containerId, runtime.containerId);
            const anonymous = await ingress.anonymousHealthStatus();
            ok(anonymous === 401 || anonymous === 403);
            const restoredPublication = {
              ...firstPublication, containerId: runtime.containerId, restoreExecutionId: accepted.proof.executionId,
            };
            const postRestoreDiagnosis = await verifyInstalledDiagnosis(enrollment.fingerprint, native.readKey, restoredPublication);
            notEqual(postRestoreDiagnosis.runId, stoppedDiagnosis.runId);

            phase = 'operations_native_restore_stop_before_takeover';
            await stopFixture(runtime);
            const recorded = await verifyInstalledDiagnosis(enrollment.fingerprint, native.readKey, restoredPublication, {
              kind: 'rollback', previousOperationId: second.report.operationId,
              verify(diagnosis, diagnosisSha256, readers) {
                phase = 'operations_native_restore_recorded_takeover';
                return proveNativeRestore({ db, diagnosis, diagnosisSha256, current: { ...first.proof, runtime, update },
                  previous: second.proof, ...readers, startWorker: () => startRestoreProcess(18) }, {
                  stopSender: () => stopRestoreProcess('KILL'),
                  observeApplied: () => observeApplied(second.proof),
                });
              },
            });
            const settled = recorded.accepted;
            ok(settled?.report.takeover);
            await stopRestoreProcess('TERM');
            deepStrictEqual(await reader.observeUpdate(boundTarget, settled.proof.update.updateId, authorizeRead), settled.proof.update);

            const latestRuntime = settled.proof.runtime;
            const latestPublication = {
              taskId: second.report.taskId, operationId: second.report.operationId, containerId: latestRuntime.containerId,
              restoreExecutionId: settled.proof.executionId,
            };
            phase = 'operations_native_restore_stop_before_missing_acknowledgement';
            await stopFixture(latestRuntime);
            const interrupted = await verifyInstalledDiagnosis(enrollment.fingerprint, native.readKey, latestPublication, {
              kind: 'rollback', previousOperationId: first.report.operationId,
              verify(diagnosis, diagnosisSha256, readers) {
                phase = 'operations_native_restore_lost_acknowledgement';
                return proveInterruptedNativeRestore({ db, diagnosis, diagnosisSha256, environmentId: environment.id,
                  current: { ...second.proof, runtime: latestRuntime, update: settled.proof.update }, previous: first.proof, ...readers,
                  startWorker: () => startRestoreProcess(18),
                  stopSender: () => stopRestoreProcess('KILL'),
                  observeApplied: () => observeApplied(first.proof),
                });
              },
            });
            ok(interrupted.accepted);
            await stopRestoreProcess('TERM');
            notEqual(interrupted.runId, recorded.runId);
            return { restoration: { ...accepted.report, distinctKomodoReader: true, stoppedState: baseline.state, stoppedDiagnosis, postRestoreDiagnosis,
              recordedTakeover: { ...settled.report, diagnosisRunId: recorded.runId, diagnosisRestoreExecutionId: recorded.restoreExecutionId },
              interruption: { ...interrupted.accepted, diagnosisRunId: interrupted.runId, diagnosisRestoreExecutionId: interrupted.restoreExecutionId } } };
          } finally {
            try { await worker?.stop('TERM'); worker = undefined; }
            finally { await native.close(); }
          }
        };

        if (restoreRun) {
          const scope = { projectId: project.id, environmentId: environment.id };
          const history = () => db.storage.db.transaction(tx => readPublishedOperationsDeployment(tx, scope, { includePrevious: true }));
          const initial = await history();
          equal(initial.releaseOperationId, first.report.operationId);
          equal(initial.containerId, first.proof.runtime.containerId);
          equal(initial.previous, null);

          const next = await cleanReleaseFixture(runtimeFaultCommit);
          notEqual(next.current.id, current.id);
          const nextDecision = await approve(next.current, next.after, next.generation, mapping.fingerprint);
          notEqual(nextDecision.candidate.manifest.source.commit, candidate.manifest.source.commit);
          notEqual(nextDecision.image.manifestDigest, image.manifestDigest);
          notEqual(nextDecision.image.configDigest, image.configDigest);
          const second = await publish(next.current, nextDecision);
          notEqual(second.proof.update.updateId, first.proof.update.updateId);
          notEqual(second.proof.runtime.containerId, first.proof.runtime.containerId);
          notEqual(second.proof.runtime.version, first.proof.runtime.version);

          const latest = await history();
          equal(latest.applicationId, application.id);
          equal(latest.deploymentId, target.binding.deploymentId);
          equal(latest.mappingSha256, mapping.fingerprint);
          equal(latest.releaseOperationId, second.report.operationId);
          equal(latest.containerId, second.proof.runtime.containerId);
          equal(latest.manifestDigest, second.report.manifestDigest);
          ok(latest.previous);
          equal(latest.previous.releaseOperationId, first.report.operationId);
          equal(latest.previous.manifestDigest, first.report.manifestDigest);

          const { restoration, authorization } = await verifyNativeRestore(second);
          const restored = await history();
          equal(restored.releaseOperationId, second.report.operationId);
          equal(restored.previous?.releaseOperationId, first.report.operationId);
          if (restoration) {
            ok('restoreExecutionId' in restored);
            equal(restored.restoreExecutionId, restoration.recordedTakeover.executionId);
            equal(restored.containerId, restoration.recordedTakeover.restoredContainerId);
            equal(restored.updateId, restoration.recordedTakeover.updateId);
          } else {
            ok(authorization);
            equal(restored.containerId, second.proof.runtime.containerId);
            equal(restored.updateId, second.proof.update.updateId);
          }
          await assertDrained(controllerUid, staging);
          return { sourceFingerprint: await sourceFingerprint(), postgres: postgres.version, imageSha256, release: first.report,
            dualVersion: { first: { release: first.report, build: after }, second: { release: second.report, build: next.after },
              currentOperationId: latest.releaseOperationId, previousOperationId: latest.previous.releaseOperationId,
              applicationId: application.id, environmentId: environment.id, mappingSha256: mapping.fingerprint,
              sameTarget: true, sameProtectedIngress: true },
            ...(restoration ? { restoration: { ...restoration, whiskersCleanup: true } }
              : { restoreAuthorization: { ...authorization, whiskersCleanup: true } }) };
        }

        const verifyNativeObservation = async () => {
          phase = 'operations_whiskers_installation';
          const native = await openNativeWhiskersReadScope();
          try {
            const enrollment = await registerOperationsTarget(db.storage, { environmentId: environment.id,
              releaseTargetRevision: mapping.revision, releaseTargetSha256: mapping.fingerprint,
              whiskers: { origin: native.origin, serverId: native.serverId } });
            const human = await createIdentityVerifier(oidc.config)(await oidc.token());
            const admitted = await new TaskService(db.storage).admitOperations(human, { projectId: project.id, environmentId: environment.id,
              idempotencyKey: randomUUID(), locale: 'zh-CN' });
            const diagnostic = admitted.task;
            equal(diagnostic.state, 'queued');
            equal(admitted.replayed, false);

            phase = 'operations_whiskers_observation';
            worker = await startScopedWorker(bundle, ['PATH=/usr/bin:/bin', 'LANG=C.UTF-8', 'ITERVANE_WORKER_POLL_MS=100',
              'ITERVANE_WORKER_LEASE_SECONDS=30', `ITERVANE_OPERATIONS_ENVIRONMENT_ID=${environment.id}`,
              `ITERVANE_OPERATIONS_ENROLLMENT_SHA256=${enrollment.fingerprint}`,
            ], { DATABASE_URL: db.runtimeUrl, ITERVANE_OPERATIONS_WHISKERS_READ_KEY: native.readKey });
            const completed = await poll(async () => {
              const task = taskDtoSchema.parse(await request(`/v1/tasks/${diagnostic.id}`));
              if (task.state === 'needs_human' || task.state === 'failed') {
                const history = (await request(`/v1/tasks/${task.id}/events`)) as { items?: unknown[] };
                const last = taskEventDtoSchema.safeParse(history.items?.at(-1));
                throw new Error(last.data?.reason ?? 'operations_observation_failed');
              }
              return task.state === 'succeeded' ? task : undefined;
            }, 38_000, 'operations_observation');
            await worker.stop('TERM'); worker = undefined;

            phase = 'operations_whiskers_evidence';
            const { rows } = await db.admin.query<{ proof: unknown; binding_sha256: string; sha256: string; fence: number; tools_used: number }>(
              `SELECT observation.document AS proof, observation.binding_sha256, observation.sha256, observation.fence, runtime.tools_used
                FROM itervane.operations_observations observation
                JOIN itervane.run_runtime runtime ON runtime.run_id=observation.run_id
                WHERE observation.run_id=$1`, [diagnostic.runId]);
            equal(rows.length, 1);
            const row = rows[0]!;
            const receipt = operationsObservationReceiptSchema.parse(row.proof);
            equal(receipt.taskId, diagnostic.id);
            equal(receipt.runId, diagnostic.runId);
            equal(receipt.releaseOperationId, operationId);
            equal(receipt.observation.containerId, proof.runtime.containerId);
            equal(receipt.observation.serverId, native.serverId);
            equal(receipt.observation.state, 'running');
            equal(receipt.bindingSha256, row.binding_sha256);
            equal(receipt.fence, row.fence);
            equal(row.sha256, sha256(JSON.stringify(receipt)));
            equal(row.tools_used, 1);

            const compareReader = async (lookup: Client, locale: Locale) => {
              const task = (await lookup.callTool({ name: 'get_task', arguments: { taskId: diagnostic.id } })).structuredContent;
              deepStrictEqual(taskDtoSchema.parse(task), completed);
              const events = (await lookup.callTool({ name: 'get_task_events', arguments: { taskId: diagnostic.id } })).structuredContent as { items: unknown[] };
              const http = (await request(`/v1/tasks/${diagnostic.id}/events`, undefined, false, locale)) as { items: unknown[] };
              deepStrictEqual(events.items.map(item => taskEventDtoSchema.parse(item)), http.items.map(item => taskEventDtoSchema.parse(item)));
              const latest = taskEventDtoSchema.parse(events.items.at(-1));
              equal(latest.type, 'task.operations_observed');
              equal(latest.locale, locale);
              return latest.message;
            };
            notEqual(await compareReader(client, 'zh-CN'), await withEnglishReader(lookup => compareReader(lookup, 'en')));
            const diagnosis = await verifyInstalledDiagnosis(enrollment.fingerprint, native.readKey, firstPublication);
            equal((await target.observeContainer(proof.runtime.imageReference, image.configDigest)).containerId, receipt.observation.containerId);
            const [counts] = (await db.admin.query(`SELECT
              (SELECT count(*)::int FROM itervane.release_operations WHERE environment_id=$1) AS releases,
              (SELECT count(*)::int FROM itervane.formal_release_steps WHERE operation_id=$2 AND kind='komodo_dispatch') AS dispatches,
              (SELECT task_id FROM itervane.execution_slot WHERE id=1) AS slot_task`, [environment.id, operationId])).rows;
            deepStrictEqual(counts, { releases: 1, dispatches: 1, slot_task: null });
            return { taskId: diagnostic.id, runId: diagnostic.runId, releaseOperationId: operationId, bindingSha256: receipt.bindingSha256,
              containerId: receipt.observation.containerId, state: receipt.observation.state, observedAt: receipt.observation.observedAt,
              fence: receipt.fence, receipts: rows.length, reads: row.tools_used, releaseDispatches: 1, slotReleased: true,
              matchedPublishedTarget: true, httpMcpAgreement: true, diagnosis };
          } finally {
            try { await worker?.stop('TERM'); worker = undefined; }
            finally { await native.close(); }
          }
        };
        const verifyRestartReadback = async () => {
          phase = 'operations_restart_readback';
          const { containerId, imageReference: reference, configDigest, version } = proof.runtime;
          const expected = { containerId, reference, configDigest };
          const adapter = new KomodoReleaseClient(target.binding.komodo.origin, target.credentials);
          const verifier = new ReleaseRolloutVerifier(adapter, createKeycloakRolloutTokenSource(ingress.check.probeIdentity, ingress.probeSecret));
          const subject = { containerId, version, image, rolloutCheckSha256, check: ingress.check,
            target: { ...target.binding, imageRepository: targetSettings.imageRepository, registryOrigin: targetSettings.registryOrigin } };
          const authorize = async () => {};
          const trusted = getCACertificates('default');
          const fixtureCertificates = readFileSync(ingress.caFile, 'utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
          equal(fixtureCertificates?.length, 2);
          setDefaultCACertificates([...trusted, ...fixtureCertificates!]);
          try {
            await target.setOwnedContainerRunning(false, expected);
            const stopped = await verifier.captureRestartBaseline(subject, authorize);
            equal(stopped.state, 'exited');
            equal(stopped.containerId, containerId);
            await rejects(verifier.observeRestart(subject, stopped, authorize), {
              name: 'KomodoReleaseError', step: 'InspectDeploymentContainer', reason: 'response',
            });
            await target.setOwnedContainerRunning(true, expected);
            const recovered = await poll(async () => {
              try { return await verifier.observeRestart(subject, stopped, authorize); }
              catch (error) {
                if (error instanceof ReleaseIngressError && error.reason === 'health_failed') return undefined;
                throw error;
              }
            }, 15_000, 'operations_restart_health');
            deepStrictEqual(recovered.runtime, proof.runtime);
            ok(recovered.startedAt > stopped.startedAt);
            return { version, manifestDigest: image.manifestDigest, configDigest, sameContainer: recovered.runtime.containerId === containerId,
              stoppedStart: stopped.startedAt, recoveredStart: recovered.startedAt, protectedStatus: recovered.runtime.anonymousStatus,
              healthStatus: recovered.runtime.healthStatus };
          } finally { setDefaultCACertificates(trusted); }
        };
        const verifyNativeRestart = async () => {
          phase = 'operations_native_restart_installation';
          const native = await openNativeWhiskersRestartScope();
          try {
            const enrollment = await registerOperationsTarget(db.storage, { environmentId: environment.id,
              releaseTargetRevision: mapping.revision, releaseTargetSha256: mapping.fingerprint,
              whiskers: { origin: native.origin, serverId: native.serverId } });
            const fixtureFiles = await native.installationFiles({ environmentId: environment.id, enrollmentSha256: enrollment.fingerprint });
            const installation = operationsRestartInstallationSchema.parse(JSON.parse(readFileSync(fixtureFiles.installation, 'utf8')));
            const registered = await changeOperationsRestartInstallation(db.storage, { action: 'register', expectedActiveId: null, installation });
            equal(registered.installationSha256, sha256(JSON.stringify(installation)));
            const files = { installation: join(shared, 'restart-installation.json'), guardrails: join(shared, 'restart-guardrails.json'),
              roles: join(shared, 'restart-roles.json') };
            for (const name of ['installation', 'guardrails', 'roles'] as const) {
              await execute('/usr/bin/sudo', ['-n', 'install', '-m', '0444', fixtureFiles[name], files[name]], { timeout: 5_000 });
            }
            const readerCredentials = await target.provisionRestartReader();
            notEqual(readerCredentials.actorId, target.credentials.actorId);
            phase = 'operations_native_restore_installation';
            const restoreConfig = restoreWorkerConfig({ DATABASE_URL: db.runtimeUrl,
              ITERVANE_OPERATIONS_ENVIRONMENT_ID: environment.id, ITERVANE_OPERATIONS_ENROLLMENT_SHA256: enrollment.fingerprint,
              ITERVANE_OPERATIONS_RELEASE_TARGET_SHA256: mapping.fingerprint, ITERVANE_RESTORE_KOMODO_WRITER_KEY: target.credentials.key,
              ITERVANE_RESTORE_KOMODO_WRITER_SECRET: target.credentials.secret, ITERVANE_RESTORE_KOMODO_READER_ID: readerCredentials.actorId,
              ITERVANE_RESTORE_KOMODO_READER_KEY: readerCredentials.key, ITERVANE_RESTORE_KOMODO_READER_SECRET: readerCredentials.secret,
              ITERVANE_RESTORE_PROBE_SECRET: ingress.probeSecret });
            await rejects(createInstalledRestoreWorker(db.storage, { ...restoreConfig,
              installed: { ...restoreConfig.installed, mappingSha256: sha256('unregistered restore configuration') } }), /release_installation_target/);
            await rejects(createInstalledRestoreWorker(db.storage, { ...restoreConfig,
              reader: { ...readerCredentials, actorId: target.credentials.actorId } }), { reason: 'binding' });
            const restoreWorker = await createInstalledRestoreWorker(db.storage, restoreConfig);
            equal(await restoreWorker.tick(), 'idle');
            const boundTarget = { ...target.binding, imageRepository: targetSettings.imageRepository, registryOrigin: targetSettings.registryOrigin };
            const reader = KomodoReleaseClient.readOnly(boundTarget, readerCredentials);
            await reader.verifyInstallation();
            const verifier = new ReleaseRolloutVerifier(reader, createKeycloakRolloutTokenSource(ingress.check.probeIdentity, ingress.probeSecret));
            const { containerId, version, configDigest, imageReference } = proof.runtime;
            const subject = { containerId, version, image, rolloutCheckSha256, check: ingress.check, target: boundTarget };

            const exerciseRestart = async (interrupted: boolean) => {
              phase = 'operations_native_stop_bound_fixture';
              await target.setOwnedContainerRunning(false, { containerId, configDigest, reference: imageReference });
              const startRestartProcess = async () => {
                phase = 'operations_native_restart_worker';
                worker = await startScopedWorker(join(shared, 'restart-worker.mjs'), [
                  'PATH=/usr/bin:/bin', 'LANG=C.UTF-8', 'ITERVANE_WORKER_POLL_MS=250',
                  `ITERVANE_WORKER_LEASE_SECONDS=${interrupted ? 18 : 30}`,
                  `NODE_EXTRA_CA_CERTS=${ca}`, `ITERVANE_OPERATIONS_ENVIRONMENT_ID=${environment.id}`,
                  `ITERVANE_OPERATIONS_ENROLLMENT_SHA256=${enrollment.fingerprint}`, `ITERVANE_OPERATIONS_RELEASE_TARGET_SHA256=${mapping.fingerprint}`,
                  `ITERVANE_RESTART_INSTALLATION_FILE=${files.installation}`, `ITERVANE_RESTART_GUARDRAILS_FILE=${files.guardrails}`,
                  `ITERVANE_RESTART_ROLES_FILE=${files.roles}`, `ITERVANE_RESTART_KOMODO_READER_ID=${readerCredentials.actorId}`,
                ], { DATABASE_URL: db.runtimeUrl, ITERVANE_RESTART_KOMODO_READER_KEY: readerCredentials.key,
                  ITERVANE_RESTART_KOMODO_READER_SECRET: readerCredentials.secret, ITERVANE_RESTART_WHISKERS_WRITE_KEY: native.writeKey,
                  ITERVANE_RESTART_PROBE_SECRET: ingress.probeSecret });
              };
              const result = await verifyInstalledDiagnosis(enrollment.fingerprint, native.readKey, firstPublication, {
                kind: 'restart', installationFile: files.installation,
                async verify(diagnosis, diagnosisSha256, { request, mcp }) {
                  await startRestartProcess();
                  phase = interrupted ? 'operations_native_restart_interruption' : 'operations_native_restart_application';
                  const count = interrupted ? 2 : 1;
                  const accepted = await proveNativeRestart({ db, diagnosis, diagnosisSha256, released: proof, request, mcp,
                    readStopped: () => verifier.captureRestartBaseline(subject, async () => {}),
                    approve: () => native.approve(containerId, count), verifyAudit: () => native.verifyAudit(target.endpoint.container, count),
                  }, interrupted ? {
                    environmentId: environment.id,
                    async stopWorker() {
                      const active = worker;
                      ok(active);
                      await active.stop('KILL');
                      worker = undefined;
                    },
                    startWorker: startRestartProcess,
                  } : undefined);
                  ok(worker);
                  await worker.stop('TERM'); worker = undefined;
                  return accepted;
                },
              });
              ok(result.accepted);
              return { ...result.accepted, diagnosisRunId: result.runId, diagnosisSections: result.sections,
                distinctKomodoReader: true, model: result.model };
            };
            const verified = await exerciseRestart(false);
            const interrupted = await exerciseRestart(true);
            equal(interrupted.stoppedStart, verified.recoveredStart);
            notEqual(interrupted.approvalId, verified.approvalId);
            notEqual(interrupted.diagnosisRunId, verified.diagnosisRunId);
            return { ...verified, interrupted, restoreWorker: { separateReadIdentity: true, mismatchedMappingDenied: true, idleWithoutWork: true } };
          } finally {
            try { await worker?.stop('TERM'); worker = undefined; }
            finally { await native.close(); }
          }
        };
        const operations = operationsRun ? await verifyNativeObservation() : undefined;
        const restartReadback = operationsRun ? await verifyRestartReadback() : undefined;
        const restart = operationsRun ? await verifyNativeRestart() : undefined;
        return {
          sourceFingerprint: await sourceFingerprint(), postgres: postgres.version, imageSha256,
          ...(operations ? { operations: { ...operations, whiskersCleanup: true, restartReadback, restart } } : {}),
          ...('before' in prepared
            ? { retry: { before: prepared.before, after, retrySha256: prepared.retrySha256, generation } }
            : ('dependencyPatchSha256' in prepared
              ? { dependency: { after, generation, advisoryId: npmReleaseApproval.advisoryId, patchSha256: prepared.dependencyPatchSha256 } } : {})),
          release: first.report,
        };
      };
      if (protectedRun) {
        // Keep the API, MCP session, and database open until this case settles.
        if (!faultRun) return await runProtectedCase();
        const unhealthy = await runProtectedCase('health');
        await closeReleaseFixtures();
        const identity = await runProtectedCase('identity');
        ok(unhealthy.fault && identity.fault);
        notEqual(unhealthy.fault.taskId, identity.fault.taskId);
        notEqual(unhealthy.fault.operationId, identity.fault.operationId);
        return { sourceFingerprint: await sourceFingerprint(), postgres: postgres.version, imageSha256,
          faults: { health: unhealthy.fault, identity: identity.fault } };
      }
      if (buildMode === 'standard-build-missing-cache') {
        const missing = await buildFixture(standardBuildCommit, 'offline_install');
        equal(missing.build.status, 'failed');
        return { sourceFingerprint: await sourceFingerprint(), postgres: postgres.version, imageSha256, missing, stagedFilesRemaining: false };
      }
      const built = await buildFixture(standardBuildCommit, 'built', 'passed');
      equal(built.build.status, 'built');
      if (built.build.status !== 'built') throw new Error('standard_build_output_missing');
      const paths = ['index.html', 'package-lock.json', 'package.json', 'server/app.mjs', 'server/index.mjs', 'src/main.jsx', 'src/style.css'];
      const projection = paths.map(path => {
        const data = readFileSync(`fixtures/standard-app/${path}`);
        return { path, sha256: sha256(data), bytes: data.length };
      });
      equal(built.build.projectionSha256, sha256(JSON.stringify(projection)));
      ok(built.build.dist.files >= 2 && built.build.dist.bytes > 0);
      const passing = built.build.baseline;
      ok(passing?.status === 'passed');
      equal(passing.appExited, true);
      equal(passing.distSha256, built.build.dist.sha256);
      if (build.oci) {
        const image = passing.image;
        ok(image?.status === 'scanned');
        equal(image.ociInputsSha256, build.oci);
        equal(image.runtimeInputsSha256, passing.runtimeInputsSha256);
        equal(image.scan.imageDigest, image.manifestDigest);
        equal(image.scan.configDigest, image.configDigest);
        ok(image.scan.osPackages > 0 && image.scan.npmPackages > 0);
        ok(image.archive && image.archive.bytes > 0);
      } else equal(passing.image, undefined);
      const healthRegression = await buildFixture(standardHealthRegressionCommit, 'built', 'failed');
      ok(healthRegression.build.status === 'built' && healthRegression.build.baseline?.status === 'failed');
      const failed = healthRegression.build.baseline;
      equal(failed.appExited, true);
      equal(failed.image, undefined);
      equal(failed.distSha256, passing.distSha256);
      notEqual(failed.runtimeInputsSha256, passing.runtimeInputsSha256);
      deepStrictEqual(failed.checks[0], { id: 'health', status: 'failed', code: 'unexpected_status', statusCode: 503 });
      ok(failed.checks.slice(1).every(check => check.status === 'passed'));
      const drift = await buildFixture(standardLockDriftCommit, 'profile_mismatch');
      equal(drift.build.status, 'blocked');
      let retry;
      if (automaticProfile) {
        const { current, before, after, retrySha256, generation } = await repairRetryFixture(automaticProfile);
        phase = 'standard_formal_release_candidate';
        const application = applicationDtoSchema.parse(await request(`/v1/projects/${project.id}/applications`, { name: 'Standard release fixture' }));
        const environment = environmentDtoSchema.parse(await request(`/v1/projects/${project.id}/environments`, { name: 'Protected sample', applicationId: application.id }));
        const registry = releaseRegistry = await temporaryRegistry();
        phase = 'standard_komodo_core';
        const komodo = releaseKomodo = await openNativeReleaseKomodo();
        const knownTarget = await komodo.prepare();
        const bind = (environmentId: string, fixture: typeof knownTarget) => registerReleaseTarget(db.storage, {
          environmentId, ...fixture.binding, imageRepository: 'testing/standard', registryOrigin: registry.origin,
          verificationProfileSha256: verificationProfileFingerprint(automaticProfile),
          rolloutCheckSha256: sha256('native rollout fixture'), recoveryPlanSha256: sha256('native previous release fixture'),
        });
        const target = await bind(environment.id, knownTarget);
        phase = 'standard_formal_release_candidate';
        const candidatePath = `/v1/tasks/${current.id}/release-candidate`;
        const candidate = formalReleaseCandidateDtoSchema.parse(await request(candidatePath, { environmentId: environment.id, expectedVersion: current.version }));
        deepStrictEqual(formalReleaseCandidateDtoSchema.parse(await request(candidatePath)), candidate);
        equal(sha256(JSON.stringify(candidate.manifest)), candidate.fingerprint);
        equal(candidate.manifest.runId, current.runId);
        equal(candidate.manifest.generation, 2);
        equal(candidate.manifest.diffSha256, after.patchSha256);
        equal(candidate.manifest.verification.resultSha256, after.verificationResultSha256);
        equal(candidate.manifest.verification.receiptSha256, after.receiptSha256);
        equal(candidate.manifest.target.mappingSha256, target.fingerprint);
        deepStrictEqual(candidate.manifest.image.archive, after.archiveVerification?.archive);
        equal(taskDtoSchema.parse(await request(`/v1/tasks/${current.id}`)).state, 'waiting_approval');
        equal((await db.admin.query('SELECT count(*)::int AS count FROM itervane.release_operations')).rows[0]?.count, 0);
        phase = 'standard_formal_release_approval';
        const approved = (await request(`/v1/release-candidates/${candidate.id}/decisions`, {
          action: 'confirm', fingerprint: candidate.fingerprint, expectedVersion: 0, idempotencyKey: randomUUID(),
        }, true)) as { candidate: unknown; replayed: boolean };
        const confirmed = formalReleaseCandidateDtoSchema.parse(approved.candidate);
        const operationId = idSchema.parse(confirmed.operationId);
        equal(confirmed.status, 'confirmed');
        equal(confirmed.decisionVersion, 1);
        equal(confirmed.decisions[0]?.selfConfirmed, true);
        equal(approved.replayed, false);
        deepStrictEqual((await db.storage.boss.findJobs(formalReleaseQueue, { id: operationId }))[0]?.data, { operationId });
        const execution = new ExecutionCoordinator(db.storage);
        await execution.reconcile(randomUUID());
        const [genericWakeup] = (await db.admin.query('SELECT wakeup_job_id FROM itervane.task_runs WHERE id=$1', [current.runId])).rows;
        equal(genericWakeup?.wakeup_job_id, null);
        phase = 'standard_formal_release_claim';
        const releaseWork = new FormalReleaseCoordinator(execution, registry.origin);
        const [wakeup] = await db.storage.boss.fetch(formalReleaseQueue, { includeMetadata: true });
        ok(wakeup);
        equal(wakeup.id, operationId);
        const scope = await releaseWork.claim(wakeup, randomUUID());
        ok(scope);
        equal(scope.operationId, operationId);
        equal(scope.candidateId, candidate.id);
        equal(scope.fingerprint, candidate.fingerprint);
        equal(scope.generation, 2);
        const authority = await releaseWork.authorize(scope);
        equal(authority.mapping.registryOrigin, registry.origin);
        equal(authority.mapping.imageRepository, 'testing/standard');
        deepStrictEqual(authority.manifest, candidate.manifest);
        deepStrictEqual(authority.archiveVerification, after.archiveVerification);
        ok(await releaseWork.heartbeat(scope));
        await releaseWork.yieldClaim(scope);
        const [yielded] = (await db.storage.pool.query<{ state: string; wakeup_job_id: string }>(
          'SELECT state,wakeup_job_id FROM itervane.release_operations WHERE id=$1', [operationId])).rows;
        ok(yielded?.wakeup_job_id);
        equal(yielded.state, 'queued');
        notEqual(yielded.wakeup_job_id, wakeup.id);
        deepStrictEqual((await db.storage.boss.findJobs(formalReleaseQueue, { id: yielded.wakeup_job_id }))[0]?.data, { operationId });
        equal(await releaseWork.claim(wakeup, randomUUID()), null);
        const claim = { operationId, runId: scope.runId, generation: scope.generation, candidateId: scope.candidateId,
          decisionVersion: scope.decisionVersion, fence: scope.fence, archiveSha256: authority.archiveVerification.archive.sha256,
          wokeAgain: true, staleWakeupDenied: true };
        phase = 'standard_formal_release_archive_transport';
        const transport = await runScopedFixtureWorker(verificationBundle, socket, controllerUid, imageSha256, db.runtimeUrl,
          'verification', ['read-approved-archive', operationId, registry.origin]);
        const { archive, manifestDigest, configDigest } = candidate.manifest.image;
        deepStrictEqual(transport, { operationId, fingerprint: candidate.fingerprint, archiveSha256: archive.sha256,
          bytes: archive.bytes, wrongRunnerDenied: true, wrongSizeDenied: true, revokedDenied: true, stagedFilesRemaining: false,
          registryInitiallyAbsent: true });
        phase = 'standard_registry_import_interruption';
        const interrupted = await killAfterRegistryImport(verificationBundle, socket, controllerUid, imageSha256, db.runtimeUrl,
          operationId, registry.origin, join(dirname(bundle), 'release-tools/materialize_oci.py'));
        const pinnedImage = { registryOrigin: registry.origin, repository: 'testing/standard',
          reference: `${new URL(registry.origin).host}/testing/standard@${manifestDigest}`, archive, manifestDigest, configDigest };
        deepStrictEqual(interrupted.imported, pinnedImage);
        ok(interrupted.fence > scope.fence);
        const readRegistryIntent = async () => (await db.storage.pool.query<{
          state: string; prepared_fence: number; settled_fence: number | null; proof: unknown;
        }>("SELECT state,prepared_fence,settled_fence,proof FROM itervane.formal_release_steps WHERE operation_id=$1 AND kind='registry'",
          [operationId])).rows;
        deepStrictEqual(await readRegistryIntent(), [{ state: 'prepared', prepared_fence: interrupted.fence, settled_fence: null, proof: null }]);
        await poll(async () => {
          const [row] = (await db.storage.pool.query<{ expired: boolean }>(
            'SELECT lease_until<=clock_timestamp() AS expired FROM itervane.execution_slot WHERE task_id=$1 AND fence=$2',
            [current.id, interrupted.fence])).rows;
          return row?.expired ? true : undefined;
        }, 12_000, 'registry_worker_lease_expiry');
        phase = 'standard_registry_recovery';
        const resumed = await runScopedFixtureWorker(verificationBundle, socket, controllerUid, imageSha256, db.runtimeUrl,
          'verification', ['recover-registry-import', operationId, registry.origin]);
        equal(resumed.operationId, operationId);
        equal(resumed.observations, 1);
        ok(resumed.fence > interrupted.fence);
        deepStrictEqual(resumed.proof, pinnedImage);
        const settled = await readRegistryIntent();
        equal(settled.length, 1);
        equal(settled[0]?.state, 'confirmed');
        equal(settled[0]?.prepared_fence, interrupted.fence);
        equal(settled[0]?.settled_fence, resumed.fence);
        deepStrictEqual(releaseRegistryImageProofSchema.parse(settled[0]?.proof), pinnedImage);
        const [held] = (await db.storage.pool.query(
          'SELECT state,wakeup_job_id FROM itervane.release_operations WHERE id=$1', [operationId])).rows;
        deepStrictEqual(held, { state: 'dispatching', wakeup_job_id: null });
        await assertDrained(controllerUid, staging);

        phase = 'standard_komodo_known_update';
        const komodoRecovery = await proveKnownKomodoRecovery(komodoTrial(registry.origin, knownTarget, current.id, operationId, pinnedImage), resumed.fence);

        phase = 'standard_komodo_missing_update';
        const unknownTarget = await komodo.prepare();
        const other = environmentDtoSchema.parse(await request(`/v1/projects/${project.id}/environments`,
          { name: 'Unknown deployment sample', applicationId: application.id }));
        const otherMapping = await bind(other.id, unknownTarget);
        const cleanTask = taskDtoSchema.parse(await request(`/v1/tasks/${built.taskId}`));
        const cleanCandidate = formalReleaseCandidateDtoSchema.parse(await request(`/v1/tasks/${cleanTask.id}/release-candidate`,
          { environmentId: other.id, expectedVersion: cleanTask.version }));
        equal(cleanCandidate.manifest.target.mappingSha256, otherMapping.fingerprint);
        ok(passing.image?.status === 'scanned' && passing.image.archive);
        deepStrictEqual(cleanCandidate.manifest.image.archive, passing.image.archive);
        equal(cleanCandidate.manifest.image.manifestDigest, passing.image.manifestDigest);
        const otherApproval = (await request(`/v1/release-candidates/${cleanCandidate.id}/decisions`, {
          action: 'confirm', fingerprint: cleanCandidate.fingerprint, expectedVersion: 0, idempotencyKey: randomUUID(),
        }, true)) as { candidate: unknown };
        const otherConfirmed = formalReleaseCandidateDtoSchema.parse(otherApproval.candidate);
        equal(otherConfirmed.status, 'confirmed');
        const otherOperation = idSchema.parse(otherConfirmed.operationId);
        const cleanImage = cleanCandidate.manifest.image;
        const cleanProof = { registryOrigin: registry.origin, repository: 'testing/standard',
          reference: `${new URL(registry.origin).host}/testing/standard@${cleanImage.manifestDigest}`,
          archive: cleanImage.archive, manifestDigest: cleanImage.manifestDigest, configDigest: cleanImage.configDigest };
        const unknownKomodo = await proveUnknownKomodoDispatch(komodoTrial(registry.origin, unknownTarget, cleanTask.id, otherOperation, cleanProof),
          join(dirname(bundle), 'release-tools/materialize_oci.py'), komodoRecovery.updateId);
        await assertDrained(controllerUid, staging);
        retry = { before, after, retrySha256, generation, candidate, claim,
          archiveTransport: { ...transport, registry: resumed.proof, registryReadOnly: { initiallyAbsent: true, matchedAfterCleanup: true } },
          registryRecovery: { operationId, preparedFence: interrupted.fence, observedFence: resumed.fence,
            observations: resumed.observations, writeIntents: settled.length, killedBeforeCommit: true, stagingEmpty: interrupted.stagingEmpty },
          komodoRecovery, unknownKomodo,
          approval: { operationId, decisionVersion: confirmed.decisionVersion } };
      }
      return { sourceFingerprint: await sourceFingerprint(), postgres: postgres.version, imageSha256,
        built, healthRegression, drift, ...(retry ? { retry } : {}), stagedFilesRemaining: false };
    }

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
      [first.id, first.runId, scan.result.snapshotSha256, fixture.id], 'patch');
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

    type AuditFinding = NonNullable<FormalAuditResult['checklist']>['findings'][number];
    const runFixtureRepair = async (variant: 'template' | 'npm', purpose: string, selectFinding: (item: AuditFinding) => boolean) => {
      phase = `formal_repair_${variant}_audit`;
      await auditProvider?.close(); auditProvider = undefined;
      auditProvider = await auditProtocolFixture();
      worker = await startWorker(bundle, socket, controllerUid, imageSha256, db.runtimeUrl, auditProvider.baseURL);
      const task = await start(purpose, repairFixtureCommit);
      await reached(task.id, 'waiting_input');
      const audit = formalAuditDtoSchema.parse(await request(`/v1/tasks/${task.id}/audit`));
      if (audit.status !== 'recorded' || audit.result.status !== 'completed') throw new Error('repair_fixture_audit_missing');
      const finding = audit.result.checklist?.findings.find(selectFinding);
      ok(finding);
      await worker.stop('TERM'); worker = undefined;

      phase = `formal_repair_${variant}_execution`;
      const awaiting = taskDtoSchema.parse(await request(`/v1/tasks/${task.id}`));
      equal(taskDtoSchema.parse(await request(`/v1/tasks/${task.id}/resume`, { expectedVersion: awaiting.version })).state, 'queued');
      const outcome = await runRepairWorker(repairBundle, socket, controllerUid, imageSha256, db.runtimeUrl,
        [task.id, task.runId, audit.result.snapshotSha256, finding.id], variant);
      equal(outcome.receipt.scope.commit, repairFixtureCommit);
      equal(outcome.receipt.scope.baseSnapshotSha256, audit.result.snapshotSha256);
      notEqual(outcome.receipt.domainId, outcome.observation.domainId);
      await assertDrained(controllerUid, staging);
      return { ...outcome, audit, finding, task };
    };
    const template = await runFixtureRepair('template', 'Audit a synthetic dotenv entry', item => item.scanner === 'gitleaks'
      && item.path === 'fixtures/runner/repair-input/.env.example' && item.line === 2);
    const [templateTarget] = template.observation.snapshot.observation.targets;
    ok(templateTarget?.range);
    deepStrictEqual(templateTarget.templates, ['remove-env-entry-v1']);
    deepStrictEqual(templateTarget.range, { startByte: 51, endByte: 126, sha256: '0eb13cfa6f676343b680d004cf9f518bd82ae743c9f7baeff5b80e70a8cc071b' });
    const [templateChange] = template.receipt.snapshot.candidate.changes;
    deepStrictEqual(templateChange, { path: template.finding.path, beforeBytes: 141, afterBytes: 66, edits: 1,
      beforeSha256: '2a521af0e56199ba9686f52434e2097219b9c336a5037a2504c50914b1cfb809',
      afterSha256: '5fe8da009246c424d55a44cbf111e904ac1394e2f8042b7663d0146b05a3e0bc',
    });

    const npm = await runFixtureRepair('npm', 'Audit a fixed npm lock file', item => item.scanner === 'trivy'
      && item.path === npmFixturePaths.lock && item.ruleId === npmFixtureApproval.advisoryId);
    const { candidate: npmCandidate } = npm.receipt.snapshot;
    const npmFiles = npmFixtureFiles();
    deepStrictEqual(npmCandidate.changes, npmFiles.map(({ path, original, expected, edits }) => ({
      path, beforeBytes: Buffer.byteLength(original), beforeSha256: sha256(original),
      afterBytes: Buffer.byteLength(expected), afterSha256: sha256(expected), edits: edits.length,
    })));
    const npmUrl = `/v1/tasks/${npm.task.id}/repair`;
    const npmView = formalRepairDtoSchema.parse(await request(npmUrl));
    if (npmView.status !== 'recorded' || npmView.result.status !== 'candidate_ready') throw new Error('native_npm_candidate_missing');
    equal(npmView.sha256, npm.agent.resultSha256);
    deepStrictEqual(npmView.result.candidate.changes, npmCandidate.changes);
    const npmMcp = formalRepairDtoSchema.parse((await client.callTool({ name: 'get_repair', arguments: { taskId: npm.task.id } })).structuredContent);
    if (npmMcp.status !== 'recorded') throw new Error('native_npm_candidate_missing');
    equal(npmMcp.sha256, npmView.sha256);
    deepStrictEqual(npmMcp.result, npmView.result);
    equal(npmMcp.locale, 'zh-CN'); equal(npmView.locale, 'en'); notEqual(npmMcp.message, npmView.message);
    const npmExport = formalRepairPatchDtoSchema.parse(await request(`${npmUrl}/patch?expectedSha256=${npmView.sha256}`));
    equal(npmExport.patchSha256, npmCandidate.patchSha256);
    deepStrictEqual(npmExport.patch.files, npmFiles.map(({ path, original, edits }) => ({ path, beforeSha256: sha256(original), edits })));
    equal((await db.admin.query('SELECT task_id FROM itervane.execution_slot WHERE id=1')).rows[0]?.task_id, null);

    const rescanRepair = async (fixture: typeof npm) => {
      const result = await rescanFixture(fixture.task, fixture.finding.id);
      const { receipt: published, observation: observed } = fixture;
      equal(result.baseSnapshotSha256, published.scope.baseSnapshotSha256);
      equal(result.targetManifestSha256, published.snapshot.candidate.candidateManifestSha256);
      equal(result.patchSha256, published.snapshot.candidate.patchSha256);
      equal(result.targetRuleId, fixture.finding.ruleId);
      sha256Schema.parse(result.targetReportsSha256);
      notEqual(result.domainId, published.domainId); notEqual(result.domainId, observed.domainId);
      return result;
    };
    phase = 'verification_template';
    const templateRescan = await rescanRepair(template);
    phase = 'verification_npm';
    const npmRescan = await rescanRepair(npm);

    phase = 'verification_original_audit';
    ok(auditProvider);
    worker = await startWorker(bundle, socket, controllerUid, imageSha256, db.runtimeUrl, auditProvider.baseURL);
    const originalTask = await start('Audit a clean original lock file', cleanVerificationCommit);
    await reached(originalTask.id, 'waiting_input');
    const originalAudit = formalAuditDtoSchema.parse(await request(`/v1/tasks/${originalTask.id}/audit`));
    if (originalAudit.status !== 'recorded' || originalAudit.result.status !== 'completed') throw new Error('verification_fixture_audit_missing');
    equal(originalAudit.result.checklist?.findings.length, 0);
    await worker.stop('TERM'); worker = undefined;
    phase = 'verification_original_rescan';
    const originalRescan = await rescanFixture(originalTask, null);
    equal(originalRescan.baseSnapshotSha256, originalAudit.result.snapshotSha256);
    equal(originalRescan.targetManifestSha256, originalRescan.baseSnapshotSha256);
    equal(originalRescan.patchSha256, null); equal(originalRescan.targetReportsSha256, null);
    equal(originalRescan.targetRuleId, null); equal(originalRescan.remainingFindingGroups, 0);

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
      templateRepair: { commit: repairFixtureCommit, auditSha256: template.audit.sha256, trace: template.agent.trace,
        resultSha256: template.agent.resultSha256, domainId: template.receipt.domainId, observationDomainId: template.observation.domainId,
        range: templateTarget.range, change: templateChange, cleanupConfirmed: true,
      },
      npmRepair: { commit: repairFixtureCommit, auditSha256: npm.audit.sha256, findingId: npm.finding.id, trace: npm.agent.trace,
        resultSha256: npmView.sha256, patchSha256: npmExport.patchSha256, changes: npmCandidate.changes,
        domainId: npm.receipt.domainId, observationDomainId: npm.observation.domainId, cleanupConfirmed: true,
        httpMcpAgreement: true, slotReleased: true,
      },
      verification: { template: templateRescan, npm: npmRescan, original: originalRescan },
    };
  } finally {
    try {
      try { await worker?.stop('TERM'); }
      finally { await closeReleaseFixtures(); }
    }
    finally {
      await auditProvider?.close(); await client.close(); await api?.close(); await identity?.close(); await database?.close(); await postgres.close();
    }
  }
}

try { console.log(JSON.stringify(await probe())); }
catch (error) {
  const message = error instanceof Error && (taskEventReasonSchema.safeParse(error.message).success
    || /^(?:[a-z_]+_timeout|fixture_(?:diagnosis_)?http_[1-5][0-9]{2}|verification_fixture_phase_[a-z_]{1,56}|(?:protected_ingress|release_(?:rollout|registry|komodo))_[a-z_]{1,48})$/.test(error.message))
    ? ` (${error.message})` : '';
  console.error(`Native Worker inspection failed during ${phase}${message}.`);
  process.exitCode = 1;
}
