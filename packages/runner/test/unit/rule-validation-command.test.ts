import { randomUUID } from 'node:crypto';
import { qualifiedRuleValidationRequestSchema, qualifiedRuleValidationResponseSchema } from '@itervane/contracts';
import { expect, it } from 'vitest';
import { canonicalRuleValidationCommand, readRuleValidationCommand, verifyQualifiedRuleValidationReceipt } from '../../src/rule-validation-command.js';
import { sha256 } from '../../src/profiles.js';

const note = { title: 'Unavailable response', appliesTo: 'Example application', limitation: 'Review the maintenance branch' };
const candidate = {
  kind: 'code_rule', key: 'unavailable-health-response', text: { en: note, 'zh-CN': note },
  check: { language: 'javascript', engine: 'semgrep_ce', pattern: '$RESPONSE.status(503).json(...)' },
  samples: {
    violation: 'result.status(503).json({ reason: "unavailable" });',
    corrected: 'result.status(200).json({ reason: "healthy" });',
    lookalike: 'console.log(503);',
  },
};
const profile = {
  version: 1, engine: 'semgrep_ce', engineVersion: '1.170.0',
  runnerImageSha256: sha256('sealed image'), engineInputsSha256: sha256('sealed tool directory'),
};
const reference = { candidateId: randomUUID(), extractionResultSha256: sha256('selected extraction') };

it('rebuilds the candidate and evidence basis from the exact command before guest dispatch', () => {
  const command = canonicalRuleValidationCommand(candidate, reference, profile);
  expect(readRuleValidationCommand(command.bytes)).toEqual(command.prepared);
  const altered = JSON.parse(command.bytes.toString('utf8'));
  altered.basis.profile.engineVersion = '1.0.0';
  altered.candidate.samples.violation = candidate.samples.lookalike;
  expect(() => readRuleValidationCommand(Buffer.from(JSON.stringify(altered)))).toThrow();
  expect(() => readRuleValidationCommand(Buffer.concat([command.bytes, Buffer.from('\n')]))).toThrow('rule_validation_command_integrity');
});

it('admits only a cleaned receipt with exact scope, complete samples and an independently recomputed outcome', () => {
  const command = canonicalRuleValidationCommand(candidate, reference, profile);
  const scope = qualifiedRuleValidationRequestSchema.parse({
    version: 1, operation: 'validate_rule_samples', requestId: randomUUID(), taskId: randomUUID(), runId: randomUUID(), projectId: randomUUID(),
    generation: 1, fence: 2, runnerImageSha256: profile.runnerImageSha256, engineInputsSha256: profile.engineInputsSha256,
    workspaceSha256: sha256('assigned workspace'), basisSha256: command.prepared.sha256,
    commandBytes: command.bytes.length, commandSha256: sha256(command.bytes),
  });
  const samples = command.prepared.basis.samples.map(sample => ({
    ...sample, status: 'checked', reportSha256: sha256(sample.name), matches: sample.name === 'violation' ? 1 : 0,
  }));
  const parsed = qualifiedRuleValidationResponseSchema.parse({
    kind: 'rule_samples_receipt', scope, domainId: randomUUID(), imageSha256: scope.runnerImageSha256, cleanupConfirmed: true, sessionVerified: true,
    proof: { version: 1, commandSha256: scope.commandSha256, result: { version: 1, status: 'passed', basisSha256: scope.basisSha256, samples } },
  });
  if (parsed.kind !== 'rule_samples_receipt') throw new Error('Unexpected native receipt fixture');
  expect(() => verifyQualifiedRuleValidationReceipt(parsed, scope, command)).not.toThrow();
  expect(() => verifyQualifiedRuleValidationReceipt({ ...parsed, scope: { ...scope, fence: 1 } }, scope, command)).toThrow();
  expect(() => verifyQualifiedRuleValidationReceipt({ ...parsed, imageSha256: sha256('replaced image') }, scope, command)).toThrow();
  const claimed = { ...parsed, proof: { ...parsed.proof, result: { ...parsed.proof.result, status: 'failed' as const } } };
  expect(() => verifyQualifiedRuleValidationReceipt(claimed, scope, command)).toThrow('runner_rule_validation_receipt_binding');
  expect(qualifiedRuleValidationResponseSchema.safeParse({ ...parsed, cleanupConfirmed: false }).success).toBe(false);
  expect(qualifiedRuleValidationResponseSchema.safeParse({ ...parsed, proof: { ...parsed.proof, result: {
    ...parsed.proof.result, samples: samples.slice(0, 2),
  } } }).success).toBe(false);
});
