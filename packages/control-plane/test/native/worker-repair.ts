import { deepStrictEqual, equal, ok } from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AgentEvidence } from '@itervane/agent';
import { idSchema, sha256Schema, type QualifiedRepairObservationReceipt, type QualifiedRepairReceipt, type RepairPatch } from '@itervane/contracts';
import type { ModelAdapter } from '@itervane/model';
import { QualifiedInspectionClient, sha256 } from '@itervane/runner';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { workerConfig } from '../../src/config.js';
import { openDatabase, queueName } from '../../src/persistence/database.js';
import { ExecutionCoordinator } from '../../src/runtime/coordinator.js';
import { runFormalRepair, type FormalRepairOptions } from '../../src/runtime/formal-repair.js';
import { FormalRepairExecution } from '../../src/runtime/repair-execution.js';

const fixturePath = 'fixtures/runner/inspection-input/original/config.txt';
const originalSha256 = '3812bc54c3579d8c67275c573f0ff1bf7dde70bfb4a9150621459ae510a87afc';
const updated = '# Use managed credentials at runtime.\n';

function repairModel(findingId: string) {
  const decide = (name: string, input: unknown) => ({ text: '', calls: [{ id: 'repair-fixture', name, input }], tokenUsage: 30 });
  const complete: ModelAdapter['complete'] = async ({ conversation }) => {
    const context = conversation[0];
    if (context?.kind !== 'user') throw new Error('repair_fixture_context');
    const { observations } = JSON.parse(context.text) as { observations: AgentEvidence[] };
    const applied = observations.find(item => item.data.kind === 'repair_candidate');
    if (applied) return decide('finish_role', { summary: '已按观察到的区间替换疑似凭据行。', evidenceId: applied.id });
    const evidence = observations.find(item => item.data.kind === 'repair_targets');
    if (!evidence || evidence.data.kind !== 'repair_targets') return decide('read_repair_targets', { findingIds: [findingId] });
    const target = evidence.data.observation.targets[0];
    if (!target?.range || target.findingId !== findingId || target.file?.sha256 !== originalSha256) throw new Error('repair_fixture_target');
    return decide('apply_repair_patch', { observationId: evidence.id, targets: [{ targetIndex: 0,
      edits: [{ startByte: target.range.startByte, endByte: target.range.endByte, replacement: updated }],
    }] });
  };
  return { adapter: { protocol: 'anthropic' as const, complete }, providerSha256: sha256('native repair fixture v1') };
}

async function repair() {
  const [taskId, runId, snapshot, finding, ...extra] = process.argv.slice(2);
  const config = workerConfig();
  if (process.platform !== 'linux' || !process.getuid?.() || !config.runner || extra.length
      || !/^\/itervane_test_[a-f0-9]{12}$/.test(new URL(config.databaseUrl).pathname)) throw new Error('repair_fixture_config');
  const target = { taskId: idSchema.parse(taskId), runId: idSchema.parse(runId) };
  const baseSnapshotSha256 = sha256Schema.parse(snapshot);
  const findingId = sha256Schema.parse(finding);
  const database = await openDatabase(config.databaseUrl);
  const saver = PostgresSaver.fromConnString(config.databaseUrl, { schema: 'itervane_checkpoint' });
  try {
    const workerId = randomUUID();
    const coordinator = new ExecutionCoordinator(database, { leaseSeconds: config.leaseSeconds });
    await coordinator.reconcile(workerId);
    const [job] = await database.boss.fetch(queueName);
    ok(job);
    const scope = await coordinator.claim(job, workerId);
    ok(scope);
    equal(scope.taskId, target.taskId); equal(scope.runId, target.runId);
    const client = new QualifiedInspectionClient(config.runner);
    let observation: QualifiedRepairObservationReceipt | undefined;
    let receipt: QualifiedRepairReceipt | undefined;
    let appliedPatch: RepairPatch | undefined;
    const options: FormalRepairOptions = {
      protectedPaths: ['fixtures/runner/inspection-input/updated'],
      runner: {
        observe: signal => client.observe(signal),
        async observeRepair(...args) {
          const result = await client.observeRepair(...args);
          if (result.kind === 'repair_observation') {
            ok(!observation);
            observation = result;
          }
          return result;
        },
        async repair(...args) {
          const result = await client.repair(...args);
          if (result.kind === 'repair_receipt') {
            ok(!receipt);
            receipt = result;
            appliedPatch = args[2];
          }
          return result;
        },
      },
    };
    const model = repairModel(findingId);
    const controller = new AbortController();
    let heartbeat: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (heartbeat || controller.signal.aborted) return;
      heartbeat = coordinator.heartbeat(scope).then(live => { if (!live) controller.abort(); }, () => controller.abort())
        .finally(() => { heartbeat = undefined; });
    }, config.leaseSeconds * 1_000 / 3);
    try {
      const report = await runFormalRepair(coordinator, scope, saver, model, options, controller.signal);
      equal(report.reason, 'repair_complete');
      const { checkpointId, formalRepair, trace, usage, releaseEligible } = report;
      ok(checkpointId && formalRepair && observation && receipt && appliedPatch);
      const [target] = observation.snapshot.observation.targets;
      ok(target?.file && target.range);
      equal(target.path, fixturePath); equal(target.file.sha256, originalSha256); equal(target.file.bytes, 158);
      equal(receipt.snapshot.candidate.baseSnapshotSha256, baseSnapshotSha256);
      equal(formalRepair.receiptSha256, sha256(JSON.stringify(receipt)));
      equal(formalRepair.operationId, receipt.scope.operationId);
      equal(formalRepair.candidateManifestSha256, receipt.snapshot.candidate.candidateManifestSha256);
      deepStrictEqual(trace.map(event => event.tool), ['read_repair_targets', 'apply_repair_patch']);
      deepStrictEqual(usage, { turns: 3, toolCalls: 2, tokens: 90 });
      equal(releaseEligible, false);
      deepStrictEqual(await runFormalRepair(coordinator, scope, saver, model, options, controller.signal), report);
      const callKeySha256 = trace[1]!.operationId;
      const execution = new FormalRepairExecution(coordinator, options);
      deepStrictEqual(await execution.apply(scope,
        { callKeySha256, findingIds: [findingId], patch: appliedPatch }, controller.signal), receipt);
      return { observation, receipt, agent: { checkpointId, callKeySha256, trace: trace.map(event => event.tool), usage, releaseEligible } };
    } finally { clearInterval(timer); await heartbeat; }
  } finally { try { await saver.end(); } finally { await database.close(); } }
}

try { console.log(JSON.stringify(await repair())); }
catch { console.error('Native repair execution did not produce a scoped receipt.'); process.exitCode = 1; }
