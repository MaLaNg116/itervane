import { mkdir, writeFile } from 'node:fs/promises';
import { createFormalRepair, sha256 } from '@itervane/agent';
import type { ModelAdapter } from '@itervane/model';
import { localModel } from '../agent/loopback-model.js';
import { syntheticNpmRepairFixture, syntheticRepairFixture } from '../agent/repair-fixture.js';
import { sourceFingerprint } from '../report.js';

async function main(args: string[]) {
  if (args.length !== 1 || !['--live-template', '--live-npm'].includes(args[0]!)) {
    console.error('Usage: pnpm probe:formal-repair --live-template | --live-npm');
    return 2;
  }
  const model = localModel();
  if (!model) {
    console.error('Configure the selected protocol with an explicit loopback base URL, API key and model.');
    return 2;
  }
  const npm = args[0] === '--live-npm';
  const locale = npm ? 'en' : 'zh-CN';
  const fixture = npm ? syntheticNpmRepairFixture(locale) : syntheticRepairFixture(locale, true);
  const files = 'files' in fixture ? fixture.files : [{
    path: fixture.finding.path, original: fixture.original.toString('utf8'), expected: fixture.expectedText,
  }];
  const fingerprint = await sourceFingerprint();
  const decisions: { offered: string[]; selected: string[] }[] = [];
  const adapter: ModelAdapter = { protocol: model.adapter.protocol, async complete(input) {
    const turn = await model.adapter.complete(input);
    const offered = input.tools.map(tool => tool.name);
    decisions.push({ offered, selected: turn.calls.map(call => offered.includes(call.name) ? call.name : 'unavailable') });
    return turn;
  } };
  const report = await createFormalRepair({ ...fixture, model: adapter, providerSha256: model.providerSha256 }).run();
  const route = report.trace.map(event => event.tool);
  const failures = report.evidence.flatMap(({ data }) => data.kind === 'repair_failure' ? [data.code] : []);
  const evidence = report.evidence.find(item => item.data.kind === 'repair_candidate');
  const changes = evidence?.data.kind === 'repair_candidate' ? evidence.data.candidate.changes : [];
  const tool = npm ? 'apply_repair_patch' : 'apply_repair_template';
  const grounded = route.join(',') === `read_repair_targets,${tool}` && changes.length === files.length
    && files.every(file => changes.some(change => change.path === file.path && change.beforeSha256 === sha256(file.original)
      && change.afterSha256 === sha256(file.expected) && change.afterBytes === Buffer.byteLength(file.expected)));
  const passed = grounded && evidence?.id === report.formalRepair?.evidenceId && report.status === 'completed'
    && report.reason === 'repair_complete' && !report.releaseEligible;
  const value = { protocol: model.adapter.protocol, fixture: npm ? 'approved_npm_fixture' : 'synthetic_dotenv_metadata', runtimeQualified: false, locale,
    checkedAt: new Date().toISOString(), sourceFingerprint: fingerprint, route, decisions, failures,
    usage: report.usage, reason: report.reason, grounded, passed,
  };
  await mkdir('.reports/p2-d2', { recursive: true });
  await writeFile(npm ? '.reports/p2-d2/live-npm.json' : '.reports/p2-d2/live-template.json', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(value, null, 2));
  return passed ? 0 : 1;
}

try { process.exitCode = await main(process.argv.slice(2)); }
catch { console.error('The formal repair probe could not finish.'); process.exitCode = 1; }
