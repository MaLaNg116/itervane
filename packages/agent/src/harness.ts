import { Annotation, END, START, StateGraph, type BaseCheckpointSaver } from '@langchain/langgraph';
import { requiredAuditScanners, type FormalRepairRetryContext, type LinkedHealthRepairContext, type OperationsDiagnosisInput } from '@itervane/contracts';
import type { ConversationEntry, ModelAdapter } from '@itervane/model';
import {
  agentSpecSchema, checkKinds, sha256, type AgentSpec, type AgentEvidence, type AgentOrigin,
  type Candidate, type AuditReport, type AgentRole, type DeliveryRole,
} from './contracts.js';
import { agentPrompt, agentText, type AgentReason, type Feedback } from './messages.js';
import { finishFormalOperations, missingOperationsSections } from './operations-results.js';
import type { RepairFindingSummary } from './repair-contracts.js';
import { finishAudit, finishFormalAudit, finishFormalRepair, finishFormalVerification, finishRepair, finishVerify } from './results.js';
import { finishRuleExtraction } from './rule-extraction-result.js';
import { initialRole, initialState, restoreState, stopped, type AgentState, type Stop } from './state.js';
import { acceptReceipt, canCall, emptyArguments, hasObservation, plannedToolSchema, toolDefinitions, type PlannedTool } from './tools.js';
import { finishVerificationInputSchema, pendingVerificationSections, type VerificationSection } from './verification-contracts.js';

export type AgentScope = Readonly<{
  spec: Readonly<AgentSpec>; bindingSha256: string; snapshotSha256: string; role: AgentRole; origin: AgentOrigin;
}>;
export interface AgentHost {
  authorize(scope: AgentScope, signal: AbortSignal): Promise<boolean>;
  observe(input: {
    scope: AgentScope; call: PlannedTool; operationId: string;
    candidate: Candidate | null; audit: AuditReport | null; evidence: readonly AgentEvidence[]; signal: AbortSignal;
  }): Promise<unknown>;
}
export type AgentFixtureHost = AgentHost;
type HarnessOptions = { model: ModelAdapter; checkpointer: BaseCheckpointSaver; host: AgentHost };
type FormalAuditProfile = { origin: 'formal_audit'; inputSha256: string; providerSha256: string; ruleIds: readonly string[];
  healthReproduction?: true; publishedCode?: true };
type FormalRepairProfile = { origin: 'formal_repair'; inputSha256: string; providerSha256: string; findings: readonly RepairFindingSummary[];
  previousVerification?: FormalRepairRetryContext; healthReproduction?: LinkedHealthRepairContext };
type FormalVerificationProfile = {
  origin: 'formal_verification'; inputSha256: string; providerSha256: string;
  sectionSha256: Readonly<Record<VerificationSection, string>>;
};
type OperationsTarget = Pick<OperationsDiagnosisInput['request'], 'containerId' | 'releaseOperationId' | 'manifestDigest'> & { serverId: string };
type FormalOperationsProfile = { origin: 'formal_operations'; inputSha256: string; providerSha256: string; target: Readonly<OperationsTarget> };
type FormalRuleExtractionProfile = { origin: 'formal_rule_extraction'; providerSha256: string; caseId: string; caseSha256: string; knowledgeSha256: string };
type HarnessProfile = { origin: 'trusted_fixture' } | FormalAuditProfile | FormalRepairProfile | FormalVerificationProfile | FormalOperationsProfile
  | FormalRuleExtractionProfile;
export type AgentRunOptions = { signal?: AbortSignal; pauseAfter?: 'decision' | 'reservation' };
type AgentStatus = Stop['status'] | 'paused';
const graphState = Annotation.Root({ state: Annotation<AgentState>() });

