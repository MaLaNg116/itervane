import { randomUUID } from 'node:crypto';
import {
  candidateValidationPlanSchema, candidateValidationRecordSchema, codeRulePackageSchema, rulePackageReviewRecordSchema, taskRuleSnapshotSchema,
  type CodeRuleLanguage, type CodeRuleValidationProfile,
} from '@itervane/contracts';
import { summarizeCodeRuleSamples } from '@itervane/rules';
import { sha256 } from '../../src/profiles.js';
import { canonicalRuleValidationCommand, prepareQualifiedRuleValidationRequest } from '../../src/rule-validation-command.js';

export function sealDocument<T>(document: T) { return { document, sha256: sha256(JSON.stringify(document)) }; }

function ruleFixture(language: CodeRuleLanguage, projectId: string, profile: CodeRuleValidationProfile) {
  const note = { title: 'Unavailable response', appliesTo: 'Trusted service sample', limitation: 'Review the health branch' };
  const candidate = {
    kind: 'code_rule', key: 'candidate-health-reply', text: { en: note, 'zh-CN': note },
    check: { language, engine: 'semgrep_ce', pattern: '$RESPONSE.status(503).json(...)' },
    samples: {
      violation: 'sample.status(503).json({ ok: false });',
      corrected: 'sample.status(200).json({ ok: true });',
      lookalike: 'logger.info({ status: 503 });',
    },
  };
  const identity = { candidateId: randomUUID(), extractionResultSha256: sha256('sample extraction') };
  const oldProfile = { ...profile, runnerImageSha256: sha256('historical sample image') };
  const command = canonicalRuleValidationCommand(candidate, identity, oldProfile);
  const { candidateSha256 } = command.prepared.basis;
  const plan = candidateValidationPlanSchema.parse({ version: 1, kind: 'code_rule', ...identity, candidateSha256, profile: oldProfile });
  const coordinates = { projectId, taskId: randomUUID(), runId: randomUUID(), requestId: randomUUID(),
    generation: 1, fence: 1, workspaceSha256: sha256('trusted workspace') };
  const scope = prepareQualifiedRuleValidationRequest(coordinates, command);
  const result = summarizeCodeRuleSamples(command.prepared.basis, command.prepared.basis.samples.map(file => ({
    ...file, status: 'checked', matches: file.name === 'violation' ? 1 : 0, reportSha256: sha256(file.name),
  })));
  const validation = candidateValidationRecordSchema.parse({
    version: 1, taskId: scope.taskId, runId: scope.runId, projectId, ...identity, candidateSha256,
    planSha256: sealDocument(plan).sha256, status: 'passed', evidence: {
      kind: 'code_rule', receipt: {
        kind: 'rule_samples_receipt', scope, domainId: randomUUID(), imageSha256: scope.runnerImageSha256,
        cleanupConfirmed: true, sessionVerified: true, proof: { version: 1, commandSha256: scope.commandSha256, result },
      },
    },
  });
  const pkg = codeRulePackageSchema.parse({
    formatVersion: 1, kind: 'code_rule', packageKey: 'published-health-' + language, version: '1.0.0',
    scope: { kind: 'workspace' }, source: { name: 'Trusted fixture', license: 'Apache-2.0' },
    text: { en: { title: 'Health response', description: 'Trusted fixture' }, 'zh-CN': { title: '健康响应', description: '受信样例' } },
    validation: { id: randomUUID(), sha256: sealDocument(validation).sha256, taskId: validation.taskId, projectId, ...identity,
      candidateSha256, planSha256: validation.planSha256 }, candidate,
  });
  const versionId = randomUUID();
  const versionSha256 = sealDocument(pkg).sha256;
  const review = rulePackageReviewRecordSchema.parse({
    formatVersion: 1, kind: 'candidate_review', versionId, versionSha256, reviewedBy: randomUUID(), grantId: randomUUID(),
    outcome: 'accepted', checks: { sourceAndLicense: true, scopeAndGuidance: true, validationEvidence: true },
  });
  return { rule: { package: pkg, review, validation }, entry: { packageId: randomUUID(), packageKey: pkg.packageKey, versionId,
    kind: pkg.kind, versionSha256, reviewSha256: sealDocument(review).sha256, sequence: 1 } };
}

/** Synthetic publication and sample receipt for tests. The source scanner smoke uses the real engine. */
export function publishedCodeRuleFixture(profile: CodeRuleValidationProfile, languages: readonly CodeRuleLanguage[] = ['javascript']) {
  const originProject = randomUUID();
  const rules = [...languages].sort().map(language => ruleFixture(language, originProject, profile));
  const snapshot = sealDocument(taskRuleSnapshotSchema.parse({
    version: 1, taskId: randomUUID(), projectId: randomUUID(), purpose: 'delivery', entries: rules.map(item => item.entry),
  }));
  return { version: 1, snapshot, profile, rules: rules.map(item => item.rule) };
}
