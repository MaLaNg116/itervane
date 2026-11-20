import { Annotation, END, START, StateGraph, type BaseCheckpointSaver } from '@langchain/langgraph';
import type { ModelAdapter } from '@itervane/model';
import { agentSpecSchema, sha256, type AgentSpec, type AgentEvidence, type Candidate, type AuditReport, type DeliveryRole } from './contracts.js';
import { agentPrompt, agentText, type AgentReason, type Feedback } from './messages.js';
import { finishAudit, finishRepair, finishVerify } from './results.js';
import { initialState, restoreState, stopped, type AgentState, type Stop } from './state.js';
import { acceptReceipt, canCall, emptyArguments, plannedToolSchema, toolDefinitions, type PlannedTool } from './tools.js';

export type AgentScope = Readonly<{
  spec: Readonly<AgentSpec>; bindingSha256: string; snapshotSha256: string; role: DeliveryRole;
}>;
export interface AgentFixtureHost {
  authorize(scope: AgentScope, signal: AbortSignal): Promise<boolean>;
  observe(input: {
    scope: AgentScope; call: PlannedTool; operationId: string;
    candidate: Candidate | null; audit: AuditReport | null; signal: AbortSignal;
  }): Promise<unknown>;
}
type HarnessOptions = { model: ModelAdapter; checkpointer: BaseCheckpointSaver; host: AgentFixtureHost };
type RunOptions = { signal?: AbortSignal; pauseAfter?: 'decision' | 'reservation' };
type AgentStatus = Stop['status'] | 'paused';
const graphState = Annotation.Root({ state: Annotation<AgentState>() });

function report(spec: AgentSpec, status: AgentStatus, reason: AgentReason, state?: AgentState) {
  return {
    runId: spec.runId, status, reason, message: agentText(spec.locale).reason[reason],
    origin: 'trusted_fixture' as const, releaseEligible: false as const,
    bindingSha256: state?.bindingSha256 ?? sha256(JSON.stringify(spec)),
    role: state?.role ?? 'audit', usage: state?.usage ?? { turns: 0, toolCalls: 0, tokens: 0 },
    trace: state?.trace ?? [], evidence: state?.evidence ?? [],
    audit: state?.audit ?? null, repairs: state?.repairs ?? [], verifications: state?.verifications ?? [],
  };
}
export type AgentFixtureReport = ReturnType<typeof report>;

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

function context(spec: AgentSpec, state: AgentState, system: string) {
  const entries = currentEvidence(state);
  const observations: AgentEvidence[] = [];
  const latestVerification = state.verifications.at(-1);
  const candidate = state.repairs.at(-1)?.candidate;
  const payload = {
    goal: spec.goal, role: state.role, source: spec.source, snapshotSha256: spec.snapshotSha256,
    feedback: state.feedback ? agentText(spec.locale).feedback[state.feedback] : null,
    handoff: {
      findings: state.audit?.findings.map(({ id, ruleId, severity, certainty }) => ({ id, ruleId, severity, certainty })) ?? [],
      candidateSha256: state.role === 'verify' ? candidate?.snapshotSha256 : undefined,
      previousChecks: latestVerification?.checks,
    },
    evidenceIndex: entries.map(({ id, data }) => ({
      id, kind: data.kind, check: data.kind === 'check' ? data.result.check : undefined,
    })),
    observations,
  };
  const fits = (content: string) => Buffer.byteLength(content) + Buffer.byteLength(system) <= spec.limits.maxContextBytes;
  let content = JSON.stringify(payload);
  if (!fits(content)) return;
  for (const entry of [...entries].reverse()) {
    observations.push(entry);
    const withEntry = JSON.stringify(payload);
    if (fits(withEntry)) content = withEntry;
    else observations.pop();
  }
  return content;
}

function nextRole(state: AgentState, role: DeliveryRole): AgentState {
  return { ...state, role, currentEvidence: [], stalled: 0, feedback: null };
}

