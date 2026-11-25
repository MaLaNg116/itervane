import { finishOperationsInputSchema, finishRuleExtractionInputSchema, operationsDiagnosisSections, operationsDiagnosisSectionSchema,
  requiredAuditScanners, type Locale } from '@itervane/contracts';
import type { ToolDefinition } from '@itervane/model';
import { z } from 'zod';
import {
  auditScannerSchema, checkKindSchema, completionSchemas, contextSectionSchema, formalReceiptSchema, formalRepairReceiptSchema,
  formalOperationsReceiptSchema, formalRuleExtractionReceiptSchema, formalVerificationReceiptSchema, keySchema,
  receiptSchema, sha256, templateIdsSchema, type AgentEvidence, type AgentOrigin, type AuditReport, type Candidate, type AgentRole,
} from './contracts.js';
import { agentText } from './messages.js';
import { missingOperationsSections } from './operations-results.js';
import { editableRepairTarget, finishRepairInputSchema, repairToolInputs, repairToolNames } from './repair-contracts.js';
import { finishVerificationInputSchema, pendingVerificationSections, verificationSectionSchema } from './verification-contracts.js';

export const emptyArguments = z.object({}).strict();
const inputs = {
  read_context: z.object({ section: contextSectionSchema }).strict(),
  read_rule: z.object({ ruleId: keySchema }).strict(),
  read_findings: emptyArguments,
  read_scan: z.object({ scanner: auditScannerSchema }).strict(),
  read_health_reproduction: emptyArguments,
  draft_repair: z.object({ templateIds: templateIdsSchema }).strict(),
  read_candidate: emptyArguments,
  check_candidate: z.object({ check: checkKindSchema }).strict(),
  read_verification: z.strictObject({ section: verificationSectionSchema }),
  read_operations: z.strictObject({ section: operationsDiagnosisSectionSchema }),
  read_learning_case: emptyArguments,
  search_learning_knowledge: emptyArguments,
  ...repairToolInputs,
};
const names = ['read_context', 'read_rule', 'read_findings', 'read_scan', 'read_health_reproduction', 'draft_repair', 'read_candidate', 'check_candidate',
  'read_verification', 'read_operations', 'read_learning_case', 'search_learning_knowledge', ...repairToolNames] as const;
export type AgentToolName = typeof names[number];
const roles: Record<AgentToolName, readonly AgentRole[]> = {
  read_context: ['audit', 'repair'], read_rule: ['audit', 'repair'], read_findings: ['audit'], read_scan: [], read_health_reproduction: [],
  draft_repair: ['repair'], read_candidate: ['verify'], check_candidate: ['verify'],
  read_repair_targets: [], apply_repair_template: [], apply_repair_patch: [], read_verification: [], read_operations: [],
  read_learning_case: [], search_learning_knowledge: [],
};
export const plannedToolSchema = z.discriminatedUnion('name', [
  z.object({ name: z.literal('read_context'), args: inputs.read_context }).strict(),
  z.object({ name: z.literal('read_rule'), args: inputs.read_rule }).strict(),
  z.object({ name: z.literal('read_findings'), args: inputs.read_findings }).strict(),
  z.object({ name: z.literal('read_scan'), args: inputs.read_scan }).strict(),
  z.strictObject({ name: z.literal('read_health_reproduction'), args: inputs.read_health_reproduction }),
  z.object({ name: z.literal('draft_repair'), args: inputs.draft_repair }).strict(),
  z.object({ name: z.literal('read_candidate'), args: inputs.read_candidate }).strict(),
  z.object({ name: z.literal('check_candidate'), args: inputs.check_candidate }).strict(),
  z.strictObject({ name: z.literal('read_verification'), args: inputs.read_verification }),
  z.strictObject({ name: z.literal('read_operations'), args: inputs.read_operations }),
  z.strictObject({ name: z.literal('read_learning_case'), args: inputs.read_learning_case }),
  z.strictObject({ name: z.literal('search_learning_knowledge'), args: inputs.search_learning_knowledge }),
  z.strictObject({ name: z.literal('read_repair_targets'), args: inputs.read_repair_targets }),
  z.strictObject({ name: z.literal('apply_repair_template'), args: inputs.apply_repair_template }),
  z.strictObject({ name: z.literal('apply_repair_patch'), args: inputs.apply_repair_patch }),
]);
export type PlannedTool = z.infer<typeof plannedToolSchema>;
export function canCall(role: AgentRole, name: AgentToolName, origin: AgentOrigin) {
  if (origin === 'formal_audit') return role === 'audit' && (name === 'read_scan' || name === 'read_rule' || name === 'read_health_reproduction');
  if (origin === 'formal_repair') return role === 'repair' && repairToolNames.some(tool => tool === name);
  if (origin === 'formal_verification') return role === 'verify' && name === 'read_verification';
  if (origin === 'formal_operations') return role === 'operations' && name === 'read_operations';
  if (origin === 'formal_rule_extraction') return role === 'rule-extraction' && (name === 'read_learning_case' || name === 'search_learning_knowledge');
  return roles[name].includes(role);
}

