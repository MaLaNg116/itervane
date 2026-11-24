import { codeRuleCandidateSchema, codeRuleValidationCommandSchema, qualifiedRuleValidationRequestSchema, ruleValidationCommandByteLimit, type QualifiedRuleValidationReceipt,
  type QualifiedRuleValidationRequest } from '@itervane/contracts';
import { prepareCodeRuleValidation, summarizeCodeRuleSamples } from '@itervane/rules';
import { sha256 } from './profiles.js';

type CandidateReference = Parameters<typeof prepareCodeRuleValidation>[1];
export type RuleValidationCoordinates = Pick<QualifiedRuleValidationRequest, 'requestId' | 'taskId' | 'runId' | 'projectId' | 'generation' | 'fence' | 'workspaceSha256'>;

export function canonicalRuleValidationCommand(raw: unknown, reference: CandidateReference, profile: unknown) {
  const candidate = codeRuleCandidateSchema.parse(raw);
  const prepared = prepareCodeRuleValidation(candidate, reference, profile);
  const command = codeRuleValidationCommandSchema.parse({ version: 1, basis: prepared.basis, candidate });
  const bytes = Buffer.from(JSON.stringify(command), 'utf8');
  if (bytes.length > ruleValidationCommandByteLimit) throw new Error('rule_validation_command_size');
  return { bytes, prepared };
}

export function readRuleValidationCommand(bytes: Buffer) {
  if (bytes.length === 0 || bytes.length > ruleValidationCommandByteLimit) throw new Error('rule_validation_command_size');
  const command = codeRuleValidationCommandSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  const canonical = canonicalRuleValidationCommand(command.candidate, {
    candidateId: command.basis.candidateId, extractionResultSha256: command.basis.extractionResultSha256,
  }, command.basis.profile);
  if (!canonical.bytes.equals(bytes)) throw new Error('rule_validation_command_integrity');
  return canonical.prepared;
}

export function prepareQualifiedRuleValidationRequest(coordinates: RuleValidationCoordinates, command: ReturnType<typeof canonicalRuleValidationCommand>) {
  const { profile } = command.prepared.basis;
  return qualifiedRuleValidationRequestSchema.parse({ ...coordinates, version: 1, operation: 'validate_rule_samples',
    runnerImageSha256: profile.runnerImageSha256, basisSha256: command.prepared.sha256, engineInputsSha256: profile.engineInputsSha256,
    commandSha256: sha256(command.bytes), commandBytes: command.bytes.length,
  });
}

export function verifyQualifiedRuleValidationReceipt(receipt: QualifiedRuleValidationReceipt, request: QualifiedRuleValidationRequest,
  command: ReturnType<typeof canonicalRuleValidationCommand>) {
  const { result } = receipt.proof;
  const expected = summarizeCodeRuleSamples(command.prepared.basis, result.samples);
  if (JSON.stringify(receipt.scope) !== JSON.stringify(request) || receipt.imageSha256 !== request.runnerImageSha256
      || request.commandSha256 !== sha256(command.bytes) || receipt.proof.commandSha256 !== request.commandSha256
      || result.basisSha256 !== request.basisSha256 || JSON.stringify(result) !== JSON.stringify(expected)) {
    throw new Error('runner_rule_validation_receipt_binding');
  }
}
