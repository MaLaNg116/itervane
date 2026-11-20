import { deepStrictEqual, equal, ok } from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { idSchema, sha256Schema, type RepairPatch } from '@itervane/contracts';
import { QualifiedInspectionClient, sha256 } from '@itervane/runner';
import { workerConfig } from '../../src/config.js';
import { openDatabase, queueName } from '../../src/persistence/database.js';
import { ExecutionCoordinator } from '../../src/runtime/coordinator.js';
import { FormalRepairExecution } from '../../src/runtime/repair-execution.js';

const fixturePath = 'fixtures/runner/inspection-input/original/config.txt';
const originalSha256 = '3812bc54c3579d8c67275c573f0ff1bf7dde70bfb4a9150621459ae510a87afc';
const updated = '# Use managed credentials at runtime.\n';

async function repair() {
  const [taskId, runId, snapshot, finding, ...extra] = process.argv.slice(2);
  const config = workerConfig();
  if (process.platform !== 'linux' || !process.getuid?.() || !config.runner || extra.length
      || !/^\/itervane_test_[a-f0-9]{12}$/.test(new URL(config.databaseUrl).pathname)) throw new Error('repair_fixture_config');
  const target = { taskId: idSchema.parse(taskId), runId: idSchema.parse(runId) };
  const baseSnapshotSha256 = sha256Schema.parse(snapshot);
  const findingId = sha256Schema.parse(finding);
  const database = await openDatabase(config.databaseUrl);
  try {
    const workerId = randomUUID();
    const coordinator = new ExecutionCoordinator(database, { leaseSeconds: config.leaseSeconds });
    await coordinator.reconcile(workerId);
    const [job] = await database.boss.fetch(queueName);
    ok(job);
    const scope = await coordinator.claim(job, workerId);
    ok(scope);
    equal(scope.taskId, target.taskId); equal(scope.runId, target.runId);
    const execution = new FormalRepairExecution(coordinator, {
      runner: new QualifiedInspectionClient(config.runner), protectedPaths: ['fixtures/runner/inspection-input/updated'],
    });
    const patch: RepairPatch = { version: 1, baseSnapshotSha256, files: [{ path: fixturePath, beforeSha256: originalSha256,
      edits: [{ startByte: 0, endByte: 158, replacement: updated }] }] };
    const proposal = { callKeySha256: sha256('native repair sample'), findingIds: [findingId], patch };
    const controller = new AbortController();
    let heartbeat: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (heartbeat || controller.signal.aborted) return;
      heartbeat = coordinator.heartbeat(scope).then(live => { if (!live) controller.abort(); }, () => controller.abort())
        .finally(() => { heartbeat = undefined; });
    }, config.leaseSeconds * 1_000 / 3);
    try {
      const receipt = await execution.apply(scope, proposal, controller.signal);
      if (receipt.kind !== 'repair_receipt') throw new Error('repair_fixture_no_receipt');
      deepStrictEqual(await execution.apply(scope, proposal, controller.signal), receipt);
      return receipt;
    } finally { clearInterval(timer); await heartbeat; }
  } finally { await database.close(); }
}

try { console.log(JSON.stringify(await repair())); }
catch { console.error('Native repair execution did not produce a scoped receipt.'); process.exitCode = 1; }
