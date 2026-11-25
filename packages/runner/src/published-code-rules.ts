import {
  candidateValidationPlanSchema, codeRuleLanguageSchema, publishedCodeRuleSetSchema,
  type PublishedCodeRuleSet, type TaskRuleSnapshot,
} from '@itervane/contracts';
import { compileSemgrepRule } from '@itervane/rules';
import { sha256 } from './profiles.js';
import { canonicalRuleValidationCommand, prepareQualifiedRuleValidationRequest, verifyQualifiedRuleValidationReceipt } from './rule-validation-command.js';

function verifyPublishedRule(
  rule: PublishedCodeRuleSet['rules'][number],
  entry: TaskRuleSnapshot['entries'][number],
  projectId: string,
  currentProfile: PublishedCodeRuleSet['profile'],
) {
  const { package: document, review, validation } = rule;
  if (document.packageKey !== entry.packageKey || sha256(JSON.stringify(document)) !== entry.versionSha256
      || (document.scope.kind === 'project' && (document.scope.projectId !== projectId
        || document.scope.projectId !== document.validation.projectId))
      || review.kind !== 'candidate_review' || review.outcome !== 'accepted'
      || review.versionId !== entry.versionId || review.versionSha256 !== entry.versionSha256
      || sha256(JSON.stringify(review)) !== entry.reviewSha256) throw new Error('published_code_rule_version_binding');

  const { candidateId, extractionResultSha256, candidateSha256, planSha256 } = document.validation;
  if (validation.status !== 'passed' || validation.evidence.kind !== 'code_rule'
      || sha256(JSON.stringify(validation)) !== document.validation.sha256 || validation.taskId !== document.validation.taskId
      || validation.projectId !== document.validation.projectId || validation.candidateId !== candidateId
      || validation.extractionResultSha256 !== extractionResultSha256 || validation.candidateSha256 !== candidateSha256
      || validation.planSha256 !== planSha256 || sha256(JSON.stringify(document.candidate)) !== candidateSha256) {
    throw new Error('published_code_rule_validation_binding');
  }

  // Rebuilding an image is compatible with a prior validation only while the exact Semgrep inputs agree.
  const { receipt } = validation.evidence;
  const profile = { ...currentProfile, runnerImageSha256: receipt.scope.runnerImageSha256 };
  const plan = candidateValidationPlanSchema.parse({ version: 1, kind: 'code_rule', candidateId, extractionResultSha256, candidateSha256, profile });
  if (sha256(JSON.stringify(plan)) !== planSha256 || receipt.scope.taskId !== validation.taskId
      || receipt.scope.runId !== validation.runId || receipt.scope.projectId !== validation.projectId) {
    throw new Error('published_code_rule_validation_profile');
  }
  const command = canonicalRuleValidationCommand(document.candidate, { candidateId, extractionResultSha256 }, profile);
  const request = prepareQualifiedRuleValidationRequest(receipt.scope, command);
  verifyQualifiedRuleValidationReceipt(receipt, request, command);
  return compileSemgrepRule(entry.packageKey, document.candidate.check);
}

/** The caller supplies the authoritative task snapshot and its exact version, review and validation rows. */
export function preparePublishedCodeRules(raw: unknown) {
  const input = publishedCodeRuleSetSchema.parse(raw);
  const { sha256: snapshotSha256, document } = input.snapshot;
  const entries = document.entries.filter(item => item.kind === 'code_rule');
  if (document.purpose !== 'delivery' || sha256(JSON.stringify(document)) !== snapshotSha256 || entries.length !== input.rules.length) {
    throw new Error('published_code_rule_snapshot_binding');
  }
  const rules = input.rules.map((rule, index) => verifyPublishedRule(rule, entries[index]!, document.projectId, input.profile));
  const groups = codeRuleLanguageSchema.options.flatMap(language => {
    const selected = rules.filter(rule => rule.languages[0] === language);
    if (!selected.length) return [];
    const config = JSON.stringify({ rules: selected });
    return [{ language, config, configSha256: sha256(config), ruleKeys: selected.map(rule => rule.id) }];
  });
  return { input, sha256: sha256(JSON.stringify(input)), groups };
}
export type PreparedPublishedCodeRules = ReturnType<typeof preparePublishedCodeRules>;
