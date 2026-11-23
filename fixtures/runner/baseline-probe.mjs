import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const baseline = '/usr/local/libexec/itervane-build/baseline.mjs';
const protectedPlan = '/var/lib/itervane-runtime-gate/plan.json';
const output = '/var/lib/itervane-baseline-output';

async function waitForApplication(port) {
  const expires = performance.now() + 4_000;
  while (performance.now() < expires) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/version`, { redirect: 'manual', signal: AbortSignal.timeout(300) });
      await response.body?.cancel();
      return;
    } catch { await delay(100); }
  }
  throw new Error('runtime_unavailable');
}

try {
  const plan = JSON.parse(readFileSync(protectedPlan, 'utf8'));
  const hash = createHash('sha256').update(readFileSync(baseline)).digest('hex');
  if (hash !== plan.baselineSha256 || plan.port !== 38171 || !/^[a-f0-9]{64}$/.test(plan.runtimeInputsSha256)) {
    throw new Error('baseline_binding');
  }
  await waitForApplication(plan.port);
  const { checkStandardWebApp } = await import('./baseline.mjs');
  const result = await checkStandardWebApp({ port: plan.port, expectedVersion: plan.version, healthFollowup: plan.healthFollowup === true });
  const pending = output + '/checks.pending';
  writeFileSync(pending, JSON.stringify({ ...result, runtimeInputsSha256: plan.runtimeInputsSha256 }), { flag: 'wx', mode: 0o440 });
  renameSync(pending, output + '/checks.json');
} catch { process.exitCode = 1; }