export function repairActionSha256(call: PlannedTool) {
  if (call.name === 'read_repair_targets') return sha256(JSON.stringify({ ...call, args: { findingIds: [...call.args.findingIds].sort() } }));
  if (call.name === 'apply_repair_patch') {
    const targets = call.args.targets.toSorted((left, right) => left.targetIndex - right.targetIndex)
      .map(target => ({ ...target, edits: target.edits?.toSorted((left, right) => left.startByte - right.startByte) }));
    return sha256(JSON.stringify({ ...call, args: { ...call.args, targets } }));
  }
  return sha256(JSON.stringify(call));
}

export function hasObservation(evidence: readonly AgentEvidence[], call: PlannedTool) {
  return evidence.some(({ data }) => {
    switch (call.name) {
      case 'read_context': return data.kind === 'context' && data.section === call.args.section;
      case 'read_rule': return data.kind === 'rule' && data.ruleId === call.args.ruleId;
      case 'read_findings': return data.kind === 'findings';
      case 'read_scan': return data.kind === 'scan' && data.scanner === call.args.scanner;
      case 'read_health_reproduction': return data.kind === 'health_reproduction';
      case 'read_candidate': return data.kind === 'candidate';
      case 'check_candidate': return data.kind === 'check' && data.result.check === call.args.check;
      case 'read_verification': return data.kind === 'verification_section' && data.section === call.args.section;
      case 'read_operations': return data.kind === 'operations_section' && data.section === call.args.section;
      case 'read_learning_case': return data.kind === 'learning_case';
      case 'search_learning_knowledge': return data.kind === 'learning_knowledge';
      case 'draft_repair': return data.kind === 'candidate' && data.candidate.templateIds.length === call.args.templateIds.length
        && call.args.templateIds.every(id => data.candidate.templateIds.includes(id));
      case 'read_repair_targets': case 'apply_repair_template': case 'apply_repair_patch':
        return 'actionSha256' in data && data.actionSha256 === repairActionSha256(call);
    }
  });
}

function formalCompletionSchema(evidence: readonly AgentEvidence[], hypothesisGuidance: string, minimum: number) {
  const findingIds = evidence.flatMap(({ data }) => data.kind === 'scan' ? data.findings.map(item => item.id) : []);
  const audit = completionSchemas.audit;
  const explanation = audit.shape.explanations.element;
  return audit.extend({
    evidenceIds: z.array(z.enum(evidence.map(item => item.id))).min(minimum).max(evidence.length),
    explanations: z.array(findingIds.length ? explanation.extend({ findingId: z.enum(findingIds) }) : explanation).length(findingIds.length),
    hypotheses: audit.shape.hypotheses.describe(hypothesisGuidance),
  });
}

function verificationCompletionInputs(evidence: readonly AgentEvidence[]) {
  const ids = evidence.map(item => item.id);
  const schema = finishVerificationInputSchema;
  return schema.extend({
    evidenceIds: z.array(z.enum(ids)).length(ids.length),
    followUps: z.array(schema.shape.followUps.element.extend({ evidenceId: z.enum(ids) })).max(4),
  });
}

function operationsCompletionInputs(evidence: readonly AgentEvidence[]) {
  const evidenceIds = z.array(z.enum(evidence.map(item => item.id))).min(1).max(operationsDiagnosisSections.length);
  return finishOperationsInputSchema.extend({
    hypotheses: z.array(finishOperationsInputSchema.shape.hypotheses.element.extend({ evidenceIds })).max(3),
    recommendation: finishOperationsInputSchema.shape.recommendation.extend({ evidenceIds }),
  });
}