function finish(state: AgentState, spec: AgentSpec, input: unknown): AgentState | undefined {
  const evidence = currentEvidence(state);
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

export function createAgentHarness({ model, checkpointer, host }: HarnessOptions) {
  const active = new Set<string>();
  return {
    async run(rawSpec: unknown, options: RunOptions = {}): Promise<AgentFixtureReport> {
      const spec = agentSpecSchema.parse(rawSpec);
      const bindingSha256 = sha256(JSON.stringify(spec));
      if (active.has(spec.runId)) throw new Error('Fixture run already active in this harness');
      active.add(spec.runId);
      try {
        return await execute(spec, bindingSha256, options);
      } finally {
        active.delete(spec.runId);
      }
    },
  };

  async function execute(spec: AgentSpec, bindingSha256: string, options: RunOptions) {
    const { limits } = spec;
    const externalSignal = options.signal;
    const lapse = (state: AgentState) => externalSignal?.aborted ? stopped(state, 'cancelled', 'cancelled')
      : Date.now() >= state.deadlineAt ? stopped(state, 'deadline') : undefined;
    const signalFor = (deadlineAt: number) => {
      const timeout = AbortSignal.timeout(Math.max(0, deadlineAt - Date.now()));
      return externalSignal ? AbortSignal.any([timeout, externalSignal]) : timeout;
    };
    const target = (state: AgentState) => state.role === 'verify' ? state.repairs.at(-1)?.candidate ?? null : null;
    const scopeFor = (state: AgentState): AgentScope => ({
      spec: structuredClone(spec), bindingSha256, role: state.role,
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
      const expired = lapse(state);
      if (expired) return expired;
      const allowed = await authorized(state, signal);
      return lapse(state) ?? (allowed ? undefined : stopped(state, 'permission_denied'));
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
        const system = agentPrompt(spec.locale, state.role);
        const prompt = context(spec, state, system);
        if (!prompt) return { state: stopped(state, 'context_budget') };
        let turn;
        try {
          turn = await bounded(signal, () => model.complete({
            system, conversation: [{ kind: 'user', text: prompt }], tools: toolDefinitions(spec.locale, state.role), signal,
            maxOutputTokens: Math.min(1_024, limits.maxTokens - state.usage.tokens),
          }));
        } catch {
          return { state: lapse(state) ?? stopped(state, 'provider_error') };
        }
        if (!turn || !Number.isSafeInteger(turn.tokenUsage) || turn.tokenUsage < 0
          || !Array.isArray(turn.calls)) return { state: stopped(state, 'provider_error') };
        state.usage = { ...state.usage, tokens: Math.min(Number.MAX_SAFE_INTEGER, state.usage.tokens + turn.tokenUsage) };
        const after = await gate(state, signal);
        if (after) return { state: after };
        if (state.usage.tokens >= limits.maxTokens) return { state: stopped(state, 'token_budget') };
        const call = turn.calls[0];
        if (turn.calls.length !== 1 || !call) return { state: stalled(state, 'invalid_call') };
        if (call.name === 'request_human' && emptyArguments.safeParse(call.input).success) return { state: stopped(state, 'manual_review') };
        if (call.name === 'finish_role') return { state: finish(state, spec, call.input) ?? stalled(state, 'insufficient_evidence') };
        const planned = plannedToolSchema.safeParse({ name: call.name, args: call.input });
        if (!planned.success || !canCall(state.role, planned.data.name)) return { state: stalled(state, 'invalid_call') };
        return { state: { ...state, nextTool: planned.data } };
      })
      .addNode('observation', async ({ state: reserved }) => {
        const state = { ...reserved, pending: null, nextTool: null };
        const call = reserved.nextTool;
        if (!call || !canCall(state.role, call.name)) return { state: stopped(state, 'incompatible_checkpoint') };
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
          return { state: lapse(state) ?? stopped(state, 'interrupted_action') };
        }
        const after = await gate(state, signal);
        if (after) return { state: after };
        const receipt = acceptReceipt(raw, { bindingSha256, snapshotSha256: scope.snapshotSha256, call, audit: state.audit, candidate });
        if (!receipt) return { state: stopped(state, 'invalid_receipt') };
        const trace = [...state.trace, { role: state.role, operationId, tool: call.name, evidenceId: receipt.id }];
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
      .compile({ checkpointer, name: 'fixture-delivery-agent' });

    const config = {
      configurable: { thread_id: `fixture-agent:${spec.runId}` },
      durability: 'sync' as const, recursionLimit: 2 * (limits.maxTurns + limits.maxToolCalls) + 8,
    };
    try {
      const checkpoint = await graph.getState(config);
      const existing = checkpoint.config?.configurable?.checkpoint_id !== undefined || checkpoint.values?.state !== undefined;
      const state = existing ? restoreState(checkpoint.values?.state, spec, bindingSha256) : initialState(spec, bindingSha256);
      if (!state) return report(spec, 'requires_human', 'incompatible_checkpoint');
      if (state.stop || state.pending) {
        if (!await authorized(state, signalFor(Date.now() + Math.min(1_000, limits.maxDurationMs)))) {
          return report(spec, externalSignal?.aborted ? 'cancelled' : 'requires_human',
            externalSignal?.aborted ? 'cancelled' : 'permission_denied');
        }
        return state.stop
          ? report(spec, state.stop.status, state.stop.reason, state)
          : report(spec, 'requires_human', 'interrupted_action', state);
      }
      const expired = lapse(state);
      if (expired?.stop) return report(spec, expired.stop.status, expired.stop.reason);
      if (existing && (checkpoint.next.length !== 1 || checkpoint.next[0] !== 'reserve')) {
        return report(spec, 'requires_human', 'incompatible_checkpoint');
      }
      const interruptAfter = options.pauseAfter ? [options.pauseAfter === 'decision' ? 'decision' : 'reserve'] as const : [];
      const result = (await graph.invoke(existing ? null : { state }, { ...config, interruptAfter: [...interruptAfter] })).state;
      return result.stop
        ? report(spec, result.stop.status, result.stop.reason, result)
        : report(spec, 'paused', 'checkpoint_paused', result);
    } catch {
      return report(spec, 'requires_human', 'checkpoint_unavailable');
    }
  }
}
