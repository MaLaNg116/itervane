import {
  finishOperationsInputSchema, operationsDiagnosisResultSchema, operationsDiagnosisSections, operationsMemoryPressureThreshold, type OperationsDiagnosisObservation,
} from '@itervane/contracts';
import type { AgentEvidence } from './contracts.js';

type Reference = { evidenceIds: readonly string[] };

export function operationsObservations(evidence: readonly AgentEvidence[]) {
  return evidence.filter(item => item.origin === 'formal_operations');
}

export function missingOperationsSections(evidence: readonly AgentEvidence[]) {
  const observed = new Set(operationsObservations(evidence).map(item => item.data.section));
  return operationsDiagnosisSections.filter(section => !observed.has(section));
}

function citedFacts(facts: ReadonlyMap<string, OperationsDiagnosisObservation>, reference: Reference) {
  const cited = reference.evidenceIds.flatMap(id => {
    const fact = facts.get(id);
    return fact ? [fact] : [];
  });
  if (cited.length !== reference.evidenceIds.length) return;
  const container = cited.find(item => item.section === 'container')?.result;
  const released = cited.find(item => item.section === 'release')?.result;
  const logs = cited.find(item => item.section === 'logs')?.result;
  const metrics = cited.find(item => item.section === 'metrics')?.result;
  const stopped = container?.state === 'exited' || container?.state === 'dead';
  const errors = Boolean(logs && logs.errorLines > 0);
  const previous = released?.previous && released.previous.manifestDigest !== released.current.manifestDigest ? released.previous : null;
  const memoryPressure = metrics?.status === 'observed' && metrics.memory !== null && metrics.memory.average >= operationsMemoryPressureThreshold;
  return { stopped, errors, memoryPressure, previous, released };
}

export function finishFormalOperations(evidence: readonly AgentEvidence[], raw: unknown) {
  const input = finishOperationsInputSchema.safeParse(raw);
  if (!input.success) return;
  const { hypotheses, recommendation } = input.data;
  if (new Set(hypotheses.map(item => item.code)).size !== hypotheses.length) return;
  const observed = operationsObservations(evidence);
  const sections = new Set(observed.map(item => item.data.section));
  if (!sections.has('container') || !sections.has('release') || sections.size !== observed.length) return;
  const facts = new Map(observed.map(({ id, data }) => [id, data]));

  for (const item of hypotheses) {
    const cited = citedFacts(facts, item);
    if (!cited) return;
    const supported = {
      application_error: cited.errors,
      release_regression: cited.previous !== null && (cited.stopped || cited.errors),
      memory_pressure: cited.memoryPressure,
    };
    if (!supported[item.code]) return;
  }
  const cited = citedFacts(facts, recommendation);
  if (!cited) return;
  const supported = {
    continue_observation: true,
    review_restart: cited.stopped,
    review_rollback: cited.stopped && cited.previous !== null,
    investigate_code: cited.errors && Boolean(cited.released),
    human_review: true,
  };
  if (!supported[recommendation.code]) return;
  return operationsDiagnosisResultSchema.parse({
    hypotheses, recommendation, previousReleaseOperationId: recommendation.code === 'review_rollback' ? cited.previous!.operationId : null,
    facts: observed.map(({ id, data }) => ({ section: data.section, evidenceId: id, proofSha256: data.proofSha256 })),
  });
}