export function toolDefinitions(locale: Locale, role: AgentRole, evidence: readonly AgentEvidence[],
  origin: AgentOrigin, ruleIds: readonly string[] = [], repairFindingIds: readonly string[] = [], linkedHealth = false,
  publishedCode = false): ToolDefinition[] {
  const messages = agentText(locale);
  const text = messages.tool;
  const formal = origin === 'formal_audit';
  const sections = contextSectionSchema.options.filter(section => !hasObservation(evidence, { name: 'read_context', args: { section } }));
  const checks = checkKindSchema.options.filter(check => !hasObservation(evidence, { name: 'check_candidate', args: { check } }));
  const requiredScanners = requiredAuditScanners(publishedCode);
  const scanners = requiredScanners.filter(scanner => !hasObservation(evidence, { name: 'read_scan', args: { scanner } }));
  const pendingReproduction = linkedHealth && !hasObservation(evidence, { name: 'read_health_reproduction', args: {} });
  const rules = ruleIds.filter(ruleId => !hasObservation(evidence, { name: 'read_rule', args: { ruleId } }));
  const pendingVerification = origin === 'formal_verification' ? pendingVerificationSections(evidence) : [];
  const pendingOperations = origin === 'formal_operations' ? missingOperationsSections(evidence) : [];
  const observations = evidence.flatMap(({ id, data }) => data.kind === 'repair_targets' ? [{ id, targets: data.observation.targets }] : []);
  const candidates = evidence.flatMap(({ id, data }) => data.kind === 'repair_candidate' ? [id] : []);
  const remaining = repairFindingIds.filter(id => !observations.some(item => item.targets.some(target => target.findingId === id)));
  const editable = candidates.length ? [] : observations.filter(item => item.targets.some(target => editableRepairTarget(target))).map(item => item.id);
  const templates = candidates.length ? [] : observations.filter(item => item.targets.some(target => target.templates.length)).map(item => item.id);
  const availableInputs = {
    ...inputs,
    read_context: sections.length ? z.object({ section: z.enum(sections) }).strict() : null,
    read_rule: origin === 'trusted_fixture' ? inputs.read_rule : rules.length ? z.strictObject({ ruleId: z.enum(rules) }) : null,
    read_findings: hasObservation(evidence, { name: 'read_findings', args: {} }) ? null : inputs.read_findings,
    read_scan: scanners.length ? z.strictObject({ scanner: z.enum(scanners) }) : null,
    read_health_reproduction: pendingReproduction ? inputs.read_health_reproduction : null,
    read_learning_case: hasObservation(evidence, { name: 'read_learning_case', args: {} }) ? null : inputs.read_learning_case,
    search_learning_knowledge: hasObservation(evidence, { name: 'search_learning_knowledge', args: {} }) ? null : inputs.search_learning_knowledge,
    read_candidate: hasObservation(evidence, { name: 'read_candidate', args: {} }) ? null : inputs.read_candidate,
    check_candidate: checks.length ? z.object({ check: z.enum(checks) }).strict() : null,
    read_verification: pendingVerification.length ? z.strictObject({ section: z.enum(pendingVerification) }) : null,
    read_operations: pendingOperations.length ? z.strictObject({ section: z.enum(pendingOperations) }) : null,
    read_repair_targets: remaining.length && !candidates.length ? inputs.read_repair_targets.extend({
      findingIds: z.array(z.enum(remaining)).min(1).max(4),
    }) : null,
    apply_repair_template: templates.length ? inputs.apply_repair_template.extend({ observationId: z.enum(templates) }) : null,
    apply_repair_patch: editable.length ? inputs.apply_repair_patch.extend({ observationId: z.enum(editable) }) : null,
  };
  const available = names.flatMap(name => {
    const schema = availableInputs[name];
    return canCall(role, name, origin) && schema ? [{ name, description: text[name], inputSchema: z.toJSONSchema(schema, { io: 'input' }) }] : [];
  });
  let finish: z.ZodType | null;
  let finishDescription: string = text.finish_role;
  if (formal) {
    finish = role === 'audit' && scanners.length === 0 && !pendingReproduction
      ? formalCompletionSchema(evidence, messages.formal.hypotheses, requiredScanners.length) : null;
    finishDescription = messages.formal.finish;
  } else if (origin === 'formal_repair') {
    finish = candidates.length ? finishRepairInputSchema.extend({ evidenceId: z.enum(candidates) }) : null;
    finishDescription = messages.formalRepair.finish;
  } else if (origin === 'formal_verification') {
    finish = role === 'verify' && evidence.length >= 3 && pendingVerification.length === 0 ? verificationCompletionInputs(evidence) : null;
    finishDescription = messages.formalVerification.finish;
  } else if (origin === 'formal_operations') {
    finish = role === 'operations' && !pendingOperations.includes('container') && !pendingOperations.includes('release')
      ? operationsCompletionInputs(evidence) : null;
    finishDescription = messages.formalOperations.finish;
  } else if (origin === 'formal_rule_extraction') {
    finish = role === 'rule-extraction' && evidence.length === 2 ? finishRuleExtractionInputSchema : null;
    finishDescription = messages.formalRuleExtraction.finish;
  } else finish = role === 'operations' || role === 'rule-extraction' ? null : completionSchemas[role];
  return [
    ...available,
    ...(finish ? [{ name: 'finish_role', description: finishDescription,
      inputSchema: z.toJSONSchema(finish, { io: 'input' }) }] : []),
    { name: 'request_human', description: text.request_human, inputSchema: z.toJSONSchema(emptyArguments, { io: 'input' }) },
  ];
}

