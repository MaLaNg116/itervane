import { mkdir, writeFile } from 'node:fs/promises';
import { createFormalRepair, sha256 } from '@itervane/agent';
import { localModel } from '../agent/loopback-model.js';
import { syntheticRepairFixture } from '../agent/repair-fixture.js';
import { sourceFingerprint } from '../report.js';

async function main(args: string[]) {
  if (args.length !== 1 || args[0] !== '--live-template') {
    console.error('Usage: pnpm probe:formal-repair --live-template');
    return 2;
  }
  const model = localModel();
  if (!model) {
    console.error('Configure the selected protocol with an explicit loopback base URL, API key and model.');
    return 2;
  }
  const locale = 'zh-CN';
  const fixture = syntheticRepairFixture(locale, true);
  const fingerprint = await sourceFingerprint();
  const report = await createFormalRepair({ ...fixture, model: model.adapter, providerSha256: model.providerSha256 }).run();
  const route = report.trace.map(event => event.tool);
  const evidence = report.evidence.find(item => item.id === report.formalRepair?.evidenceId)?.data;
  const change = evidence?.kind === 'repair_candidate' ? evidence.candidate.changes[0] : undefined;
  const grounded = route.join(',') === 'read_repair_targets,apply_repair_template'
    && change?.beforeSha256 === sha256(fixture.original.toString('utf8'))
    && change.afterSha256 === sha256(fixture.expectedText) && change.afterBytes === Buffer.byteLength(fixture.expectedText);
  const passed = grounded && report.status === 'completed' && report.reason === 'repair_complete' && !report.releaseEligible;
  const value = { protocol: model.adapter.protocol, fixture: 'synthetic_dotenv_metadata', runtimeQualified: false, locale,
    checkedAt: new Date().toISOString(), sourceFingerprint: fingerprint, route, usage: report.usage, reason: report.reason, grounded, passed,
  };
  await mkdir('.reports/p2-d2', { recursive: true });
  await writeFile('.reports/p2-d2/live-template.json', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(value, null, 2));
  return passed ? 0 : 1;
}

try { process.exitCode = await main(process.argv.slice(2)); }
catch { console.error('The formal repair probe could not finish.'); process.exitCode = 1; }
