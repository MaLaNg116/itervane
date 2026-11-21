import { z } from 'zod';
import {
  auditReportSchema, deliveryRoleSchema, evidenceSchema, repairReportSchema,
  sha256, shaSchema, verificationReportSchema, type AgentOrigin, type AgentSpec,
} from './contracts.js';
import { agentText, type AgentReason, type Feedback } from './messages.js';
import { formalRepairCompletionSchema } from './repair-contracts.js';
import { finishFormalRepair, finishFormalVerification } from './results.js';
import { canCall, plannedToolSchema } from './tools.js';
import { formalVerificationCompletionSchema } from './verification-contracts.js';

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
  trace: z.array(z.object({ role: deliveryRoleSchema, operationId: shaSchema, call: plannedToolSchema, evidenceId: shaSchema }).strict()).max(28),
  stalled: z.number().int().nonnegative().max(6), feedback: z.custom<Feedback>(value => typeof value === 'string' && Object.hasOwn(feedback, value)).nullable(),
  audit: auditReportSchema.nullable(),
  repairs: z.array(repairReportSchema).max(3),
  formalRepair: formalRepairCompletionSchema.optional(),
  formalVerification: formalVerificationCompletionSchema.optional(),
  verifications: z.array(verificationReportSchema).max(3),
  stop: z.object({
    status: z.enum(['completed', 'requires_human', 'cancelled']),
    reason: z.custom<AgentReason>(value => typeof value === 'string' && Object.hasOwn(terminalReasons, value)),
  }).strict().nullable(),
}).strict();
export type AgentState = z.infer<typeof stateSchema>;
export type Stop = NonNullable<AgentState['stop']>;

export function initialRole(origin: AgentOrigin): AgentState['role'] {
  if (origin === 'formal_verification') return 'verify';
  return origin === 'formal_repair' ? 'repair' : 'audit';
}

export function initialState(spec: AgentSpec, bindingSha256: string, origin: AgentOrigin): AgentState {
  return {
    version: 1, bindingSha256, role: initialRole(origin), deadlineAt: Date.now() + spec.limits.maxDurationMs,
    usage: { turns: 0, toolCalls: 0, tokens: 0 },
    pending: null, nextTool: null, evidence: [], currentEvidence: [], trace: [],
    stalled: 0, feedback: null, audit: null, repairs: [], verifications: [], stop: null,
  };
}

export function restoreState(raw: unknown, spec: AgentSpec, binding: string, origin: AgentOrigin) {
  const parsed = stateSchema.safeParse(raw);
  if (!parsed.success) return;
  const state = parsed.data;
  const { limits } = spec;
  // An already stopped graph cannot spend more time. Preserve its result even if the wall clock moved back.
  if (state.bindingSha256 !== binding || (!state.stop && state.deadlineAt > Date.now() + limits.maxDurationMs)
    || state.usage.turns > limits.maxTurns || state.usage.toolCalls > limits.maxToolCalls
    || (!state.stop && state.usage.tokens > limits.maxTokens)
    || state.evidence.length > state.usage.toolCalls || state.trace.length > state.usage.toolCalls
    || state.repairs.length > limits.maxRepairs || state.repairs.length < state.verifications.length
    || (origin === 'trusted_fixture' && state.role !== 'audit' && state.audit === null)
    || (origin === 'trusted_fixture' && state.role === 'verify' && !state.stop && state.repairs.length !== state.verifications.length + 1)
    || (state.pending === 'observation' && !state.nextTool) || (state.pending === 'decision' && state.nextTool)) return;
  if (origin === 'formal_audit' && (state.role !== 'audit' || state.repairs.length || state.verifications.length
    || state.evidence.length !== state.currentEvidence.length
    || state.evidence.some(item => item.snapshotSha256 !== spec.snapshotSha256))) return;
  if (origin === 'formal_repair') {
    if (state.role !== 'repair' || state.audit || state.repairs.length || state.verifications.length
        || state.evidence.length !== state.currentEvidence.length || state.evidence.some(item => item.snapshotSha256 !== spec.snapshotSha256)
        || state.trace.some(item => item.role !== 'repair' || !canCall(item.role, item.call.name, origin))
        || (state.formalRepair !== undefined) !== (state.stop?.reason === 'repair_complete' && state.stop.status === 'completed')) return;
    if (state.formalRepair) {
      const { summary, evidenceId } = state.formalRepair;
      if (JSON.stringify(finishFormalRepair(state.evidence, { summary, evidenceId })) !== JSON.stringify(state.formalRepair)) return;
    }
  } else if (state.formalRepair) return;
  if (origin === 'formal_verification') {
    if (state.role !== 'verify' || state.audit || state.repairs.length || state.verifications.length
        || state.evidence.length !== state.currentEvidence.length || state.trace.length !== state.evidence.length
        || new Set(state.currentEvidence).size !== state.currentEvidence.length
        || state.evidence.some(item => item.snapshotSha256 !== spec.snapshotSha256)
        || state.trace.some(({ role, call, evidenceId }, index) => {
          const observed = state.evidence[index];
          return role !== 'verify' || call.name !== 'read_verification' || observed?.id !== evidenceId
            || observed.data.kind !== 'verification_section' || observed.data.section !== call.args.section;
        })
        || (state.formalVerification !== undefined) !== (state.stop?.reason === 'verification_review_complete' && state.stop.status === 'completed')) return;
    if (state.formalVerification) {
      const { summary, evidenceIds, followUps } = state.formalVerification;
      if (JSON.stringify(finishFormalVerification(state.evidence, { summary, evidenceIds, followUps })) !== JSON.stringify(state.formalVerification)) return;
    }
  } else if (state.formalVerification) return;
  const ids = new Set(state.evidence.map(item => item.id));
  if (ids.size !== state.evidence.length || state.evidence.some(({ id, ...receipt }) =>
    receipt.origin !== origin || receipt.bindingSha256 !== binding || sha256(JSON.stringify(receipt)) !== id)
    || state.currentEvidence.some(id => !ids.has(id)) || state.trace.some(item => !ids.has(item.evidenceId))) return;
  return state;
}

export function stopped(state: AgentState, reason: AgentReason, status: Stop['status'] = 'requires_human'): AgentState {
  return { ...state, stop: { reason, status }, pending: null, nextTool: null };
}
