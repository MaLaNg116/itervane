import { deepStrictEqual, equal } from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runPublishedCodeScan } from '../packages/runner/src/guest-published-code-scan.js';
import { publishGuestSnapshot, readBoundedFile, readGuestSnapshotData } from '../packages/runner/src/guest-snapshot.js';
import { sha256 } from '../packages/runner/src/profiles.js';
import { preparePublishedCodeRules } from '../packages/runner/src/published-code-rules.js';
import { publishedCodeRuleFixture } from '../packages/runner/test/helpers/published-code-rule.js';
import { trustedGitFixture } from '../packages/runner/test/helpers/trusted-git.js';

const engine = process.argv[2];
if (!engine || process.argv.length !== 3) throw new Error('Pass the prepared Semgrep engine directory');
const engineInputsSha256 = sha256(readBoundedFile(join(engine, 'inputs.json'), 4 * 1024 * 1024));
const rules = preparePublishedCodeRules(publishedCodeRuleFixture({
  version: 1, engine: 'semgrep_ce', engineVersion: '1.170.0', engineInputsSha256,
  runnerImageSha256: sha256('trusted source smoke without a guest image'),
}, ['javascript', 'typescript']));
const repository = await trustedGitFixture('sha1', {
  '.semgrepignore': Buffer.from('services/\n'),
  'services/readiness.mjs': Buffer.from('export function ready(gateway) { return gateway.status(503).json({ state: "starting" }); }\n'),
  'services/serving.cjs': Buffer.from('module.exports = gateway => gateway.status(200).json({ state: "serving" });\n'),
  'services/info.jsx': Buffer.from('export const Status = () => <span>503</span>;\n'),
  'services/empty.js': Buffer.alloc(0),
  'app/maintenance.mts': Buffer.from('export const maintenance = (edge: any) => edge.status(503).json({ retry: true });\n'),
  'app/display.tsx': Buffer.from('export const Display = () => <output>503</output>;\n'),
  'README.md': Buffer.from('Documentation for a separate fixture project.\n'),
});
try {
  const ready = join(repository.root, 'published');
  await mkdir(ready);
  publishGuestSnapshot(ready, repository.root, randomUUID(), repository.source);
  const source = readGuestSnapshotData(join(ready, 'ready'));
  equal(source.manifest.sha256, repository.manifest.sha256);
  const result = await runPublishedCodeScan(engine, rules, source);
  const { basis, reports } = result.document;
  deepStrictEqual(basis.batches.map(batch => batch.fileCount), [4, 2]);
  const paths = reports.map(report => report.status === 'checked' ? report.findings.map(item => item.path) : report);
  deepStrictEqual(paths, [['services/readiness.mjs'], ['app/maintenance.mts']]);
  console.log(JSON.stringify({ scope: 'trusted_source_smoke', commit: basis.source.commit, manifestSha256: basis.manifestSha256,
    engineVersion: basis.profile.engineVersion, engineInputsSha256, fileCounts: basis.batches.map(batch => batch.fileCount),
    paths, evidenceSha256: result.sha256 }));
} finally { await repository.close(); }
