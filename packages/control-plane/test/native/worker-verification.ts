import { deepStrictEqual, equal, ok } from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { formalVerificationInputSchema, idSchema, qualifiedInspectionResponseSchema, sha256Schema } from '@itervane/contracts';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { canonicalVerificationCommand, compareVerificationScans, prepareQualifiedVerificationRequest, QualifiedInspectionClient,
  scannerProfiles, sha256 } from '@itervane/runner';
import { eq } from 'drizzle-orm';
import { workerConfig } from '../../src/config.js';
import { openDatabase, queueName } from '../../src/persistence/database.js';
import { formalRescanAttempts, formalVerificationInputs } from '../../src/persistence/schema.js';
import { clearSlot } from '../../src/runtime/authority.js';
import { ExecutionCoordinator } from '../../src/runtime/coordinator.js';
import { runFormalRescan, type RescanRunner } from '../../src/runtime/formal-rescan.js';
import { runFormalVerification } from '../../src/runtime/formal-verification.js';
import { prepareFormalVerificationInput } from '../../src/runtime/verification-input.js';
import { currentInspectionAttempt } from '../../src/service/inspection-evidence.js';
import { scriptedVerification } from '../../../verification/src/agent/verification-fixture.js';
import { runKomodoReleaseFixture } from './komodo-release-worker.js';
import { repairNativeHealthFixture } from './health-repair.js';
import { readApprovedArchive } from './release-archive.js';
import { interruptibleRegistryImport, recoverInterruptedRegistry } from './release-recovery.js';

let phase = 'config';

function fixtureConfig() {
  const config = workerConfig();
  if (process.platform !== 'linux' || !process.getuid?.() || !config.runner
      || !/^\/itervane_test_[a-f0-9]{12}$/.test(new URL(config.databaseUrl).pathname)) throw new Error('verification_fixture_config');
  return { ...config, runner: config.runner };
}