function agentReport<Origin extends AgentOrigin>(origin: Origin, spec: AgentSpec, bindingSha256: string,
  status: AgentStatus, reason: AgentReason, state?: AgentState, checkpointId?: string) {
  const visible = reason === 'permission_denied' ? undefined : state;
  const diagnosis = visible?.formalOperations;
  const text = agentText(spec.locale);
  return {
    runId: spec.runId, status, reason, message: text.reason[reason],
    origin, releaseEligible: false as const, bindingSha256,
    ...(checkpointId ? { checkpointId } : {}),
    role: state?.role ?? initialRole(origin), usage: state?.usage ?? { turns: 0, toolCalls: 0, tokens: 0 },
    trace: visible?.trace.map(({ call, ...item }) => ({ ...item, tool: call.name })) ?? [], evidence: visible?.evidence ?? [],
    audit: visible?.audit ?? null, repairs: visible?.repairs ?? [], verifications: visible?.verifications ?? [],
    ...(origin === 'formal_repair' ? { formalRepair: visible?.formalRepair ?? null } : {}),
    ...(origin === 'formal_verification' ? { formalVerification: visible?.formalVerification ?? null } : {}),
    ...(origin === 'formal_operations' ? { formalOperations: diagnosis ?? null, operationsPresentation: diagnosis ? {
      locale: spec.locale,
      hypotheses: diagnosis.hypotheses.map(({ code }) => ({ code, message: text.operationsHypothesis[code] })),
      recommendation: text.operationsRecommendation[diagnosis.recommendation.code],
    } : null } : {}),
    ...(origin === 'formal_rule_extraction' ? { formalRuleExtraction: visible?.formalRuleExtraction ?? null } : {}),
  };
}
export type AgentFixtureReport = ReturnType<typeof agentReport<'trusted_fixture'>>;
export type FormalAuditReport = ReturnType<typeof agentReport<'formal_audit'>>;
export type FormalRepairReport = ReturnType<typeof agentReport<'formal_repair'>>;
export type FormalVerificationReport = ReturnType<typeof agentReport<'formal_verification'>>;
export type FormalOperationsReport = ReturnType<typeof agentReport<'formal_operations'>>;
export type FormalRuleExtractionReport = ReturnType<typeof agentReport<'formal_rule_extraction'>>;

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

function missingObservations(role: AgentRole, entries: AgentEvidence[], profile: HarnessProfile) {
  const { origin } = profile;
  if (origin === 'formal_audit') return [
    ...requiredAuditScanners(profile.publishedCode === true).filter(scanner => !hasObservation(entries, { name: 'read_scan', args: { scanner } })),
    ...(profile.healthReproduction && !hasObservation(entries, { name: 'read_health_reproduction', args: {} }) ? ['health_reproduction'] : []),
  ];
  if (origin === 'formal_repair') {
    if (entries.some(item => item.data.kind === 'repair_candidate')) return [];
    return entries.some(item => item.data.kind === 'repair_targets') ? ['apply_repair_template', 'apply_repair_patch'] : ['read_repair_targets'];
  }
  if (origin === 'formal_verification') return pendingVerificationSections(entries);
  if (origin === 'formal_operations') return missingOperationsSections(entries).filter(section => section === 'container' || section === 'release');
  if (origin === 'formal_rule_extraction') return (['read_learning_case', 'search_learning_knowledge'] as const)
    .filter(name => !hasObservation(entries, { name, args: {} }));
  if (role === 'audit') return entries.some(item => item.data.kind === 'findings') ? [] : ['read_findings'];
  if (role === 'repair') return entries.some(item => item.data.kind === 'candidate') ? [] : ['draft_repair'];
  return checkKinds.filter(check => !hasObservation(entries, { name: 'check_candidate', args: { check } }));
}

