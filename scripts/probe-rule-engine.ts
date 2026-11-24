import { join } from 'node:path';
import { prepareCodeRuleValidation } from '../packages/rules/src/index.js';
import { runPreparedCodeRuleSamples, verifySemgrepEngine } from '../packages/runner/src/guest-rule-validation.js';
import { readBoundedFile } from '../packages/runner/src/guest-snapshot.js';
import { sha256 } from '../packages/runner/src/profiles.js';
import { deepStrictEqual, equal, rejects } from 'node:assert/strict';

const directory = process.argv[2];
if (!directory || process.argv.length !== 3) throw new Error('Pass the freshly prepared tool directory');
const bytes = readBoundedFile(join(directory, 'inputs.json'), 4 * 1024 * 1024);
const profile = { version: 1 as const, engine: 'semgrep_ce' as const, engineVersion: '1.170.0', engineInputsSha256: sha256(bytes),
  runnerImageSha256: sha256('trusted development smoke fixture without an image') };
const reference = { candidateId: 'aaaaaaa0-aaaa-4aaa-8aaa-aaaaaaaaaaaa', extractionResultSha256: sha256('trusted sample candidate') };
const fixture = {
  kind: 'code_rule', key: 'literal-health-error-response',
  text: { en: { title: 'Hard-coded unavailable response', appliesTo: 'Synthetic health-handler sample', limitation: 'Advisory' },
    'zh-CN': { title: '写死的不可用响应', appliesTo: '合成健康处理器样例', limitation: '提示' } },
  check: { language: 'javascript', engine: 'semgrep_ce', pattern: '$RESPONSE.status(503).json(...)' },
  samples: { violation: 'reply.status(503).json({ state: "unhealthy" }); // nosemgrep\n',
    corrected: 'reply.status(200).json({ state: "healthy" });', lookalike: 'logger.info({ lastHealthStatus: 503 });' },
};
const engine = await verifySemgrepEngine(directory, profile);
const prepared = prepareCodeRuleValidation(fixture, reference, profile);
const checked = await runPreparedCodeRuleSamples(directory, prepared);
equal(checked.status, 'passed');
deepStrictEqual(checked.samples.map(sample => sample.status === 'checked' ? sample.matches : null), [1, 0, 0]);
const invalid = { ...fixture, check: { ...fixture.check, pattern: '[not valid JavaScript' } };
const failed = await runPreparedCodeRuleSamples(directory, prepareCodeRuleValidation(invalid, reference, profile));
equal(failed.status, 'unavailable');
await rejects(verifySemgrepEngine(directory, { ...profile, engineInputsSha256: sha256('wrong fingerprint') }), /semgrep_engine_fingerprint/);
console.log(JSON.stringify({ scope: 'trusted_sample_smoke', engine, inputsSha256: profile.engineInputsSha256, checked,
  invalidRule: failed.status, wrongEngineFingerprintRejected: true }));
