import { z } from 'zod';
import {
  auditReportSchema, deliveryRoleSchema, evidenceSchema, repairReportSchema,
  sha256, shaSchema, verificationReportSchema, type AgentSpec,
} from './contracts.js';
import { agentText, type AgentReason, type Feedback } from './messages.js';
import { plannedToolSchema } from './tools.js';

const terminalReasons = agentText('en').reason;
const feedback = agentText('en').feedback;
const usageSchema = z.object({
  turns: z.number().int().nonnegative().max(40),
  toolCalls: z.number().int().nonnegative().max(28),
  tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
const stateSchema = z.object({
  version: z.literal(1), bindingSha256: shaSchema, role: deliveryRoleSchema,
  deadlineAt: z.number().int().positive(), usage: usageSchema,
  pending: z.enum(['decision', 'observation']).nullable(), nextTool: plannedToolSchema.nullable(),
  evidence: z.array(evidenceSchema).max(28),
  currentEvidence: z.array(shaSchema).max(28),
  trace: z.array(z.object({ role: deliveryRoleSchema, operationId: shaSchema, tool: z.string(), evidenceId: shaSchema }).strict()).max(28),
  stalled: z.number().int().nonnegative().max(6), feedback: z.custom<Feedback>(value => typeof value === 'string' && Object.hasOwn(feedback, value)).nullable(),
  audit: auditReportSchema.nullable(),
  repairs: z.array(repairReportSchema).max(3),
  verifications: z.array(verificationReportSchema).max(3),
  stop: z.object({
    status: z.enum(['completed', 'requires_human', 'cancelled']),
    reason: z.custom<AgentReason>(value => typeof value === 'string' && Object.hasOwn(terminalReasons, value)),
  }).strict().nullable(),
}).strict();
export type AgentState = z.infer<typeof stateSchema>;
export type Stop = NonNullable<AgentState['stop']>;

export function initialState(spec: AgentSpec, bindingSha256: string): AgentState {
  return {
    version: 1, bindingSha256, role: 'audit', deadlineAt: Date.now() + spec.limits.maxDurationMs,
    usage: { turns: 0, toolCalls: 0, tokens: 0 },
    pending: null, nextTool: null, evidence: [], currentEvidence: [], trace: [],
    stalled: 0, feedback: null, audit: null, repairs: [], verifications: [], stop: null,
  };
}

export function restoreState(raw: unknown, spec: AgentSpec, binding: string) {
  const parsed = stateSchema.safeParse(raw);
  if (!parsed.success) return;
  const state = parsed.data;
  const { limits } = spec;
  if (state.bindingSha256 !== binding || state.deadlineAt > Date.now() + limits.maxDurationMs
    || state.usage.turns > limits.maxTurns || state.usage.toolCalls > limits.maxToolCalls
    || (!state.stop && state.usage.tokens > limits.maxTokens)
    || state.evidence.length > state.usage.toolCalls || state.trace.length > state.usage.toolCalls
    || state.repairs.length > limits.maxRepairs || state.repairs.length < state.verifications.length
    || (state.role !== 'audit' && state.audit === null)
    || (state.role === 'verify' && !state.stop && state.repairs.length !== state.verifications.length + 1)
    || (state.pending === 'observation' && !state.nextTool) || (state.pending === 'decision' && state.nextTool)) return;
  const ids = new Set(state.evidence.map(item => item.id));
  if (ids.size !== state.evidence.length || state.evidence.some(({ id, ...receipt }) =>
    receipt.bindingSha256 !== binding || sha256(JSON.stringify(receipt)) !== id)
    || state.currentEvidence.some(id => !ids.has(id)) || state.trace.some(item => !ids.has(item.evidenceId))) return;
  return state;
}

export function stopped(state: AgentState, reason: AgentReason, status: Stop['status'] = 'requires_human'): AgentState {
  return { ...state, stop: { reason, status }, pending: null, nextTool: null };
}
