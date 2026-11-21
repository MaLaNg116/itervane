import { deepStrictEqual, equal, match, notEqual, ok } from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  admissionDtoSchema, applicationDtoSchema, auditFindingsPerScan, environmentDtoSchema, formalAuditDtoSchema, formalReleaseCandidateDtoSchema,
  formalRepairDtoSchema, formalRepairPatchDtoSchema, idSchema, projectDtoSchema,
  formalRepairRetrySchema, formalVerificationInputSchema, formalVerificationResultSchema, qualifiedVerificationResponseSchema, standardVerificationProfileSchema,
  repositoryDtoSchema, sha256Schema, sourceInspectionDtoSchema,
  qualifiedRepairObservationResponseSchema, qualifiedRepairResponseSchema, qualifiedStandardBuildProofSchema,
  taskDtoSchema, taskEventDtoSchema, translate, type FormalAuditResult, type StandardVerificationProfile,
} from '@itervane/contracts';
import { scannerProfiles, sha256 } from '@itervane/runner';
import { createApi } from '../../src/api.js';
import { formalReleaseQueue } from '../../src/persistence/database.js';
import { ExecutionCoordinator } from '../../src/runtime/coordinator.js';
import { verificationProfileFingerprint } from '../../src/service/repair-retry.js';
import { registerReleaseTarget } from '../../src/service/release-targets.js';
import { bootstrapOwner } from '../../src/service/resources.js';
import { databaseFixture } from '../helpers/database.js';
import { identityFixture } from '../helpers/identity.js';
import { npmFixtureApproval, npmFixtureFiles, npmFixturePaths } from '../../../verification/src/agent/npm-repair-fixture.js';
import { temporaryPostgres } from '../../../verification/src/postgres-fixture.js';
import { sourceFingerprint } from '../../../verification/src/report.js';
import { auditFixtureKey, auditFixtureModel, auditProtocolFixture } from './audit-provider.js';
import { temporaryRegistry } from './registry-fixture.js';

const execute = promisify(execFile);
const commit = '9167604c888416d7b6518e1c76485d7308cffb5c';
const repairFixtureCommit = 'f41a940ffe4ec24221b873e1cd74b8ec2125873e';
const cleanVerificationCommit = '49799e18f4f63cf22767a9cd8054cab979b9b6d2';
const standardBuildCommit = '3a719ca44f306d30cdf2d27e9a6d3b954ed656f0';
const standardLockDriftCommit = '03e5d18a27d23960f040c0d5d70afefac15ec46e';
const standardHealthRegressionCommit = '1eac5c8776c6e81613cfb5adf6edd2cd6b163ba3';
const repairRetryCommit = '39e9b7f34fdd01ec55fe4dda5358ffce5d68cbf8';
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

