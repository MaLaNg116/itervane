import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Check } from '@itervane/contracts';
import { report } from '../report.js';
import { createAnthropic, createOpenAI } from './adapters.js';
import { runProbeLoop, type ProbeTool } from './loop.js';

export async function probeModel(env: NodeJS.ProcessEnv = process.env) {
  const provider = env.MODEL_PROVIDER ?? 'anthropic';
  if (provider !== 'anthropic' && provider !== 'openai') throw new Error('Unsupported MODEL_PROVIDER');
  const prefix = provider.toUpperCase();
  const apiKey = env[`${prefix}_API_KEY`];
  const model = env[`${prefix}_MODEL`];
  if (!apiKey || !model) return report('model', [{ id: 'configuration', status: 'blocked', detail: 'Selected protocol needs an API key and model configured locally.' }]);
  const config = {
    apiKey, model,
    baseURL: env[`${prefix}_BASE_URL`] ?? (provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'),
  };
  const adapter = provider === 'anthropic' ? createAnthropic(config) : createOpenAI(config);
  const checks: Check[] = [];
  for (const healthy of [true, false]) {
    const proof = randomUUID();
    const empty = z.object({}).strict();
    const finish = z.object({ decision: z.enum(['healthy', 'needs_human']), proof: z.uuid() }).strict();
    const tools: ProbeTool[] = [
      { definition: { name: 'inspect_service', description: 'Read current service health. A healthy result supplies the completion proof; an unhealthy result requires reading logs.', inputSchema: z.toJSONSchema(empty) }, input: empty,
        execute: async () => healthy ? { healthy: true, proof } : { healthy: false, nextEvidence: 'read_logs' } },
      { definition: { name: 'read_logs', description: 'Read diagnostic evidence after inspecting an unhealthy service. There are no authorized mutations; escalate an unhealthy result to a human.', inputSchema: z.toJSONSchema(empty) }, input: empty,
        execute: async () => ({ error: 'fixture-startup-failure', proof, action: 'needs_human' }) },
      { definition: { name: 'finish_audit', description: 'Complete with the decision and exact proof returned by the relevant observation tool.', inputSchema: z.toJSONSchema(finish) }, input: finish,
        execute: async () => { throw new Error('Completion is evaluated by the verifier'); } },
    ];
    const result = await runProbeLoop({
      adapter, tools, goal: 'Check this service. Inspect first. If unhealthy, investigate logs and escalate; otherwise report healthy. Supply the actual observation proof.',
      signal: AbortSignal.timeout(90_000),
      acceptFinish(input, trace) {
        const parsed = finish.safeParse(input);
        const names = trace.map(t => t.tool);
        return parsed.success && parsed.data.proof === proof
          && parsed.data.decision === (healthy ? 'healthy' : 'needs_human')
          && names[0] === 'inspect_service'
          && (healthy ? !names.includes('read_logs') : names.includes('read_logs'));
      },
    });
    checks.push({ id: healthy ? 'healthy-observation-route' : 'unhealthy-investigation-route',
      status: result.status === 'completed' ? 'passed' : 'failed',
      detail: `${adapter.protocol}; ${result.reason}; tools=${result.trace.map(t => t.tool).join(',')}; tokens=${result.tokens}` });
  }
  return report('model', checks);
}
