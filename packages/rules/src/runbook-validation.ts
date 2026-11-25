import { learningCandidateSchema, runbookRecoveryContextSchema, runbookSelectionContextSchema,
  type LearningCandidate } from '@itervane/contracts';

type Runbook = Extract<LearningCandidate, { kind: 'runbook' }>;

export function selectRunbookAction(candidate: Pick<Runbook, 'when' | 'controls'>, raw: unknown) {
  const { observedState, publication, approvals, priorAttempts } = runbookSelectionContextSchema.parse(raw);
  if (publication === 'superseded') return 'stop_target_drift';
  if (publication === 'unknown' || observedState === 'unknown') return 'stop_unknown';
  if (observedState === 'running' || !candidate.when.observedStates.includes(observedState)) return 'observe_only';
  if (priorAttempts >= candidate.controls.maxNativeAttempts) return 'stop_attempt_limit';
  if (approvals === 'revoked' || approvals === 'expired') return 'stop_approval';
  if (approvals === 'missing') return 'await_approval';
  return 'ready_for_guarded_dispatch';
}

export function compareRunbookRecovery(candidate: Pick<Runbook, 'success'>, raw: unknown) {
  const context = runbookRecoveryContextSchema.parse(raw);
  if (context.sameInstance === false) return 'stop_target_drift';
  if (context.nativeOutcome !== 'acknowledged' || context.newerStart !== true || context.sameInstance !== true
      || context.healthStatus === null || context.anonymousStatus === null) return 'stop_unknown';
  if (context.healthStatus !== candidate.success.healthStatus || ![401, 403].includes(context.anonymousStatus)) return 'stop_failed_health';
  return 'verified_recovered';
}

export function evaluateRunbookSamples(raw: unknown) {
  const candidate = learningCandidateSchema.parse(raw);
  if (candidate.kind !== 'runbook') throw new Error('runbook_candidate_required');
  const scenarios = {
    eligible: selectRunbookAction(candidate, { ...candidate.samples.eligible, priorAttempts: 0 }),
    healthy: selectRunbookAction(candidate, { ...candidate.samples.healthy, priorAttempts: 0 }),
    stale: selectRunbookAction(candidate, { ...candidate.samples.stale, priorAttempts: 0 }),
    unapproved: selectRunbookAction(candidate, { ...candidate.samples.unapproved, priorAttempts: 0 }),
    exhausted: selectRunbookAction(candidate, { ...candidate.samples.eligible, priorAttempts: candidate.controls.maxNativeAttempts }),
    revoked: selectRunbookAction(candidate, { ...candidate.samples.eligible, priorAttempts: 0, approvals: 'revoked' }),
  };
  const verified = { nativeOutcome: 'acknowledged', sameInstance: true, newerStart: true, healthStatus: 200, anonymousStatus: 401 };
  const recovery = {
    verified: compareRunbookRecovery(candidate, verified),
    replaced: compareRunbookRecovery(candidate, { ...verified, sameInstance: false }),
    unknown: compareRunbookRecovery(candidate, { ...verified, nativeOutcome: 'unknown' }),
    unhealthy: compareRunbookRecovery(candidate, { ...verified, healthStatus: 503 }),
    anonymous: compareRunbookRecovery(candidate, { ...verified, anonymousStatus: 200 }),
  };
  const passed = scenarios.eligible === 'ready_for_guarded_dispatch' && scenarios.healthy === 'observe_only'
    && scenarios.stale === 'stop_target_drift' && scenarios.unapproved === 'await_approval' && scenarios.exhausted === 'stop_attempt_limit'
    && scenarios.revoked === 'stop_approval' && recovery.verified === 'verified_recovered' && recovery.replaced === 'stop_target_drift'
    && recovery.unknown === 'stop_unknown' && recovery.unhealthy === 'stop_failed_health' && recovery.anonymous === 'stop_failed_health';
  return { status: passed ? 'passed' as const : 'failed' as const, scenarios, recovery };
}