async function startWorker(bundle: string, socket: string, controllerUid: string, image: string, databaseUrl: string,
  auditURL?: string, verification?: StandardVerificationProfile, repair = false) {
  const child = spawn('/usr/bin/sudo', ['-n', '-u', workerAccount, '--', '/usr/bin/env', '-i', ...sourceWorkerEnvironment(socket, controllerUid, image),
    ...(auditURL ? ['ITERVANE_AUDIT_MODEL_PROVIDER=anthropic', `ANTHROPIC_BASE_URL=${auditURL}`,
      `ANTHROPIC_MODEL=${auditFixtureModel}`, `ANTHROPIC_API_KEY=${auditFixtureKey}`] : []),
    ...(verification ? [`ITERVANE_VERIFICATION_PROFILE=${JSON.stringify(verification)}`] : []),
    ...(repair ? ['ITERVANE_FORMAL_REPAIR=1'] : []),
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

async function runScopedFixtureWorker(bundle: string, socket: string, controllerUid: string, image: string,
  databaseUrl: string, probe: 'repair' | 'verification', args: string[]) {
  const child = spawn('/usr/bin/sudo', ['-n', '-u', workerAccount, '--', '/usr/bin/env', '-i', ...sourceWorkerEnvironment(socket, controllerUid, image),
    '/usr/bin/setpriv', '--no-new-privs', '/bin/bash', '-c', 'set -eu; IFS= read -r DATABASE_URL; export DATABASE_URL; exec "$@"',
    'itervane-fixture-worker', process.execPath, bundle, ...args,
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exit = exitStatus(child);
  let diagnostic = '';
  child.stderr.on('data', (chunk: Buffer) => {
    if (probe === 'verification' && diagnostic.length < 256) diagnostic += chunk.subarray(0, 256).toString('utf8');
  });
  child.stdin.on('error', () => undefined);
  child.stdin.end(databaseUrl + '\n');
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
  const ociRun = buildMode === 'standard-oci';
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
  const client = new Client({ name: 'itervane-native-worker', version: '0.0.0' });
  try {
    const db = database = await databaseFixture(postgres.url);
    const oidc = identity = await identityFixture();
    await bootstrapOwner(db.storage, { issuer: oidc.config.issuer, subject: 'owner' });
    const portalClientId = 'itervane-native-portal';
    api = createApi(db.storage, { ...oidc.config, publicUrl, portalClientId }, { logger: false });
    const address = await api.listen({ host: '127.0.0.1', port: 0 });
    const authorization = async () => `Bearer ${await oidc.token()}`;
    const request = async (path: string, payload?: object, human = false) => {
      const response = await fetch(`${address}${path}`, { method: payload ? 'POST' : 'GET', signal: AbortSignal.timeout(5_000),
        headers: { Authorization: human ? `Bearer ${await oidc.token('owner', { azp: portalClientId })}` : await authorization(),
          ...(payload ? { 'content-type': 'application/json' } : {}) },
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

    if (build) {
      const audit = auditProvider = await auditProtocolFixture({ repairRetry: ociRun });
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
        return { ...fact, build: evidence };
      };
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
        phase = 'standard_repair_retry_run';
        worker = await startWorker(bundle, socket, controllerUid, imageSha256, db.runtimeUrl, audit.baseURL, automaticProfile, true);
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
        phase = 'standard_formal_release_candidate';
        const application = applicationDtoSchema.parse(await request(`/v1/projects/${project.id}/applications`, { name: 'Standard release fixture' }));
        const environment = environmentDtoSchema.parse(await request(`/v1/projects/${project.id}/environments`, { name: 'Protected sample', applicationId: application.id }));
        const registry = releaseRegistry = await temporaryRegistry();
        const target = await registerReleaseTarget(db.storage, {
          environmentId: environment.id, deploymentId: 'a'.repeat(24), serverId: 'b'.repeat(24), imageRepository: 'testing/standard',
          registryOrigin: registry.origin,
          verificationProfileSha256: verificationProfileFingerprint(automaticProfile), runtimeConfigSha256: sha256('native candidate fixture'),
          rolloutCheckSha256: sha256('native rollout fixture'), recoveryPlanSha256: sha256('native previous release fixture'),
        });
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
        await new ExecutionCoordinator(db.storage).reconcile(randomUUID());
        const [genericWakeup] = (await db.admin.query('SELECT wakeup_job_id FROM itervane.task_runs WHERE id=$1', [current.runId])).rows;
        equal(genericWakeup?.wakeup_job_id, null);
        phase = 'standard_formal_release_archive_transport';
        const transferred = await runScopedFixtureWorker(verificationBundle, socket, controllerUid, imageSha256, db.runtimeUrl,
          'verification', ['read-approved-archive', operationId, registry.origin, join(dirname(bundle), 'release-tools/materialize_oci.py')]);
        const { registry: imported, ...transport } = transferred;
        const { archive, manifestDigest, configDigest } = candidate.manifest.image;
        deepStrictEqual(transport, { operationId, fingerprint: candidate.fingerprint, archiveSha256: archive.sha256,
          bytes: archive.bytes, wrongRunnerDenied: true, wrongSizeDenied: true, revokedDenied: true, stagedFilesRemaining: false });
        deepStrictEqual(imported, { registryOrigin: registry.origin, repository: 'testing/standard',
          reference: `${new URL(registry.origin).host}/testing/standard@${manifestDigest}`, archive, manifestDigest, configDigest });
        await assertDrained(controllerUid, staging);
        retry = { before, after, retrySha256, generation: handoff.generation, candidate, archiveTransport: transferred,
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
    try { await Promise.all([worker?.stop('TERM'), releaseRegistry?.close()]); }
    finally {
      await auditProvider?.close(); await client.close(); await api?.close(); await identity?.close(); await database?.close(); await postgres.close();
    }
  }
}

try { console.log(JSON.stringify(await probe())); }
catch (error) {
  const message = error instanceof Error && /^(?:[a-z_]+_timeout|verification_fixture_phase_[a-z_]{1,56})$/.test(error.message)
    ? ` (${error.message})` : '';
  console.error(`Native Worker inspection failed during ${phase}${message}.`);
  process.exitCode = 1;
}
