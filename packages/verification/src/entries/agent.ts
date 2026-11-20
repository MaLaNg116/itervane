import { mkdir, writeFile } from 'node:fs/promises';
import { createAgentHarness } from '@itervane/agent';
import { MemorySaver } from '@langchain/langgraph';
import { createAnthropic, createOpenAI, safeEndpoint } from '@itervane/model';
import { createDeliveryFixture, deliveryCases } from '../agent/fixture.js';
import { scriptedModel } from '../agent/scripted-model.js';
import { sourceFingerprint } from '../report.js';

function localModel() {
  const { MODEL_PROVIDER = 'anthropic' } = process.env;
  if (MODEL_PROVIDER !== 'anthropic' && MODEL_PROVIDER !== 'openai') return;
  const prefix = MODEL_PROVIDER.toUpperCase();
  const baseURL = process.env[`${prefix}_BASE_URL`];
  const apiKey = process.env[`${prefix}_API_KEY`];
  const model = process.env[`${prefix}_MODEL`];
  if (!baseURL || !apiKey || !model) return;
  try {
    const endpoint = safeEndpoint(baseURL);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(endpoint).hostname)) return;
    const config = { baseURL: endpoint, apiKey, model };
    return MODEL_PROVIDER === 'anthropic' ? createAnthropic(config) : createOpenAI(config);
  } catch {
    return;
  }
}

async function main(args: string[]) {
  if (args.length && (args.length !== 1 || args[0] !== '--live')) {
    console.error('Usage: pnpm probe:agent [--live]');
    return 2;
  }
  const live = args.includes('--live');
  const adapter = live ? localModel() : undefined;
  if (live && !adapter) {
    console.log('Blocked: configure the selected protocol with an explicit loopback base URL, key and model.');
    return 2;
  }
  const runs = [];
  for (const name of deliveryCases) {
    const locale = name === 'display' ? 'zh-CN' : 'en';
    const { spec, host } = createDeliveryFixture(name, locale);
    const agent = createAgentHarness({ model: adapter ?? scriptedModel(locale), checkpointer: new MemorySaver(), host });
    const run = await agent.run(spec);
    const verification = run.verifications.at(-1);
    const evidence = new Map(run.evidence.map(item => [item.id, item.data]));
    const route = run.trace.map(item => {
      const data = evidence.get(item.evidenceId);
      return {
        role: item.role, tool: item.tool, evidenceId: item.evidenceId,
        section: data?.kind === 'context' ? data.section : undefined,
        check: data?.kind === 'check' ? data.result.check : undefined,
      };
    });
    runs.push({
      name, locale, origin: run.origin, releaseEligible: run.releaseEligible, status: run.status, reason: run.reason,
      usage: run.usage, route, templateIds: run.repairs.at(-1)?.candidate.templateIds,
      snapshotSha256: spec.snapshotSha256, candidateSha256: verification?.snapshotSha256, checks: verification?.checks,
    });
  }
  const value = {
    driver: adapter ? 'live_loopback' : 'deterministic', protocol: adapter?.protocol, checkedAt: new Date().toISOString(),
    sourceFingerprint: await sourceFingerprint(), runs,
  };
  await mkdir('.reports/p2-a', { recursive: true });
  await writeFile(`.reports/p2-a/${value.driver}.json`, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(value, null, 2));
  return runs.every(run => run.status === 'completed' && run.reason === 'fixture_complete') ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
