import { deepStrictEqual, equal, ok } from 'node:assert/strict';
import type { AgentEvidence } from '@itervane/agent';
import { formalRepairResultSchema, idSchema, sha256Schema, type QualifiedRepairObservationReceipt, type QualifiedRepairReceipt } from '@itervane/contracts';
import type { ModelAdapter } from '@itervane/model';
import { QualifiedInspectionClient, sha256 } from '@itervane/runner';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { eq } from 'drizzle-orm';
import { workerConfig } from '../../src/config.js';
import { openDatabase } from '../../src/persistence/database.js';
import { formalRepairResults } from '../../src/persistence/schema.js';
import type { FormalRepairOptions } from '../../src/runtime/formal-repair.js';
import { DurableWorker } from '../../src/runtime/worker.js';
import { npmFixtureApproval, npmFixturePaths } from '../../../verification/src/agent/npm-repair-fixture.js';

const fixtures = {
  patch: { path: 'fixtures/runner/inspection-input/original/config.txt', bytes: 158,
    sha256: '3812bc54c3579d8c67275c573f0ff1bf7dde70bfb4a9150621459ae510a87afc', tool: 'apply_repair_patch' },
  template: { path: 'fixtures/runner/repair-input/.env.example', bytes: 141,
    sha256: '2a521af0e56199ba9686f52434e2097219b9c336a5037a2504c50914b1cfb809', tool: 'apply_repair_template' },
} as const;
const updated = '# Use managed credentials at runtime.\n';
type FileFixture = typeof fixtures[keyof typeof fixtures];

function repairModel(findingId: string, expected: FileFixture | undefined) {
  const decide = (name: string, input: unknown) => ({ text: '', calls: [{ id: 'repair-fixture', name, input }], tokenUsage: 30 });
  const complete: ModelAdapter['complete'] = async ({ conversation }) => {
    const context = conversation[0];
    if (context?.kind !== 'user') throw new Error('repair_fixture_context');
    const { observations } = JSON.parse(context.text) as { observations: AgentEvidence[] };
    const applied = observations.find(item => item.data.kind === 'repair_candidate');
    if (applied) return decide('finish_role', { summary: expected ? '已按观察到的区间替换疑似凭据行。' : '已按批准版本更新依赖清单和锁文件。', evidenceId: applied.id });
    const evidence = observations.find(item => item.data.kind === 'repair_targets');
    if (!evidence || evidence.data.kind !== 'repair_targets') return decide('read_repair_targets', { findingIds: [findingId] });
    const { targets } = evidence.data.observation;
    if (!expected) {
      deepStrictEqual(targets.map(target => target.findingId), [findingId, findingId]);
      for (const target of targets) {
        equal(target.npm?.name, npmFixtureApproval.name);
        equal(target.npm?.fixedVersion, npmFixtureApproval.fixedVersion);
      }
      return decide('apply_repair_patch', { observationId: evidence.id, targets: targets.map((_, targetIndex) => ({ targetIndex })) });
    }
    const [target] = targets;
    if (!target?.range || target.findingId !== findingId || target.file?.sha256 !== expected.sha256) throw new Error('repair_fixture_target');
    if (target.templates.includes('remove-env-entry-v1')) {
      return decide('apply_repair_template', { observationId: evidence.id, targetIndex: 0, templateId: 'remove-env-entry-v1' });
    }
    return decide('apply_repair_patch', { observationId: evidence.id, targets: [{ targetIndex: 0,
      edits: [{ startByte: target.range.startByte, endByte: target.range.endByte, replacement: updated }],
    }] });
  };
  return { adapter: { protocol: 'anthropic' as const, complete }, providerSha256: sha256('native repair fixture v1') };
}

async function repair() {
  const [taskId, runId, snapshot, finding, variant, ...extra] = process.argv.slice(2);
  const config = workerConfig();
  if (process.platform !== 'linux' || !process.getuid?.() || !config.runner || extra.length
      || (variant !== 'patch' && variant !== 'template' && variant !== 'npm')
      || !/^\/itervane_test_[a-f0-9]{12}$/.test(new URL(config.databaseUrl).pathname)) throw new Error('repair_fixture_config');
  const expected = variant === 'npm' ? undefined : fixtures[variant];
  const target = { taskId: idSchema.parse(taskId), runId: idSchema.parse(runId) };
  const baseSnapshotSha256 = sha256Schema.parse(snapshot);
  const findingId = sha256Schema.parse(finding);
  const database = await openDatabase(config.databaseUrl);
  const saver = PostgresSaver.fromConnString(config.databaseUrl, { schema: 'itervane_checkpoint' });
  try {
    const client = new QualifiedInspectionClient(config.runner);
    let observation: QualifiedRepairObservationReceipt | undefined;
    let receipt: QualifiedRepairReceipt | undefined;
    const options: FormalRepairOptions = {
      protectedPaths: ['fixtures/runner/inspection-input/updated'],
      ...(variant === 'npm' ? { npmApprovals: [npmFixtureApproval] } : {}),
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
          }
          return result;
        },
      },
    };
    const worker = new DurableWorker(database, config.databaseUrl, { leaseSeconds: config.leaseSeconds,
      auditModel: repairModel(findingId, expected), repair: options,
    });
    try { equal(await worker.tick(), true); } finally { await worker.close(); }
    ok(observation && receipt);
    const { targets } = observation.snapshot.observation;
    if (expected) {
      const [observed] = targets;
      ok(observed?.file && observed.range);
      equal(observed.path, expected.path); equal(observed.file.sha256, expected.sha256); equal(observed.file.bytes, expected.bytes);
    } else {
      deepStrictEqual(targets.map(target => target.path), [npmFixturePaths.lock, npmFixturePaths.manifest]);
      ok(targets.every(target => target.status === 'text' && target.npm && target.file));
    }
    equal(receipt.snapshot.candidate.baseSnapshotSha256, baseSnapshotSha256);
    const [stored] = await database.db.select().from(formalRepairResults).where(eq(formalRepairResults.runId, target.runId));
    ok(stored);
    const result = formalRepairResultSchema.parse(stored.document);
    if (result.status !== 'candidate_ready') throw new Error('repair_fixture_candidate_missing');
    const { candidate, checkpointId, usage, releaseEligible } = result;
    equal(result.taskId, target.taskId);
    equal(candidate.receiptSha256, sha256(JSON.stringify(receipt)));
    equal(candidate.operationId, receipt.scope.operationId);
    equal(candidate.manifestSha256, receipt.snapshot.candidate.candidateManifestSha256);
    deepStrictEqual(usage, { turns: 3, toolCalls: 2, tokens: 90 });
    equal(releaseEligible, false);
    const saved = await saver.getTuple({ configurable: { thread_id: `repair:${target.runId}`, checkpoint_ns: '', checkpoint_id: checkpointId } });
    const state = saved?.checkpoint.channel_values.state as { trace?: { call: { name: string }; operationId: string }[] } | undefined;
    ok(state?.trace);
    const trace = state.trace.map(event => event.call.name);
    deepStrictEqual(trace, ['read_repair_targets', expected?.tool ?? 'apply_repair_patch']);
    return { observation, receipt, agent: { checkpointId, callKeySha256: state.trace[1]!.operationId, trace, usage, releaseEligible,
      resultSha256: stored.sha256,
    } };
  } finally { try { await saver.end(); } finally { await database.close(); } }
}

try { console.log(JSON.stringify(await repair())); }
catch { console.error('Native repair execution did not produce a scoped receipt.'); process.exitCode = 1; }
