import { randomUUID } from 'node:crypto';
import { createAgentHarness, createFormalOperations, sha256, type AgentSpec } from '@itervane/agent';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import pg from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createDeliveryFixture } from '../../src/agent/fixture.js';
import { operationsFixture, scriptedOperations } from '../../src/agent/operations-fixture.js';
import { scriptedModel } from '../../src/agent/scripted-model.js';
import { assertDisposableDatabase } from '../../src/database.js';

const schema = `itervane_agent_${randomUUID().replaceAll('-', '')}`;
let databaseUrl: string;
let pool: pg.Pool | undefined;
let created = false;

async function withSaver<T>(work: (saver: PostgresSaver) => Promise<T>) {
  const saver = PostgresSaver.fromConnString(databaseUrl, { schema });
  try { return await work(saver); }
  finally { await saver.end(); }
}
async function durableState(saver: PostgresSaver, spec: AgentSpec) {
  const record = await saver.getTuple({ configurable: { thread_id: `fixture-agent:${spec.runId}` } });
  return record?.checkpoint.channel_values.state;
}

beforeAll(async () => {
  databaseUrl = process.env.DATABASE_URL ?? '';
  assertDisposableDatabase(databaseUrl);
  pool = new pg.Pool({ connectionString: databaseUrl });
  await pool.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  await withSaver(saver => saver.setup());
});
afterAll(async () => {
  try { if (created) await pool?.query(`DROP SCHEMA "${schema}" CASCADE`); }
  finally { await pool?.end(); }
});

it('publishes each action reservation before use, reconnects at a settled boundary, and replays the same final report', async () => {
  const { spec, host } = createDeliveryFixture('pagination', 'zh-CN');
  const model = scriptedModel(spec.locale);
  const paused = await withSaver(async saver => createAgentHarness({
    checkpointer: saver, host, model: { ...model, async complete(input) {
      expect(await withSaver(reader => durableState(reader, spec))).toMatchObject({
        pending: 'decision', usage: { turns: 1, toolCalls: 0 },
      });
      return model.complete(input);
    } },
  }).run(spec, { pauseAfter: 'decision' }));
  expect(paused).toMatchObject({ status: 'paused', usage: { turns: 1, toolCalls: 0 } });

  const observed = vi.fn(host.observe);
  const resumed = await withSaver(saver => createAgentHarness({
    checkpointer: saver, model, host: { ...host, async observe(input) {
      const state = await withSaver(reader => durableState(reader, spec));
      expect(state).toMatchObject({ pending: 'observation', usage: { toolCalls: observed.mock.calls.length + 1 } });
      return observed(input);
    } },
  }).run(spec));
  expect(resumed).toMatchObject({ status: 'completed', releaseEligible: false, usage: { toolCalls: 10, turns: 13 } });
  expect(resumed.audit?.findings[0]?.id).toBe('page_size');
  expect(observed).toHaveBeenCalledTimes(10);

  const neverCalled = vi.fn(model.complete);
  expect(await withSaver(saver => createAgentHarness({
    checkpointer: saver, host, model: { ...model, complete: neverCalled },
  }).run(spec))).toEqual(resumed);
  expect(neverCalled).not.toHaveBeenCalled();
});

it('retains an unconfirmed tool reservation across reconnects and never dispatches it speculatively', async () => {
  const { spec, host } = createDeliveryFixture('display', 'en');
  const script = scriptedModel('en');
  const complete = vi.fn(script.complete);
  const observe = vi.fn(host.observe);
  const run = (saver: PostgresSaver) => createAgentHarness({
    model: { ...script, complete }, host: { ...host, observe }, checkpointer: saver,
  });
  await withSaver(saver => run(saver).run(spec, { pauseAfter: 'decision' }));
  const paused = await withSaver(saver => run(saver).run(spec, { pauseAfter: 'reservation' }));
  expect(paused).toMatchObject({ status: 'paused', usage: { turns: 1, toolCalls: 1 } });
  const recovered = await withSaver(saver => run(saver).run(spec));
  expect(recovered).toMatchObject({ status: 'requires_human', reason: 'interrupted_action', usage: paused.usage });
  expect(observe).not.toHaveBeenCalled();
  expect(complete).toHaveBeenCalledTimes(1);
});

it('checks the current input binding and authorization before resuming work', async () => {
  const { spec, host } = createDeliveryFixture('display', 'en');
  const model = scriptedModel('en');
  await withSaver(saver => createAgentHarness({ host, model, checkpointer: saver }).run(spec, { pauseAfter: 'decision' }));
  const observe = vi.fn(host.observe);
  const authorize = vi.fn(async () => false);
  const resume = (candidate: AgentSpec) => withSaver(saver => createAgentHarness({
    model, host: { observe, authorize }, checkpointer: saver,
  }).run(candidate));
  expect(await resume({ ...spec, generation: spec.generation + 1 })).toMatchObject({ reason: 'incompatible_checkpoint' });
  expect(authorize).not.toHaveBeenCalled();
  expect(await resume(spec)).toMatchObject({ reason: 'permission_denied', status: 'requires_human', usage: { turns: 1, toolCalls: 0 } });
  expect(observe).not.toHaveBeenCalled();
});

it('reconnects to a real PostgreSQL reservation for an operations read and reuses the published diagnosis', async () => {
  const sample = operationsFixture('zh-CN', 'exited');
  const script = scriptedOperations();
  const complete = vi.fn(script.complete);
  const config = { configurable: { thread_id: `operations:${sample.input.document.runId}` } };
  const read = vi.fn<Parameters<typeof createFormalOperations>[0]['read']>(async input => {
    const saved = await withSaver(saver => saver.getTuple(config));
    expect(saved?.checkpoint.channel_values.state).toMatchObject({
      pending: 'observation', nextTool: { name: 'read_operations', args: { section: input.section } },
    });
    return sample.read(input);
  });
  const agent = (checkpointer: PostgresSaver, providerSha256 = sample.providerSha256) =>
    createFormalOperations({ ...sample, checkpointer, providerSha256, read, model: { ...script, complete } });
  await withSaver(saver => agent(saver).run({ pauseAfter: 'decision' }));
  const paused = await withSaver(saver => agent(saver).run({ pauseAfter: 'reservation' }));
  expect(paused).toMatchObject({ status: 'paused', usage: { turns: 1, toolCalls: 1 } });
  expect(await withSaver(saver => agent(saver, sha256('different model profile')).run()))
    .toMatchObject({ status: 'requires_human', reason: 'incompatible_checkpoint', evidence: [] });
  expect(read).not.toHaveBeenCalled();

  const settled = await withSaver(saver => agent(saver).run());
  expect(settled).toMatchObject({ status: 'completed', checkpointId: expect.any(String),
    formalOperations: { previousReleaseOperationId: sample.previousReleaseOperationId },
    usage: { turns: 4, toolCalls: 3 } });
  expect(read.mock.calls.map(([input]) => input.section)).toEqual(['container', 'logs', 'release']);
  expect(read.mock.calls[0]?.[0].operationId).toBe(sha256(settled.bindingSha256 + ':1'));
  expect(await withSaver(saver => agent(saver).run())).toEqual(settled);
  expect(complete).toHaveBeenCalledTimes(4);
  expect(read).toHaveBeenCalledTimes(3);
});
