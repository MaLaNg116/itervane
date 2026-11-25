import { deepStrictEqual, equal, notEqual, ok } from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { codeRuleCandidateSchema, codeRuleValidationProfileSchema } from '@itervane/contracts';
import { QualifiedInspectionClient, sha256 } from '@itervane/runner';

const [socketPath, rawUid, imageSha256, engineInputsSha256] = process.argv.slice(2);
if (!socketPath || !imageSha256) throw new Error('Expected the qualified runner and sealed image');
const controllerUid = Number(rawUid);
const profile = codeRuleValidationProfileSchema.parse({
  version: 1, engine: 'semgrep_ce', engineVersion: '1.170.0', runnerImageSha256: imageSha256, engineInputsSha256,
});
const address = { socketPath, controllerUid, imageSha256 };
const runner = new QualifiedInspectionClient(address);
const idle = await runner.observe();
ok(idle?.state === 'idle' && idle.imageSha256 === imageSha256);
const candidate = codeRuleCandidateSchema.parse({
  kind: 'code_rule', key: 'literal-health-error-response',
  text: {
    en: { title: 'Hard-coded unavailable response', appliesTo: 'Known test health handlers', limitation: 'Review intentional maintenance responses' },
    'zh-CN': { title: '写死的不可用响应', appliesTo: '固定测试健康处理器', limitation: '注意有意设置的维护响应' },
  },
  check: { language: 'javascript', engine: 'semgrep_ce', pattern: '$RESPONSE.status(503).json(...)' },
  samples: { violation: 'reply.status(503).json({ state: "unhealthy" }); // nosemgrep\n',
    corrected: 'reply.status(200).json({ state: "healthy" });', lookalike: 'logger.info({ lastHealthStatus: 503 });' },
});

const taskId = randomUUID();
const runId = randomUUID();
const projectId = randomUUID();
const coordinates = (fence: number) => ({
  requestId: randomUUID(), taskId, runId, projectId, fence, generation: 1, workspaceSha256: idle.workspaceSha256,
});
const reference = { candidateId: randomUUID(), extractionResultSha256: sha256('trusted native sample candidate') };
const authorize = async () => {};
function checkedSummary(result: Awaited<ReturnType<QualifiedInspectionClient['validateRuleSamples']>>) {
  return result.kind === 'rejected' ? { code: result.code, cleanup: result.cleanup } : {
    status: result.proof.result.status, samples: result.proof.result.samples.map(sample => sample.status === 'checked'
      ? { sample: sample.name, matches: sample.matches } : { sample: sample.name, reason: sample.reason, detail: sample.detail }),
  };
}
const correct = await runner.validateRuleSamples(coordinates(1), candidate, reference, profile, authorize);
const correctSummary = JSON.stringify(checkedSummary(correct));
ok(correct.kind === 'rule_samples_receipt', correctSummary);
console.error('Expected passing rule samples', correctSummary);
equal(correct.proof.result.status, 'passed');
deepStrictEqual(correct.proof.result.samples.map(item => item.status === 'checked' ? item.matches : null), [1, 0, 0]);
const falsePositive = { ...candidate, samples: { ...candidate.samples, lookalike: 'other.status(503).json({ maintenance: true });' } };
const wrong = await runner.validateRuleSamples(coordinates(2), falsePositive, reference, profile, authorize);
const wrongSummary = JSON.stringify(checkedSummary(wrong));
ok(wrong.kind === 'rule_samples_receipt', wrongSummary);
console.error('Expected one lookalike match', wrongSummary);
equal(wrong.proof.result.status, 'failed');
deepStrictEqual(wrong.proof.result.samples.map(item => item.status === 'checked' ? item.matches : null), [1, 0, 1]);
notEqual(wrong.domainId, correct.domainId);
notEqual(wrong.proof.result.basisSha256, correct.proof.result.basisSha256);

const denied = await runner.validateRuleSamples(coordinates(3), candidate, reference, profile, async () => {
  throw new Error('test lease unavailable');
});
ok(denied.kind === 'rejected');
equal(denied.code, 'lease_lost');
equal(denied.cleanup, 'not_started');
equal(denied.domainId, null);
const wrongImage = sha256('unqualified rule sample image');
const mismatched = await new QualifiedInspectionClient({ ...address, imageSha256: wrongImage }).validateRuleSamples(
  coordinates(4), candidate, reference, { ...profile, runnerImageSha256: wrongImage }, authorize,
);
ok(mismatched.kind === 'rejected');
equal(mismatched.code, 'not_ready');
equal(mismatched.cleanup, 'not_started');
equal(mismatched.domainId, null);
ok((await runner.observe())?.state === 'idle');

console.log(JSON.stringify({ profile, correct, wrong, denied, mismatched }));
