import { mkdir, writeFile } from 'node:fs/promises';
import { createFormalOperations } from '@itervane/agent';
import { MemorySaver } from '@langchain/langgraph';
import { localModel } from '../agent/loopback-model.js';
import { operationsFixture, scriptedOperations } from '../agent/operations-fixture.js';
import { sourceFingerprint } from '../report.js';

async function main(args: string[]) {
  if (args.length && (args.length !== 1 || args[0] !== '--live')) {
    console.error('Usage: pnpm probe:operations-agent [--live]');
    return 2;
  }
  const live = args.length === 1;
  const configured = live ? localModel() : undefined;
  if (live && !configured) {
    console.log('Blocked: configure the selected protocol with an explicit loopback base URL, key and model.');
    return 2;
  }
  const runs = [];
  for (const [locale, state] of [['zh-CN', 'exited'], ['en', 'running']] as const) {
    const fixture = operationsFixture(locale, state);
    const result = await createFormalOperations({
      ...fixture, checkpointer: new MemorySaver(), model: configured?.adapter ?? scriptedOperations(),
      providerSha256: configured?.providerSha256 ?? fixture.providerSha256,
    }).run();
    runs.push({
      locale, state, status: result.status, reason: result.reason, usage: result.usage,
      sections: result.evidence.flatMap(entry => entry.data.kind === 'operations_section' ? [entry.data.section] : []),
      recommendation: result.formalOperations?.recommendation.code,
      hypotheses: result.formalOperations?.hypotheses.map(item => item.code),
    });
  }
  const driver = configured ? 'live_loopback' : 'deterministic';
  const report = { driver, protocol: configured?.adapter.protocol, checkedAt: new Date().toISOString(), sourceFingerprint: await sourceFingerprint(), runs };
  await mkdir('.reports/p3-b', { recursive: true });
  await writeFile(`.reports/p3-b/operations-agent-${driver}.json`, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  return runs.every(run => run.status === 'completed') ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