async function verify() {
  const [taskId, runId, expected, ...buildArgs] = process.argv.slice(2);
  const config = fixtureConfig();
  const target = { taskId: idSchema.parse(taskId), runId: idSchema.parse(runId) };
  const findingId = expected === 'original' ? null : sha256Schema.parse(expected);
  const [profileSha, baselineSha, expectedBuild, expectedBaseline, optionalProbe] = buildArgs;
  const previousReceiptSha256 = optionalProbe?.startsWith('followup-repaired:')
    ? sha256Schema.parse(optionalProbe.slice('followup-repaired:'.length)) : undefined;
  const followupTrial = optionalProbe === 'followup-passed' || previousReceiptSha256 ? 'passed'
    : optionalProbe === 'followup-unhealthy' ? 'unhealthy' : undefined;
  const ociInputsSha = followupTrial ? undefined : optionalProbe;
  if (buildArgs.length !== 0 && (buildArgs.length < 3 || buildArgs.length > 5 || findingId !== null
      || (expectedBuild !== 'built' && expectedBuild !== 'profile_mismatch' && expectedBuild !== 'offline_install')
      || (expectedBaseline !== undefined && (expectedBuild !== 'built' || (expectedBaseline !== 'passed' && expectedBaseline !== 'failed'))))) {
    throw new Error('verification_fixture_build_config');
  }
  const buildProfile = buildArgs.length ? {
    buildProfileSha256: sha256Schema.parse(profileSha), baselineSha256: sha256Schema.parse(baselineSha),
    ...(expectedBaseline ? { runStandardBaseline: true as const } : {}),
    ...(ociInputsSha ? { ociInputsSha256: sha256Schema.parse(ociInputsSha), retainStandardImage: true as const } : {}),
  } : undefined;
  phase = 'claim';
  const database = await openDatabase(config.databaseUrl);
  let heartbeat: NodeJS.Timeout | undefined;
  try {
    const workerId = randomUUID();
    const coordinator = new ExecutionCoordinator(database, { leaseSeconds: config.leaseSeconds });
    await coordinator.reconcile(workerId);
    const [job] = await database.boss.fetch(queueName);
    ok(job);
    const scope = await coordinator.claim(job, workerId);
    ok(scope);
    equal(scope.taskId, target.taskId);
    equal(scope.runId, target.runId);

    const abort = new AbortController();
    heartbeat = setInterval(() => {
      void coordinator.heartbeat(scope).then(live => { if (!live) abort.abort(); }, () => abort.abort());
    }, Math.floor(config.leaseSeconds * 1_000 / 3));
    phase = 'profile';
    const original = await coordinator.withLease(scope, async tx => {
      const attempt = await currentInspectionAttempt(tx, scope.runId);
      equal(attempt?.state, 'recorded');
      const receipt = qualifiedInspectionResponseSchema.parse(attempt?.receipt);
      if (receipt.kind !== 'receipt') throw new Error('verification_fixture_inspection');
      return receipt;
    });
    const profile = { id: 'isolated-rescan-fixture', baselineSha256: sha256('reserved for protected baseline'),
      policySha256: sha256(JSON.stringify(scannerProfiles)), scannerInputsSha256: original.snapshot.inputsSha256,
      runnerImageSha256: config.runner.imageSha256,
      ...buildProfile,
    };
    const runner = new QualifiedInspectionClient(config.runner);
    if (followupTrial) {
      phase = 'health_followup_preflight';
      equal(expectedBaseline, 'passed');
      const prepared = await coordinator.withLease(scope, (tx, { task }) => prepareFormalVerificationInput(tx, task, scope, profile));
      let pulses = 0;
      const authorize = async () => {
        await coordinator.withLease(scope, async () => undefined);
        pulses++;
      };
      phase = 'health_followup_repair_fixture';
      const fixed = previousReceiptSha256 ? await repairNativeHealthFixture(runner, original, prepared.document,
        { origin: prepared.origin, fence: scope.fence, authorize, signal: abort.signal }, previousReceiptSha256) : undefined;
      const command = canonicalVerificationCommand({ input: { ...prepared.document, ...(fixed ? { subject: fixed.subject } : {}), healthRegression: {
        proposalId: randomUUID(), diagnosisSha256: sha256('test diagnosis'), publicationProofSha256: sha256('test publication'),
        incidentId: randomUUID(), sampleSequence: 1, sampleEvidenceSha256: sha256('test protected response'),
      } }, repair: fixed?.repair ?? null });
      const status = await runner.observe(abort.signal);
      equal(status?.state, 'idle');
      const request = prepareQualifiedVerificationRequest({ requestId: randomUUID(), fence: scope.fence,
        workspaceSha256: status!.workspaceSha256, origin: prepared.origin }, command);
      phase = 'health_followup_dispatch';
      const response = await runner.verify(request, command.input, command.repair, authorize, abort.signal);
      if (response.kind !== 'verification_receipt') {
        phase = `health_followup_${response.code}`;
        throw new Error('verification_fixture_health_followup');
      }
      phase = 'health_followup_observed';
      const { snapshot } = response;
      equal(response.cleanupConfirmed, true);
      equal(response.scope.healthFollowup, true);
      equal(response.commitSha256, original.commitSha256);
      equal(snapshot.tree, original.snapshot.tree);
      equal(snapshot.manifestSha256, original.snapshot.manifestSha256);
      const comparison = compareVerificationScans(snapshot, snapshot.target ?? snapshot);
      ok(comparison.status === 'compared');
      deepStrictEqual(comparison.totals, { introduced: 0, resolved: 0, remaining: 0 });
      ok(pulses >= 2 && response.domainId !== original.domainId);
      if (fixed) {
        ok(snapshot.target && snapshot.target.patchSha256 === fixed.subject.patchSha256);
        equal(snapshot.target.manifestSha256, fixed.subject.manifestSha256);
        equal(new Set([original.domainId, response.domainId, fixed.proof.observationDomainId, fixed.proof.repairDomainId]).size, 4);
      }
      ok(snapshot.build?.status === 'built' && snapshot.build.baseline?.status === 'passed');
      const baseline = snapshot.build.baseline;
      equal(baseline.appExited, true);
      deepStrictEqual(baseline.checks[0], { id: 'health', status: 'passed', code: null, statusCode: 200 });
      deepStrictEqual(baseline.healthFollowup, followupTrial === 'passed' ? { status: 'passed', code: null, statusCode: 200 }
        : { status: 'unhealthy', code: 'application_unhealthy', statusCode: 503 });
      clearInterval(heartbeat);
      await coordinator.withLease(scope, tx => clearSlot(tx));
      return { domainId: response.domainId, commit: response.scope.commit, inputSha256: response.scope.verificationInputSha256,
        receiptSha256: sha256(JSON.stringify(response)), commandSha256: response.scope.commandSha256,
        baseSnapshotSha256: snapshot.manifestSha256, targetManifestSha256: response.scope.targetManifestSha256,
        patchSha256: snapshot.target?.patchSha256 ?? null,
        originalReportsSha256: sha256(JSON.stringify(snapshot.reports)), targetReportsSha256: snapshot.target ? sha256(JSON.stringify(snapshot.target.reports)) : null,
        dispatches: 1, newFindingGroups: 0, cleanupConfirmed: true, build: snapshot.build, pulses, ...(fixed ? { repair: fixed.proof } : {}) };
    }
    let dispatches = 0;
    const observedRunner: RescanRunner = {
      observe: signal => runner.observe(signal),
      verify(...args) { dispatches += 1; return runner.verify(...args); },
    };
    const rescan = () => runFormalRescan(coordinator, scope, profile, observedRunner, abort.signal);

    phase = 'scan';
    const result = await rescan();
    if (result.kind === 'rejected') {
      phase = `scan_${result.code}`;
      throw new Error('verification_fixture_scan');
    }
    const { receipt, comparison, evidence: projected } = result;
    const { snapshot } = receipt;
    phase = 'evidence';
    equal(receipt.scope.runId, scope.runId);
    equal(receipt.scope.fence, scope.fence);
    equal(receipt.scope.baseSnapshotSha256, original.snapshot.manifestSha256);
    equal(receipt.scope.commit, original.scope.commit);
    equal(receipt.cleanupConfirmed, true);
    equal(projected.binding.taskId, scope.taskId);
    equal(projected.binding.receiptSha256, sha256(JSON.stringify(receipt)));
    equal(projected.binding.subjectManifestSha256, receipt.scope.targetManifestSha256);
    ok(receipt.domainId !== original.domainId);
    ok(comparison.status === 'compared');
    const findingKey = (group: typeof comparison.groups[number]) =>
      JSON.stringify([group.scanner, group.path, group.ruleId, group.dependency?.name ?? null]);
    const before = new Set(comparison.groups.filter(group => group.beforeIds.length).map(findingKey));
    const after = new Set(comparison.groups.filter(group => group.afterIds.length).map(findingKey));
    const newFindingGroups = [...after].filter(key => !before.has(key)).length;
    equal(newFindingGroups, 0);
    const targetFinding = findingId && comparison.groups.find(group => group.beforeIds.includes(findingId));
    if (findingId) {
      ok(snapshot.target);
      // An advisory on the replacement version still applies to the same target.
      ok(targetFinding);
      equal(after.has(findingKey(targetFinding)), false);
    } else {
      equal(snapshot.target, null);
      deepStrictEqual(comparison.totals, { introduced: 0, resolved: 0, remaining: 0 });
    }
    if (buildProfile) {
      const evidence = snapshot.build;
      ok(evidence);
      const observed = evidence.status === 'built' ? 'built' : evidence.code;
      phase = `build_${observed}`;
      equal(observed, expectedBuild);
      equal(evidence.buildProfileSha256, buildProfile.buildProfileSha256);
      if (evidence.status === 'built') {
        equal(evidence.isolationVerified, true);
        const baselineEvidence = evidence.baseline;
        if (baselineEvidence) {
          const status = baselineEvidence.status === 'blocked' ? baselineEvidence.code : baselineEvidence.status;
          phase = `baseline_${status}`;
          equal(status, expectedBaseline);
          equal(projected.baseline.status, baselineEvidence.status);
          if (ociInputsSha && baselineEvidence.status === 'passed') {
            const image = baselineEvidence.image;
            phase = image?.status === 'blocked' ? image.code : 'image_evidence';
            ok(image?.status === 'scanned');
            equal(image.scan.imageDigest, image.manifestDigest);
            equal(image.ociInputsSha256, ociInputsSha);
            deepStrictEqual(image.scan.database, snapshot.reports[1].database);
            ok(image.archive && image.archive.bytes > 0);
            ok(projected.image.status === 'scanned');
            equal(projected.image.manifestDigest, image.manifestDigest);
            deepStrictEqual(projected.image.archive, image.archive);
            equal(Object.values(projected.image.findings).reduce((sum, count) => sum + count, 0), image.scan.findings.length);
          } else if (ociInputsSha) {
            equal(projected.image.status, 'not_reached');
          }
        } else equal(expectedBaseline, undefined);
      }
    } else equal(snapshot.build, undefined);

    phase = 'replay';
    deepStrictEqual(await rescan(), result);
    equal(dispatches, 1);
    const [stored, ...duplicates] = await database.db.select().from(formalRescanAttempts).where(eq(formalRescanAttempts.runId, scope.runId));
    equal(duplicates.length, 0);
    ok(stored?.state === 'recorded');
    equal(stored.fence, scope.fence);
    equal(stored.inputSha256, receipt.scope.verificationInputSha256);
    equal(stored.receiptSha256, sha256(JSON.stringify(receipt)));

    let reviewTrial;
    if (ociInputsSha) {
      phase = 'review_agent';
      const [frozen] = await database.db.select().from(formalVerificationInputs).where(eq(formalVerificationInputs.runId, scope.runId));
      ok(frozen);
      const document = formalVerificationInputSchema.parse(frozen.document);
      const saver = PostgresSaver.fromConnString(config.databaseUrl, { schema: 'itervane_checkpoint' });
      try {
        const model = { adapter: scriptedVerification(document.locale), providerSha256: sha256('scripted verification trial') };
        const reviewed = await runFormalVerification(coordinator, scope, saver, model, { profile, runner: observedRunner }, abort.signal);
        ok(reviewed.kind === 'reviewed');
        const report = reviewed.report;
        equal(report.status, 'completed');
        equal(report.releaseEligible, false);
        equal(report.formalVerification?.receiptSha256, stored.receiptSha256);
        equal(report.formalVerification?.outcome, expectedBaseline === 'passed' ? 'observed' : 'checks_failed');
        const sections = report.evidence.flatMap(item => item.data.kind === 'verification_section' ? [item.data.section] : []);
        deepStrictEqual(sections, expectedBaseline === 'passed' ? ['baseline', 'image', 'source', 'build'] : ['baseline', 'source', 'build']);
        deepStrictEqual(await runFormalVerification(coordinator, scope, saver, model, { profile, runner: observedRunner }, abort.signal), reviewed);
        equal(dispatches, 1);
        reviewTrial = { input: { sha256: frozen.sha256, document }, evidence: projected,
          report: { sections, usage: report.usage, checkpointId: report.checkpointId!, outcome: report.formalVerification.outcome } };
      } finally { await saver.end(); }
    }

    // The fixture leaves the slot only after the authenticated cleanup receipt.
    clearInterval(heartbeat);
    await coordinator.withLease(scope, tx => clearSlot(tx));
    return {
      domainId: receipt.domainId, commit: receipt.scope.commit, inputSha256: stored.inputSha256, receiptSha256: stored.receiptSha256,
      commandSha256: receipt.scope.commandSha256, baseSnapshotSha256: snapshot.manifestSha256,
      targetManifestSha256: receipt.scope.targetManifestSha256, patchSha256: snapshot.target?.patchSha256 ?? null,
      originalReportsSha256: sha256(JSON.stringify(snapshot.reports)),
      targetReportsSha256: snapshot.target && sha256(JSON.stringify(snapshot.target.reports)),
      totals: comparison.totals, targetRuleId: targetFinding ? targetFinding.ruleId : null,
      newFindingGroups, remainingFindingGroups: after.size, dispatches, cleanupConfirmed: true, build: snapshot.build ?? null,
      evidence: projected,
      ...(reviewTrial ? { reviewTrial } : {}),
    };
  } finally {
    clearInterval(heartbeat);
    await database.close();
  }
}

