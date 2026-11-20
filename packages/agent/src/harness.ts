import { Annotation, END, START, StateGraph, type BaseCheckpointSaver } from '@langchain/langgraph';
import type { ConversationEntry, ModelAdapter } from '@itervane/model';
import {
  agentSpecSchema, auditScannerSchema, checkKinds, sha256, type AgentSpec, type AgentEvidence, type AgentOrigin,
  type Candidate, type AuditReport, type DeliveryRole,
} from './contracts.js';
import { agentPrompt, agentText, type AgentReason, type Feedback } from './messages.js';
import { finishAudit, finishFormalAudit, finishRepair, finishVerify } from './results.js';
import { initialState, restoreState, stopped, type AgentState, type Stop } from './state.js';
import { acceptReceipt, canCall, emptyArguments, hasObservation, plannedToolSchema, toolDefinitions, type PlannedTool } from './tools.js';

export type AgentScope = Readonly<{
  spec: Readonly<AgentSpec>; bindingSha256: string; snapshotSha256: string; role: DeliveryRole; origin: AgentOrigin;
}>;
export interface AgentHost {
  authorize(scope: AgentScope, signal: AbortSignal): Promise<boolean>;
  observe(input: {
    scope: AgentScope; call: PlannedTool; operationId: string;
    candidate: Candidate | null; audit: AuditReport | null; signal: AbortSignal;
  }): Promise<unknown>;
}
export type AgentFixtureHost = AgentHost;
type HarnessOptions = { model: ModelAdapter; checkpointer: BaseCheckpointSaver; host: AgentHost };
type FormalAuditProfile = { origin: 'formal_audit'; inputSha256: string; providerSha256: string; ruleIds: readonly string[] };
type HarnessProfile = { origin: 'trusted_fixture' } | FormalAuditProfile;
export type AgentRunOptions = { signal?: AbortSignal; pauseAfter?: 'decision' | 'reservation' };
type AgentStatus = Stop['status'] | 'paused';
const graphState = Annotation.Root({ state: Annotation<AgentState>() });

function agentReport<Origin extends AgentOrigin>(origin: Origin, spec: AgentSpec, bindingSha256: string,
  status: AgentStatus, reason: AgentReason, state?: AgentState) {
  const visible = reason === 'permission_denied' ? undefined : state;
  return {
    runId: spec.runId, status, reason, message: agentText(spec.locale).reason[reason],
    origin, releaseEligible: false as const, bindingSha256,
    role: state?.role ?? 'audit', usage: state?.usage ?? { turns: 0, toolCalls: 0, tokens: 0 },
    trace: visible?.trace.map(({ call, ...item }) => ({ ...item, tool: call.name })) ?? [], evidence: visible?.evidence ?? [],
    audit: visible?.audit ?? null, repairs: visible?.repairs ?? [], verifications: visible?.verifications ?? [],
  };
}
export type AgentFixtureReport = ReturnType<typeof agentReport<'trusted_fixture'>>;

