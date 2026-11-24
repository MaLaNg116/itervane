import { finishRuleExtractionInputSchema, formalRuleExtractionResultSchema, type LearningCandidate } from '@itervane/contracts';
import { sha256, type AgentEvidence } from './contracts.js';

export function learningCandidateSemanticSha256(candidate: LearningCandidate) {
  const semantics = candidate.kind === 'code_rule' ? { kind: candidate.kind, check: candidate.check } : {
    kind: candidate.kind, action: candidate.action, observedStates: [...candidate.when.observedStates].sort(),
    controls: candidate.controls, success: candidate.success,
  };
  return sha256(JSON.stringify(semantics));
}

export function finishRuleExtraction(evidence: readonly AgentEvidence[], raw: unknown) {
  const checked = finishRuleExtractionInputSchema.safeParse(raw);
  if (!checked.success || evidence.length !== 2 || evidence.some(item => item.origin !== 'formal_rule_extraction')) return;
  const result = checked.data;
  if (evidence.some(item => !result.evidenceIds.includes(item.id))) return;
  const current = evidence.find(item => item.data.kind === 'learning_case')?.data;
  const previous = evidence.find(item => item.data.kind === 'learning_knowledge')?.data;
  if (current?.kind !== 'learning_case' || previous?.kind !== 'learning_knowledge') return;
  const { category } = current.record.document.facts;
  if (previous.knowledge.category !== category || previous.knowledge.cases.some(item => item.caseId === current.record.caseId)) return;
  const kind = category === 'recovered_stopped_instance' ? 'runbook' : 'code_rule';
  if (result.outcome === 'duplicate' && !previous.knowledge.candidates.some(item => item.id === result.existingCandidateId && item.kind === kind)) return;
  if (result.outcome === 'candidate') {
    const { candidate } = result;
    if (candidate.kind !== kind || previous.knowledge.candidates.some(item => item.key === candidate.key)) return;
    const semanticSha256 = learningCandidateSemanticSha256(candidate);
    if (previous.knowledge.candidates.some(item => item.semanticSha256 === semanticSha256)) return;
    const facts = current.record.document.facts;
    if (candidate.kind === 'runbook' && (facts.category !== 'recovered_stopped_instance'
      || !candidate.when.observedStates.includes(facts.diagnosisState) || candidate.controls.maxNativeAttempts < facts.restartAttempt)) return;
  }
  return formalRuleExtractionResultSchema.parse({ caseId: current.record.caseId, caseSha256: current.record.sha256,
    knowledgeSha256: sha256(JSON.stringify(previous.knowledge)), result });
}
