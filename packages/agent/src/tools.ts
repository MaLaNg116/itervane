import type { Locale } from '@itervane/contracts';
import type { ToolDefinition } from '@itervane/model';
import { z } from 'zod';
import {
  checkKindSchema, completionSchemas, contextSectionSchema, keySchema, receiptSchema, sha256, templateIdsSchema,
  type AgentEvidence, type AuditReport, type Candidate, type DeliveryRole,
} from './contracts.js';
import { agentText } from './messages.js';

export const emptyArguments = z.object({}).strict();
const inputs = {
  read_context: z.object({ section: contextSectionSchema }).strict(),
  read_rule: z.object({ ruleId: keySchema }).strict(),
  read_findings: emptyArguments,
  draft_repair: z.object({ templateIds: templateIdsSchema }).strict(),
  read_candidate: emptyArguments,
  check_candidate: z.object({ check: checkKindSchema }).strict(),
};
const names = ['read_context', 'read_rule', 'read_findings', 'draft_repair', 'read_candidate', 'check_candidate'] as const;
export type AgentToolName = typeof names[number];
const roles: Record<AgentToolName, readonly DeliveryRole[]> = {
  read_context: ['audit', 'repair'], read_rule: ['audit', 'repair'], read_findings: ['audit'],
  draft_repair: ['repair'], read_candidate: ['verify'], check_candidate: ['verify'],
};
export const plannedToolSchema = z.discriminatedUnion('name', [
  z.object({ name: z.literal('read_context'), args: inputs.read_context }).strict(),
  z.object({ name: z.literal('read_rule'), args: inputs.read_rule }).strict(),
  z.object({ name: z.literal('read_findings'), args: inputs.read_findings }).strict(),
  z.object({ name: z.literal('draft_repair'), args: inputs.draft_repair }).strict(),
  z.object({ name: z.literal('read_candidate'), args: inputs.read_candidate }).strict(),
  z.object({ name: z.literal('check_candidate'), args: inputs.check_candidate }).strict(),
]);
export type PlannedTool = z.infer<typeof plannedToolSchema>;
export const canCall = (role: DeliveryRole, name: AgentToolName) => roles[name].includes(role);

export function hasObservation(evidence: readonly AgentEvidence[], call: PlannedTool) {
  return evidence.some(({ data }) => {
    switch (call.name) {
      case 'read_context': return data.kind === 'context' && data.section === call.args.section;
      case 'read_rule': return data.kind === 'rule' && data.ruleId === call.args.ruleId;
      case 'read_findings': return data.kind === 'findings';
      case 'read_candidate': return data.kind === 'candidate';
      case 'check_candidate': return data.kind === 'check' && data.result.check === call.args.check;
      case 'draft_repair': return data.kind === 'candidate' && data.candidate.templateIds.length === call.args.templateIds.length
        && call.args.templateIds.every(id => data.candidate.templateIds.includes(id));
    }
  });
}

export function toolDefinitions(locale: Locale, role: DeliveryRole, evidence: readonly AgentEvidence[]): ToolDefinition[] {
  const text = agentText(locale).tool;
  const sections = contextSectionSchema.options.filter(section => !hasObservation(evidence, { name: 'read_context', args: { section } }));
  const checks = checkKindSchema.options.filter(check => !hasObservation(evidence, { name: 'check_candidate', args: { check } }));
  const availableInputs = {
    ...inputs,
    read_context: sections.length ? z.object({ section: z.enum(sections) }).strict() : null,
    read_findings: hasObservation(evidence, { name: 'read_findings', args: {} }) ? null : inputs.read_findings,
    read_candidate: hasObservation(evidence, { name: 'read_candidate', args: {} }) ? null : inputs.read_candidate,
    check_candidate: checks.length ? z.object({ check: z.enum(checks) }).strict() : null,
  };
  const available = names.flatMap(name => {
    const schema = availableInputs[name];
    return canCall(role, name) && schema ? [{ name, description: text[name], inputSchema: z.toJSONSchema(schema, { io: 'input' }) }] : [];
  });
  return [
    ...available,
    { name: 'finish_role', description: text.finish_role, inputSchema: z.toJSONSchema(completionSchemas[role], { io: 'input' }) },
    { name: 'request_human', description: text.request_human, inputSchema: z.toJSONSchema(emptyArguments, { io: 'input' }) },
  ];
}

export function acceptReceipt(raw: unknown, expected: {
  bindingSha256: string; snapshotSha256: string; call: PlannedTool; audit: AuditReport | null; candidate: Candidate | null;
}): AgentEvidence | undefined {
  const result = receiptSchema.safeParse(raw);
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
    case 'draft_repair': {
      if (data.kind !== 'candidate' || !audit || data.candidate.baseSha256 !== expected.snapshotSha256
        || !data.candidate.findingIds.length || !data.candidate.findingIds.every(id => audit.findings.some(finding => finding.id === id))
        || JSON.stringify([...data.candidate.templateIds].sort()) !== JSON.stringify([...call.args.templateIds].sort())) return;
      break;
    }
    case 'read_candidate': if (data.kind !== 'candidate' || !candidate || JSON.stringify(data.candidate) !== JSON.stringify(candidate)) return; break;
    case 'check_candidate': if (data.kind !== 'check' || data.result.check !== call.args.check) return; break;
  }
  return { ...receipt, id: sha256(serialized) };
}