function conversation(spec: AgentSpec, state: AgentState, entries: AgentEvidence[], profile: HarnessProfile, reservedBytes: number) {
  const { origin } = profile;
  const observations: unknown[] = [];
  const latestVerification = state.verifications.at(-1);
  const candidate = state.repairs.at(-1)?.candidate;
  const payload = {
    goal: spec.goal, role: state.role, source: origin === 'trusted_fixture' ? spec.source : undefined,
    snapshotSha256: state.role === 'verify' ? candidate?.snapshotSha256 ?? spec.snapshotSha256 : spec.snapshotSha256,
    feedback: state.feedback ? agentText(spec.locale).feedback[state.feedback] : null,
    completionNeeds: missingObservations(state.role, entries, profile),
    guidance: profile.origin === 'formal_repair' && profile.healthReproduction ? agentText(spec.locale).linkedHealth.repair
      : profile.origin === 'formal_audit' && profile.healthReproduction ? agentText(spec.locale).linkedHealth.audit : undefined,
    handoff: {
      findings: profile.origin === 'formal_repair' ? profile.findings
        : state.audit?.findings.map(({ id, ruleId, severity, certainty }) => ({ id, ruleId, severity, certainty })) ?? [],
      previousChecks: latestVerification?.checks,
      previousVerification: profile.origin === 'formal_repair' ? profile.previousVerification : undefined,
      healthReproduction: profile.origin === 'formal_repair' ? profile.healthReproduction : undefined,
    },
    evidenceIndex: entries.map(({ id, data }) => ({
      id, kind: data.kind, check: data.kind === 'check' ? data.result.check : undefined,
      section: data.kind === 'context' || data.kind === 'verification_section' || data.kind === 'operations_section' ? data.section : undefined,
      ruleId: data.kind === 'rule' ? data.ruleId : undefined,
      scanner: data.kind === 'scan' ? data.scanner : undefined,
    })),
    observations,
  };
  // The formal model uses the admitted evidence payload for each turn. Trusted fixtures also exercise protocol replay.
  let exchange: ConversationEntry[] = [];
  const last = state.trace.at(-1);
  if (origin === 'trusted_fixture' && last?.role === state.role && state.currentEvidence.includes(last.evidenceId)) {
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
  const latest = [...entries].reverse();
  const ordered = origin === 'formal_audit'
    ? [...latest.filter(item => item.data.kind === 'scan'), ...latest.filter(item => item.data.kind !== 'scan')]
    : latest;
  for (const entry of ordered) {
    const { data } = entry;
    if (data.kind === 'repair_targets') {
      observations.push({ ...entry, data: { ...data, observation: { ...data.observation,
        targets: data.observation.targets.map(({ path: _path, ...target }, index) => ({ ...target, index })) } } });
    } else if (data.kind === 'repair_candidate') {
      observations.push({ ...entry, data: { ...data, candidate: { ...data.candidate,
        changes: data.candidate.changes.map(({ path: _path, ...change }) => change) } } });
    } else if (data.kind === 'operations_section') {
      if (data.section === 'release') observations.push({ id: entry.id, data });
      else {
        const { containerId: _containerId, serverId: _serverId, ...result } = data.result;
        observations.push({ id: entry.id, data: { ...data, result } });
      }
    } else {
      observations.push(entry);
    }
    const withEntry = build();
    if (fits(withEntry)) messages = withEntry;
    else {
      if (origin === 'formal_audit' && entry.data.kind === 'scan') return;
      observations.pop();
    }
  }
  return messages;
}

function nextRole(state: AgentState, role: DeliveryRole): AgentState {
  return { ...state, role, currentEvidence: [], stalled: 0, feedback: null };
}

function finish(state: AgentState, spec: AgentSpec, input: unknown, origin: AgentOrigin, publishedCode: boolean): AgentState | undefined {
  const evidence = currentEvidence(state);
  if (origin === 'formal_audit') {
    const audit = finishFormalAudit(evidence, input, spec.locale, publishedCode);
    if (!audit) return;
    const audited = { ...state, audit };
    return audit.coverage === 'complete' && !audit.hypotheses.length
      ? stopped(audited, 'audit_complete', 'completed') : stopped(audited, 'audit_incomplete');
  }
  if (origin === 'formal_repair') {
    const repair = finishFormalRepair(evidence, input);
    return repair ? stopped({ ...state, formalRepair: repair }, 'repair_complete', 'completed') : undefined;
  }
  if (origin === 'formal_verification') {
    const verification = finishFormalVerification(evidence, input);
    return verification ? stopped({ ...state, formalVerification: verification }, 'verification_review_complete', 'completed') : undefined;
  }
  if (origin === 'formal_operations') {
    const diagnosis = finishFormalOperations(evidence, input);
    return diagnosis ? stopped({ ...state, formalOperations: diagnosis }, 'operations_review_complete', 'completed') : undefined;
  }
  if (origin === 'formal_rule_extraction') {
    const extraction = finishRuleExtraction(evidence, input);
    return extraction ? stopped({ ...state, formalRuleExtraction: extraction }, 'rule_extraction_complete', 'completed') : undefined;
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

export function createFormalRepairHarness(options: HarnessOptions, profile: Omit<FormalRepairProfile, 'origin'>) {
  return createHarness(options, { ...profile, origin: 'formal_repair' });
}

export function createFormalVerificationHarness(options: HarnessOptions, profile: Omit<FormalVerificationProfile, 'origin'>) {
  return createHarness(options, { ...profile, origin: 'formal_verification' });
}

export function createFormalOperationsHarness(options: HarnessOptions, profile: Omit<FormalOperationsProfile, 'origin'>) {
  return createHarness(options, { ...profile, origin: 'formal_operations' });
}

export function createFormalRuleExtractionHarness(options: HarnessOptions, profile: Omit<FormalRuleExtractionProfile, 'origin'>) {
  return createHarness(options, { ...profile, origin: 'formal_rule_extraction' });
}

function createHarness<Profile extends HarnessProfile>({ model, checkpointer, host }: HarnessOptions, profile: Profile) {
  const { origin } = profile;
  const active = new Set<string>();
  return {
    async run(rawSpec: unknown, options: AgentRunOptions = {}) {
      const spec = agentSpecSchema.parse(rawSpec);
      const bindingSha256 = sha256(JSON.stringify(profile.origin === 'trusted_fixture' ? spec : { profile, spec }));
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
    const formal = profile.origin !== 'trusted_fixture';
    const repairing = profile.origin === 'formal_repair';
    const verifying = profile.origin === 'formal_verification';
    const investigating = profile.origin === 'formal_operations';
    const extracting = profile.origin === 'formal_rule_extraction';
    const ruleIds = profile.origin === 'formal_audit' ? profile.ruleIds : [];
    const linkedHealth = profile.origin === 'formal_audit' && profile.healthReproduction === true;
    const publishedCode = profile.origin === 'formal_audit' && profile.publishedCode === true;
    const repairFindingIds = repairing ? profile.findings.map(item => item.id) : [];
    if (repairing && profile.healthReproduction) repairFindingIds.push(profile.healthReproduction.receiptSha256);
    const threadPrefix = formal ? initialRole(origin) : 'fixture-agent';
    const report = (status: AgentStatus, reason: AgentReason, state?: AgentState, checkpointId?: string) =>
      agentReport<Profile['origin']>(origin, spec, bindingSha256, status, reason, state, checkpointId);
    const permits = (state: AgentState, call: PlannedTool) => canCall(state.role, call.name, origin)
      && (!formal || call.name !== 'read_rule' || ruleIds.includes(call.args.ruleId))
      && (call.name !== 'read_scan' || requiredAuditScanners(publishedCode).includes(call.args.scanner))
      && (call.name !== 'read_health_reproduction' || linkedHealth)
      && (!repairing || !currentEvidence(state).some(item => item.data.kind === 'repair_candidate'))
      && (call.name !== 'read_verification' || pendingVerificationSections(currentEvidence(state)).includes(call.args.section))
      && (call.name !== 'read_operations' || missingOperationsSections(currentEvidence(state)).includes(call.args.section))
      && (call.name !== 'read_repair_targets' || call.args.findingIds.every(id => repairFindingIds.includes(id)));
    const matchesInput = ({ data }: AgentEvidence) => {
      if (verifying) return data.kind === 'verification_section' && sha256(JSON.stringify(data)) === profile.sectionSha256[data.section];
      if (extracting) {
        if (data.kind === 'learning_case') return data.record.caseId === profile.caseId && data.record.sha256 === profile.caseSha256
          && sha256(JSON.stringify(data.record.document)) === profile.caseSha256;
        return data.kind === 'learning_knowledge' && sha256(JSON.stringify(data.knowledge)) === profile.knowledgeSha256;
      }
      if (!investigating) return true;
      if (data.kind !== 'operations_section') return false;
      const { target } = profile;
      return data.section === 'release'
        ? data.result.current.operationId === target.releaseOperationId && data.result.current.manifestDigest === target.manifestDigest
        : data.result.containerId === target.containerId && data.result.serverId === target.serverId;
    };
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
        const tools = toolDefinitions(spec.locale, state.role, entries, origin, ruleIds, repairFindingIds, linkedHealth, publishedCode);
        const reservedBytes = Buffer.byteLength(system) + (formal ? Buffer.byteLength(JSON.stringify(tools)) : 0);
        const messages = conversation(spec, state, entries, profile, reservedBytes);
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
        if (call.name === 'finish_role') {
          if (verifying) {
            const checked = finishVerificationInputSchema.safeParse(call.input);
            if (!checked.success && checked.error.issues.some(issue =>
              issue.code === 'too_big' && (issue.path[0] === 'summary' || issue.path[0] === 'followUps'))) {
              return { state: stalled(state, 'verification_text_too_long') };
            }
          }
          return { state: finish(state, spec, call.input, origin, publishedCode) ?? stalled(state, 'insufficient_evidence') };
        }
        const planned = plannedToolSchema.safeParse({ name: call.name, args: call.input });
        if (!planned.success || !permits(state, planned.data)) return { state: stalled(state, 'invalid_call') };
        if (hasObservation(entries, planned.data)) return { state: stalled(state, 'no_new_evidence') };
        return { state: { ...state, nextTool: planned.data } };
      })
      .addNode('observation', async ({ state: reserved }) => {
        const state = { ...reserved, pending: null, nextTool: null };
        const call = reserved.nextTool;
        if (!call || !permits(state, call)) return { state: stopped(state, 'incompatible_checkpoint') };
        const signal = signalFor(state.deadlineAt);
        const before = await gate(state, signal);
        if (before) return { state: before };
        const scope = scopeFor(state);
        const candidate = target(state);
        const evidence = currentEvidence(state);
        const operationId = sha256(`${bindingSha256}:${state.usage.toolCalls}`);
        let raw;
        try {
          const observe = () => host.observe({
            scope, call: structuredClone(call), operationId, candidate: structuredClone(candidate),
            audit: structuredClone(state.audit), evidence: structuredClone(evidence), signal,
          });
          // The repair transport drains or reconciles its VM when cancelled.
          raw = repairing ? await observe() : await bounded(signal, observe);
        } catch {
          return { state: lapse(state, signal) ?? stopped(state, 'interrupted_action') };
        }
        const after = await gate(state, signal);
        if (after) return { state: after };
        const receipt = acceptReceipt(raw, { origin, bindingSha256, snapshotSha256: scope.snapshotSha256, call, audit: state.audit, candidate, evidence });
        if (!receipt || !matchesInput(receipt)) return { state: stopped(state, 'invalid_receipt') };
        const trace = [...state.trace, { role: state.role, operationId, call, evidenceId: receipt.id }];
        if (state.currentEvidence.includes(receipt.id)) return { state: stalled({ ...state, trace }, 'no_new_evidence') };
        const next: AgentState = {
          ...state, stalled: 0, feedback: null, trace,
          evidence: state.evidence.some(item => item.id === receipt.id) ? state.evidence : [...state.evidence, receipt],
          currentEvidence: [...state.currentEvidence, receipt.id],
        };
        if (receipt.data.kind === 'repair_failure') {
          if (receipt.data.code === 'cleanup_unproven') return { state: stopped(next, 'repair_reconciling') };
          if (receipt.data.code === 'not_ready') return { state: stopped(next, 'repair_unavailable') };
        }
        return { state: next };
      })
      .addEdge(START, 'reserve')
      .addConditionalEdges('reserve', ({ state }) => state.stop ? END : state.pending === 'observation' ? 'observation' : 'decision',
        ['observation', 'decision', END])
      .addConditionalEdges('decision', ({ state }) => state.stop ? END : 'reserve', ['reserve', END])
      .addConditionalEdges('observation', ({ state }) => state.stop ? END : 'reserve', ['reserve', END])
      .compile({ checkpointer, name: formal ? `formal-${threadPrefix}-agent` : 'fixture-delivery-agent' });

    const config = {
      configurable: { thread_id: `${threadPrefix}:${spec.runId}` },
      durability: 'sync' as const, recursionLimit: 2 * (limits.maxTurns + limits.maxToolCalls) + 8,
    };
    try {
      const checkpoint = await graph.getState(config);
      const publishedId = checkpoint.config?.configurable?.checkpoint_id;
      const checkpointId = formal && typeof publishedId === 'string' ? publishedId : undefined;
      const existing = publishedId !== undefined || checkpoint.values?.state !== undefined;
      const state = existing ? restoreState(checkpoint.values?.state, spec, bindingSha256, origin) : initialState(spec, bindingSha256, origin);
      if (!state || !state.evidence.every(matchesInput)) return report('requires_human', 'incompatible_checkpoint', undefined, checkpointId);
      const replay = state.pending === 'observation' && (
        (repairing && (state.nextTool?.name === 'apply_repair_template' || state.nextTool?.name === 'apply_repair_patch'))
        || (verifying && state.nextTool?.name === 'read_verification')
        || (investigating && state.nextTool?.name === 'read_operations')
        || (extracting && (state.nextTool?.name === 'read_learning_case' || state.nextTool?.name === 'search_learning_knowledge'))
      );
      if (state.stop || (state.pending && !replay)) {
        if (!await authorized(state, signalFor(Date.now() + Math.min(1_000, limits.maxDurationMs)))) {
          return report(externalSignal?.aborted ? 'cancelled' : 'requires_human',
            externalSignal?.aborted ? 'cancelled' : 'permission_denied');
        }
        return state.stop
          ? report(state.stop.status, state.stop.reason, state, checkpointId)
          : report('requires_human', 'interrupted_action', state, checkpointId);
      }
      const expired = lapse(state);
      if (expired?.stop) {
        if (formal && checkpointId && !await authorized(state, signalFor(Date.now() + 1_000))) {
          return report('requires_human', 'permission_denied');
        }
        return report(expired.stop.status, expired.stop.reason, checkpointId ? state : undefined, checkpointId);
      }
      if (existing && (checkpoint.next.length !== 1 || checkpoint.next[0] !== (replay ? 'observation' : 'reserve'))) {
        return report('requires_human', 'incompatible_checkpoint', undefined, checkpointId);
      }
      const interruptAfter = options.pauseAfter ? [options.pauseAfter === 'decision' ? 'decision' : 'reserve'] as const : [];
      const result = (await graph.invoke(existing ? null : { state }, { ...config, interruptAfter: [...interruptAfter] })).state;
      if (formal && result.stop) {
        // Bind formal outcomes to the guarded, published snapshot, including only acknowledged writes.
        const saved = await graph.getState(config);
        const savedId = saved.config?.configurable?.checkpoint_id;
        const settled = restoreState(saved.values?.state, spec, bindingSha256, origin);
        return typeof savedId === 'string' && settled?.stop && settled.evidence.every(matchesInput)
          ? report(settled.stop.status, settled.stop.reason, settled, savedId)
          : report('requires_human', 'checkpoint_unavailable');
      }
      return result.stop
        ? report(result.stop.status, result.stop.reason, result)
        : report('paused', 'checkpoint_paused', result);
    } catch {
      return report('requires_human', 'checkpoint_unavailable');
    }
  }
}