try {
  const [action, operationId, origin, materializer, ...extra] = process.argv.slice(2);
  if (action === 'read-approved-archive') {
    phase = 'archive_registry_transfer';
    equal(extra.length, 0);
    ok(origin && !materializer);
    const { databaseUrl, runner } = fixtureConfig();
    console.log(JSON.stringify(await readApprovedArchive(databaseUrl, runner, operationId, origin)));
  } else if (action === 'interrupt-registry-import') {
    phase = 'registry_import_before_kill';
    ok(origin && materializer);
    equal(extra.length, 0);
    const { databaseUrl, runner } = fixtureConfig();
    await interruptibleRegistryImport(databaseUrl, runner, operationId, origin, materializer);
  } else if (action === 'recover-registry-import') {
    phase = 'registry_recovery_readback';
    ok(origin && !materializer);
    equal(extra.length, 0);
    const { databaseUrl } = fixtureConfig();
    console.log(JSON.stringify(await recoverInterruptedRegistry(databaseUrl, operationId, origin)));
  } else if (action === 'komodo-release-step') {
    phase = 'komodo_release_step';
    ok(origin && materializer);
    equal(extra.length, 1);
    const { databaseUrl, runner } = fixtureConfig();
    console.log(JSON.stringify(await runKomodoReleaseFixture(databaseUrl, runner, operationId, origin, materializer, extra[0])));
  } else console.log(JSON.stringify(await verify()));
}
catch { console.error(`verification_fixture_phase_${phase}`); process.exitCode = 1; }