const receipts = {
  trusted_fixture: receiptSchema,
  formal_audit: formalReceiptSchema,
  formal_repair: formalRepairReceiptSchema,
  formal_verification: formalVerificationReceiptSchema,
  formal_operations: formalOperationsReceiptSchema,
  formal_rule_extraction: formalRuleExtractionReceiptSchema,
};

export function acceptReceipt(raw: unknown, expected: {
  origin: AgentOrigin; bindingSha256: string; snapshotSha256: string; call: PlannedTool; audit: AuditReport | null; candidate: Candidate | null;
  evidence?: readonly AgentEvidence[];
}): AgentEvidence | undefined {
  const result = receipts[expected.origin].safeParse(raw);
  if (!result.success) return;
  const receipt = result.data;
  if (receipt.bindingSha256 !== expected.bindingSha256 || receipt.snapshotSha256 !== expected.snapshotSha256) return;
  const serialized = JSON.stringify(receipt);
  if (Buffer.byteLength(serialized) > 12_288) return;
  const { data } = receipt;
  const { call, audit, candidate } = expected;
  switch (call.name) {
    case 'read_context': if (data.kind !== 'context' || data.section !== call.args.section) return; break;
    case 'read_rule': if (data.kind !== 'rule' || data.ruleId !== call.args.ruleId) return; break;
    case 'read_findings': if (data.kind !== 'findings') return; break;
    case 'read_scan': if (data.kind !== 'scan' || data.scanner !== call.args.scanner) return; break;
    case 'read_health_reproduction': if (data.kind !== 'health_reproduction') return; break;
    case 'draft_repair': {
      if (data.kind !== 'candidate' || !audit || data.candidate.baseSha256 !== expected.snapshotSha256
        || !data.candidate.findingIds.length || !data.candidate.findingIds.every(id => audit.findings.some(finding => finding.id === id))
        || JSON.stringify([...data.candidate.templateIds].sort()) !== JSON.stringify([...call.args.templateIds].sort())) return;
      break;
    }
    case 'read_candidate': if (data.kind !== 'candidate' || !candidate || JSON.stringify(data.candidate) !== JSON.stringify(candidate)) return; break;
    case 'check_candidate': if (data.kind !== 'check' || data.result.check !== call.args.check) return; break;
    case 'read_verification': if (data.kind !== 'verification_section' || data.section !== call.args.section) return; break;
    case 'read_operations': if (data.kind !== 'operations_section' || data.section !== call.args.section) return; break;
    case 'read_learning_case': if (data.kind !== 'learning_case') return; break;
    case 'search_learning_knowledge': if (data.kind !== 'learning_knowledge') return; break;
    case 'read_repair_targets': {
      if (data.kind === 'repair_failure' && data.action === call.name && data.actionSha256 === repairActionSha256(call)) break;
      if (data.kind !== 'repair_targets' || data.actionSha256 !== repairActionSha256(call)
          || data.observation.baseSnapshotSha256 !== expected.snapshotSha256) return;
      const returned = [...new Set(data.observation.targets.map(item => item.findingId))].sort();
      if (JSON.stringify(returned) !== JSON.stringify([...call.args.findingIds].sort())) return;
      break;
    }
    case 'apply_repair_template': case 'apply_repair_patch': {
      if (data.kind === 'repair_failure' && data.action === call.name && data.actionSha256 === repairActionSha256(call)) break;
      if (data.kind !== 'repair_candidate' || data.action !== call.name || data.actionSha256 !== repairActionSha256(call)
          || data.candidate.baseSnapshotSha256 !== expected.snapshotSha256 || data.observationId !== call.args.observationId
          || !expected.evidence?.some(value => value.id === data.observationId && value.data.kind === 'repair_targets')) return;
      break;
    }
  }
  return { ...receipt, id: sha256(serialized) };
}
