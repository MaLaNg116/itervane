import { deepStrictEqual, equal, notEqual, ok } from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { codeRuleCandidateSchema, codeRuleValidationProfileSchema, qualifiedInspectionRequestSchema } from '@itervane/contracts';
import { canonicalPublishedInspectionCommand, createInspectionPlan, QualifiedInspectionClient, sha256 } from '@itervane/runner';
import { publishedCodeRuleFixture } from '../../../runner/test/helpers/published-code-rule.js';

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

const publishedCommand = canonicalPublishedInspectionCommand(publishedCodeRuleFixture(profile));
const destination = publishedCommand.rules.input.snapshot.document;
const source = { repositoryId: randomUUID(), commit: '5d72c2fd9558d708441dc258496842698b09f630' };
const scanRunId = randomUUID();
const plan = createInspectionPlan({ taskId: destination.taskId, runId: scanRunId, requestedSource: source });
const sourceRequest = qualifiedInspectionRequestSchema.parse({
  version: 1, taskId: destination.taskId, projectId: destination.projectId, runId: scanRunId, origin: 'https://github.com/MaLaNg116/itervane.git',
  ...source, generation: 1, fence: 1, workspaceSha256: idle.workspaceSha256, planSha256: plan.sha256, requestId: randomUUID(),
  publishedCode: publishedCommand.binding,
});
const sourceDenied = await runner.inspect(sourceRequest, async () => { throw new Error('test lease unavailable'); }, undefined, publishedCommand);
ok(sourceDenied.kind === 'rejected');
equal(sourceDenied.code, 'lease_lost');
equal(sourceDenied.cleanup, 'not_started');
const scanned = await runner.inspect({ ...sourceRequest, requestId: randomUUID() }, authorize, undefined, publishedCommand);
if (scanned.kind !== 'receipt') throw new Error(JSON.stringify({ code: scanned.code, cleanup: scanned.cleanup }));
const proof = scanned.snapshot.publishedCode;
ok(proof);
const observations = proof.scan.document.reports;
equal(observations[0]?.status, 'checked', JSON.stringify(observations.map(item => item.status === 'unavailable' ? item.reason : item.status)));
const findings = observations.flatMap(report => report.status === 'checked' ? report.findings : []);
ok(findings.some(finding => finding.path === 'server/app.mjs' && finding.ruleKey === 'published-health-javascript'));
ok(scanned.snapshot.reports.every(report => report.status === 'completed'));
notEqual(scanned.domainId, correct.domainId);
notEqual(scanned.domainId, wrong.domainId);
ok((await runner.observe())?.state === 'idle');
const published = {
  commit: source.commit, domainId: scanned.domainId, manifestSha256: proof.manifest.sha256, evidenceSha256: proof.scan.sha256,
  imageSha256: scanned.imageSha256, cleanupConfirmed: scanned.cleanupConfirmed, sessionVerified: scanned.sessionVerified,
  fileCounts: proof.scan.document.basis.batches.map(batch => batch.fileCount),
  findings: findings.map(({ path, ruleKey }) => ({ path, ruleKey })),
  scannerStatuses: scanned.snapshot.reports.map(report => report.status),
  denied: { code: sourceDenied.code, cleanup: sourceDenied.cleanup, domainId: sourceDenied.domainId },
};
const rechecked = await runner.verify({ requestId: randomUUID(), fence: 2, workspaceSha256: idle.workspaceSha256, origin: sourceRequest.origin }, {
  version: 1, taskId: destination.taskId, runId: scanRunId, projectId: destination.projectId, generation: 1,
  source, locale: 'en', dataClass: 'synthetic',
  inspection: { requestId: scanned.scope.requestId, planSha256: plan.sha256,
    receiptSha256: sha256(JSON.stringify(scanned)), snapshotSha256: proof.manifest.sha256 },
  audit: { checkpointId: randomUUID(), inputSha256: sha256('trusted probe input'), resultSha256: sha256('trusted probe result') },
  catalogSha256: sha256('trusted probe catalog'),
  profile: { id: 'rule-rescan-probe', policySha256: sha256('trusted probe policy'), baselineSha256: sha256('no app build'),
    runnerImageSha256: imageSha256, scannerInputsSha256: scanned.snapshot.inputsSha256 },
  subject: { kind: 'original', manifestSha256: proof.manifest.sha256 },
  publishedCode: { snapshotSha256: publishedCommand.rules.input.snapshot.sha256, inspectionScanSha256: proof.scan.sha256,
    ruleSetSha256: publishedCommand.rules.sha256 },
}, null, authorize, undefined, publishedCommand.rules.input);
if (rechecked.kind !== 'verification_receipt') throw new Error(JSON.stringify({ code: rechecked.code, cleanup: rechecked.cleanup }));
const second = rechecked.snapshot.publishedCode;
ok(second?.kind === 'original');
equal(second.manifest.sha256, proof.manifest.sha256);
deepStrictEqual(second.scan.document.basis, proof.scan.document.basis);
const secondFindings = second.scan.document.reports.flatMap(report => report.status === 'checked' ? report.findings : []);
deepStrictEqual(secondFindings, findings);
ok(rechecked.snapshot.reports.every(report => report.status === 'completed'));
notEqual(rechecked.domainId, scanned.domainId);
ok((await runner.observe())?.state === 'idle');
console.log(JSON.stringify({ profile, correct, wrong, denied, mismatched, published, rechecked: {
  domainId: rechecked.domainId, imageSha256: rechecked.imageSha256, cleanupConfirmed: rechecked.cleanupConfirmed,
  sessionVerified: rechecked.sessionVerified, manifestSha256: second.manifest.sha256, evidenceSha256: second.scan.sha256,
  ruleSetSha256: second.scan.document.basis.ruleSetSha256,
  findings: secondFindings.map(({ path, ruleKey }) => ({ path, ruleKey })),
} }));
