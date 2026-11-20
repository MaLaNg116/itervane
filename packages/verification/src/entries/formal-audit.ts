import { mkdir, writeFile } from 'node:fs/promises';
import { createFormalAudit, sha256 } from '@itervane/agent';
import { auditFixture } from '../agent/formal-fixture.js';
import { localModel } from '../agent/loopback-model.js';
import { sourceFingerprint } from '../report.js';

const cases = [
  { id: 'suspected-secret', locale: 'zh-CN', secretMatches: 1, dependencyMatch: false, findingId: sha256('pattern-0'), certainty: 'suspected' },
  { id: 'dependency-match', locale: 'en', secretMatches: 0, dependencyMatch: true, findingId: sha256('dependency'), certainty: 'confirmed' },
] as const;

async function main(args: string[]) {
  if (args.length !== 1 || args[0] !== '--live') {
    console.error('Usage: pnpm probe:formal-audit --live');
    return 2;
  }
  const model = localModel();
  if (!model) {
    console.error('Configure the selected protocol with an explicit loopback base URL, API key and model.');
    return 2;
  }
  const fingerprint = await sourceFingerprint();
  const runs = [];
  for (const fixture of cases) {
    const input = auditFixture(fixture.locale, fixture.secretMatches, fixture.dependencyMatch);
    const result = await createFormalAudit({ ...input, model: model.adapter, providerSha256: model.providerSha256 }).run();
    const scans = result.evidence.filter(item => item.data.kind === 'scan');
    const finding = result.audit?.findings[0];
    const route = result.trace.map(step => {
      const data = result.evidence.find(item => item.id === step.evidenceId)?.data;
      return { tool: step.tool, scanner: data?.kind === 'scan' ? data.scanner : undefined, ruleId: data?.kind === 'rule' ? data.ruleId : undefined };
    });
    const grounded = result.audit?.findings.length === 1 && finding?.id === fixture.findingId && finding.certainty === fixture.certainty
      && scans.length === 2 && scans.every(scan => result.audit?.evidenceIds.includes(scan.id));
    const passed = grounded && result.status === 'completed' && result.reason === 'audit_complete' && !result.releaseEligible;
    runs.push({ id: fixture.id, locale: fixture.locale, status: result.status, reason: result.reason, usage: result.usage, route,
      findings: result.audit?.findings.length ?? 0, hypotheses: result.audit?.hypotheses.length ?? 0, grounded, passed });
  }
  const distinctPaths = new Set(runs.map(run => JSON.stringify(run.route))).size === runs.length;
  const passed = distinctPaths && runs.every(run => run.passed);
  const value = { protocol: model.adapter.protocol, fixture: 'synthetic_scan_metadata', runtimeQualified: false,
    checkedAt: new Date().toISOString(), sourceFingerprint: fingerprint, distinctPaths, passed, runs };
  await mkdir('.reports/p2-d1', { recursive: true });
  await writeFile('.reports/p2-d1/live-loopback.json', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(value, null, 2));
  return passed ? 0 : 1;
}

try { process.exitCode = await main(process.argv.slice(2)); }
catch { console.error('The formal audit probe could not finish.'); process.exitCode = 1; }