function bounded<T>(signal: AbortSignal, start: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.throwIfAborted();
    signal.addEventListener('abort', abort, { once: true });
    void Promise.resolve().then(() => {
      signal.throwIfAborted();
      return start();
    }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function currentEvidence(state: AgentState) {
  return state.evidence.filter(item => state.currentEvidence.includes(item.id));
}

function missingObservations(role: DeliveryRole, entries: AgentEvidence[], origin: AgentOrigin) {
  if (origin === 'formal_audit') return auditScannerSchema.options.filter(scanner =>
    !hasObservation(entries, { name: 'read_scan', args: { scanner } }));
  if (role === 'audit') return entries.some(item => item.data.kind === 'findings') ? [] : ['read_findings'];
  if (role === 'repair') return entries.some(item => item.data.kind === 'candidate') ? [] : ['draft_repair'];
  return checkKinds.filter(check => !hasObservation(entries, { name: 'check_candidate', args: { check } }));
}

function conversation(spec: AgentSpec, state: AgentState, entries: AgentEvidence[], origin: AgentOrigin, reservedBytes: number) {
  const observations: AgentEvidence[] = [];
  const latestVerification = state.verifications.at(-1);
  const candidate = state.repairs.at(-1)?.candidate;
  const payload = {
    goal: spec.goal, role: state.role, source: origin === 'trusted_fixture' ? spec.source : undefined,
    snapshotSha256: state.role === 'verify' ? candidate?.snapshotSha256 : spec.snapshotSha256,
    feedback: state.feedback ? agentText(spec.locale).feedback[state.feedback] : null,
    completionNeeds: missingObservations(state.role, entries, origin),
    handoff: {
      findings: state.audit?.findings.map(({ id, ruleId, severity, certainty }) => ({ id, ruleId, severity, certainty })) ?? [],
      previousChecks: latestVerification?.checks,
    },
    evidenceIndex: entries.map(({ id, data }) => ({
      id, kind: data.kind, check: data.kind === 'check' ? data.result.check : undefined,
      section: data.kind === 'context' ? data.section : undefined, ruleId: data.kind === 'rule' ? data.ruleId : undefined,
      scanner: data.kind === 'scan' ? data.scanner : undefined,
    })),
    observations,
  };
  // Replay the latest admitted exchange with synthetic correlation IDs and no provider prose.
  let exchange: ConversationEntry[] = [];
  const last = state.trace.at(-1);
  if (last?.role === state.role && state.currentEvidence.includes(last.evidenceId)) {
    const id = `call_${last.operationId.slice(0, 24)}`;
    exchange = [
      { kind: 'assistant', turn: { text: '', calls: [{ id, name: last.call.name, input: last.call.args }], tokenUsage: 0 } },
      { kind: 'observations', observations: [{ callId: id, name: last.call.name, output: JSON.stringify({ evidenceId: last.evidenceId }), isError: false }] },
    ];
  }
  const build = (): ConversationEntry[] => [{ kind: 'user', text: JSON.stringify(payload) }, ...exchange];
  const fits = (messages: ConversationEntry[]) => Buffer.byteLength(JSON.stringify(messages)) + reservedBytes <= spec.limits.maxContextBytes;
  let messages = build();
  if (!fits(messages)) {
    exchange = [];
    messages = build();
    if (!fits(messages)) return;
  }
  for (const entry of [...entries].reverse()) {
    observations.push(entry);
    const withEntry = build();
    if (fits(withEntry)) messages = withEntry;
    else observations.pop();
  }
  return messages;
}

function nextRole(state: AgentState, role: DeliveryRole): AgentState {
  return { ...state, role, currentEvidence: [], stalled: 0, feedback: null };
}

function finish(state: AgentState, spec: AgentSpec, input: unknown, origin: AgentOrigin): AgentState | undefined {
  const evidence = currentEvidence(state);
  if (origin === 'formal_audit') {
    const audit = finishFormalAudit(evidence, input, spec.locale);
    if (!audit) return;
    const audited = { ...state, audit };
    return audit.coverage === 'complete' && !audit.hypotheses.length
      ? stopped(audited, 'audit_complete', 'completed') : stopped(audited, 'audit_incomplete');
  }
  if (state.role === 'audit') {
    const audit = finishAudit(evidence, input);
    if (!audit) return;
    const audited = { ...state, audit };
    if (audit.coverage !== 'complete' || audit.hypotheses.length || audit.findings.some(item => item.certainty === 'suspected')) {
      return stopped(audited, 'audit_incomplete');
    }
    return audit.findings.length ? nextRole(audited, 'repair') : stopped(audited, 'no_repairs_needed', 'completed');
  }
  if (state.role === 'repair') {
    const repair = finishRepair(evidence, input);
    if (!repair) return;
    return nextRole({ ...state, repairs: [...state.repairs, repair] }, 'verify');
  }
  const repair = state.repairs.at(-1);
  if (!state.audit || !repair) return;
  const verification = finishVerify(evidence, input, state.audit, repair);
  if (!verification) return;
  const checked = { ...state, verifications: [...state.verifications, verification] };
  if (verification.outcome === 'verified_fixture') return stopped(checked, 'fixture_complete', 'completed');
  if (verification.outcome === 'unverified') return stopped(checked, 'check_unavailable');
  return state.repairs.length < spec.limits.maxRepairs ? nextRole(checked, 'repair') : stopped(checked, 'repair_limit');
}

export function createAgentHarness(options: HarnessOptions) {
  return createHarness(options, { origin: 'trusted_fixture' });
}

export function createFormalAuditHarness(options: HarnessOptions, profile: Omit<FormalAuditProfile, 'origin'>) {
  return createHarness(options, { ...profile, origin: 'formal_audit' });
}

function createHarness<Profile extends HarnessProfile>({ model, checkpointer, host }: HarnessOptions, profile: Profile) {
  const { origin } = profile;
  const active = new Set<string>();
  return {
    async run(rawSpec: unknown, options: AgentRunOptions = {}) {
      const spec = agentSpecSchema.parse(rawSpec);
      const bindingSha256 = sha256(JSON.stringify(profile.origin === 'formal_audit' ? { profile, spec } : spec));
      if (active.has(spec.runId)) throw new Error('Run already active in this harness');
      active.add(spec.runId);
      try {
        return await execute(spec, bindingSha256, options);
      } finally {
        active.delete(spec.runId);
      }
    },
  };

  async function execute(spec: AgentSpec, bindingSha256: string, options: AgentRunOptions) {
    const { limits } = spec;
    const formal = profile.origin === 'formal_audit';
    const ruleIds = formal ? profile.ruleIds : [];
    const report = (status: AgentStatus, reason: AgentReason, state?: AgentState) =>
      agentReport<Profile['origin']>(origin, spec, bindingSha256, status, reason, state);
    const permits = (role: DeliveryRole, call: PlannedTool) => canCall(role, call.name, origin)
      && (!formal || call.name !== 'read_rule' || ruleIds.includes(call.args.ruleId));
    const externalSignal = options.signal;
    // The timer can abort before the wall clock reaches the exact deadline millisecond.
    const lapse = (state: AgentState, signal?: AbortSignal) => externalSignal?.aborted ? stopped(state, 'cancelled', 'cancelled')
      : signal?.aborted || Date.now() >= state.deadlineAt ? stopped(state, 'deadline') : undefined;
    const signalFor = (deadlineAt: number) => {
      const timeout = AbortSignal.timeout(Math.max(0, deadlineAt - Date.now()));
      return externalSignal ? AbortSignal.any([timeout, externalSignal]) : timeout;
    };
    const target = (state: AgentState) => state.role === 'verify' ? state.repairs.at(-1)?.candidate ?? null : null;
    const scopeFor = (state: AgentState): AgentScope => ({
      spec: structuredClone(spec), bindingSha256, role: state.role, origin,
      snapshotSha256: target(state)?.snapshotSha256 ?? spec.snapshotSha256,
    });

    async function authorized(state: AgentState, signal: AbortSignal) {
      try {
        return await bounded(signal, () => host.authorize(scopeFor(state), signal)) === true;
      } catch {
        return false;
      }
    }
    async function gate(state: AgentState, signal: AbortSignal) {
      const expired = lapse(state, signal);
      if (expired) return expired;
      const allowed = await authorized(state, signal);
      return lapse(state, signal) ?? (allowed ? undefined : stopped(state, 'permission_denied'));
    }
    function stalled(state: AgentState, feedback: Feedback) {
      const next = { ...state, feedback, stalled: state.stalled + 1 };
      return next.stalled >= limits.maxStalledTurns ? stopped(next, 'no_progress') : next;
    }

    const graph = new StateGraph(graphState)
      .addNode('reserve', async ({ state }) => {
        const action = state.nextTool ? 'observation' : 'decision';
        const blocked = await gate(state, signalFor(state.deadlineAt));
        if (blocked) return { state: blocked };
        if (state.usage.tokens >= limits.maxTokens) return { state: stopped(state, 'token_budget') };
        if (action === 'observation' && state.usage.toolCalls >= limits.maxToolCalls) return { state: stopped(state, 'tool_budget') };
        if (action === 'decision' && state.usage.turns >= limits.maxTurns) return { state: stopped(state, 'turn_budget') };
        const usage = { ...state.usage };
        if (action === 'observation') usage.toolCalls++;
        else usage.turns++;
        return { state: { ...state, usage, pending: action } };
      })
      .addNode('decision', async ({ state: reserved }) => {
        const state = { ...reserved, pending: null };
        const signal = signalFor(state.deadlineAt);
        const before = await gate(state, signal);
        if (before) return { state: before };
        const system = agentPrompt(spec.locale, state.role, origin);
        const entries = currentEvidence(state);
        const tools = toolDefinitions(spec.locale, state.role, entries, origin, ruleIds);
        const reservedBytes = Buffer.byteLength(system) + (formal ? Buffer.byteLength(JSON.stringify(tools)) : 0);
        const messages = conversation(spec, state, entries, origin, reservedBytes);
        if (!messages) return { state: stopped(state, 'context_budget') };
        let turn;
        try {
          turn = await bounded(signal, () => model.complete({
            system, conversation: messages, tools, signal,
            maxOutputTokens: Math.min(formal ? 3_072 : 1_024, limits.maxTokens - state.usage.tokens), singleTool: true,
          }));
        } catch {
          return { state: lapse(state, signal) ?? stopped(state, 'provider_error') };
        }
        if (!turn || !Number.isSafeInteger(turn.tokenUsage) || turn.tokenUsage < 0
          || !Array.isArray(turn.calls)) return { state: stopped(state, 'provider_error') };
        state.usage = { ...state.usage, tokens: Math.min(Number.MAX_SAFE_INTEGER, state.usage.tokens + turn.tokenUsage) };
        const after = await gate(state, signal);
        if (after) return { state: after };
        if (state.usage.tokens >= limits.maxTokens) return { state: stopped(state, 'token_budget') };
        const call = turn.calls[0];
        if (turn.calls.length > 1) return { state: stalled(state, 'multiple_calls') };
        if (!call) return { state: stalled(state, 'invalid_call') };
        if (call.name === 'request_human' && emptyArguments.safeParse(call.input).success) return { state: stopped(state, 'manual_review') };
        if (call.name === 'finish_role') return { state: finish(state, spec, call.input, origin) ?? stalled(state, 'insufficient_evidence') };
        const planned = plannedToolSchema.safeParse({ name: call.name, args: call.input });
        if (!planned.success || !permits(state.role, planned.data)) return { state: stalled(state, 'invalid_call') };
        if (hasObservation(entries, planned.data)) return { state: stalled(state, 'no_new_evidence') };
        return { state: { ...state, nextTool: planned.data } };
      })
      .addNode('observation', async ({ state: reserved }) => {
        const state = { ...reserved, pending: null, nextTool: null };
        const call = reserved.nextTool;
        if (!call || !permits(state.role, call)) return { state: stopped(state, 'incompatible_checkpoint') };
        const signal = signalFor(state.deadlineAt);
        const before = await gate(state, signal);
        if (before) return { state: before };
        const scope = scopeFor(state);
        const candidate = target(state);
        const operationId = sha256(`${bindingSha256}:${state.usage.toolCalls}`);
        let raw;
        try {
          raw = await bounded(signal, () => host.observe({
            scope, call: structuredClone(call), operationId, candidate: structuredClone(candidate),
            audit: structuredClone(state.audit), signal,
          }));
        } catch {
          return { state: lapse(state, signal) ?? stopped(state, 'interrupted_action') };
        }
        const after = await gate(state, signal);
        if (after) return { state: after };
        const receipt = acceptReceipt(raw, { origin, bindingSha256, snapshotSha256: scope.snapshotSha256, call, audit: state.audit, candidate });
        if (!receipt) return { state: stopped(state, 'invalid_receipt') };
        const trace = [...state.trace, { role: state.role, operationId, call, evidenceId: receipt.id }];
        if (state.currentEvidence.includes(receipt.id)) return { state: stalled({ ...state, trace }, 'no_new_evidence') };
        return { state: {
          ...state, stalled: 0, feedback: null, trace,
          evidence: state.evidence.some(item => item.id === receipt.id) ? state.evidence : [...state.evidence, receipt],
          currentEvidence: [...state.currentEvidence, receipt.id],
        } };
      })
      .addEdge(START, 'reserve')
      .addConditionalEdges('reserve', ({ state }) => state.stop ? END : state.pending === 'observation' ? 'observation' : 'decision',
        ['observation', 'decision', END])
      .addConditionalEdges('decision', ({ state }) => state.stop ? END : 'reserve', ['reserve', END])
      .addConditionalEdges('observation', ({ state }) => state.stop ? END : 'reserve', ['reserve', END])
      .compile({ checkpointer, name: formal ? 'formal-audit-agent' : 'fixture-delivery-agent' });

    const config = {
      configurable: { thread_id: `${formal ? 'audit' : 'fixture-agent'}:${spec.runId}` },
      durability: 'sync' as const, recursionLimit: 2 * (limits.maxTurns + limits.maxToolCalls) + 8,
    };
    try {
      const checkpoint = await graph.getState(config);
      const existing = checkpoint.config?.configurable?.checkpoint_id !== undefined || checkpoint.values?.state !== undefined;
      const state = existing ? restoreState(checkpoint.values?.state, spec, bindingSha256, origin) : initialState(spec, bindingSha256);
      if (!state) return report('requires_human', 'incompatible_checkpoint');
      if (state.stop || state.pending) {
        if (!await authorized(state, signalFor(Date.now() + Math.min(1_000, limits.maxDurationMs)))) {
          return report(externalSignal?.aborted ? 'cancelled' : 'requires_human',
            externalSignal?.aborted ? 'cancelled' : 'permission_denied');
        }
        return state.stop
          ? report(state.stop.status, state.stop.reason, state)
          : report('requires_human', 'interrupted_action', state);
      }
      const expired = lapse(state);
      if (expired?.stop) return report(expired.stop.status, expired.stop.reason);
      if (existing && (checkpoint.next.length !== 1 || checkpoint.next[0] !== 'reserve')) {
        return report('requires_human', 'incompatible_checkpoint');
      }
      const interruptAfter = options.pauseAfter ? [options.pauseAfter === 'decision' ? 'decision' : 'reserve'] as const : [];
      const result = (await graph.invoke(existing ? null : { state }, { ...config, interruptAfter: [...interruptAfter] })).state;
      return result.stop
        ? report(result.stop.status, result.stop.reason, result)
        : report('paused', 'checkpoint_paused', result);
    } catch {
      return report('requires_human', 'checkpoint_unavailable');
    }
  }
}
