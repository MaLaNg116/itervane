import { learningCandidateSemanticSha256, type AgentEvidence } from '@itervane/agent';
import { learningCandidateSchema } from '@itervane/contracts';

const codeRule = learningCandidateSchema.parse({
  kind: 'code_rule', key: 'literal-health-error-response',
  text: {
    en: { title: 'Review hard-coded unavailable responses', appliesTo: 'JSON responses in application health handlers', limitation: 'Maintenance and deliberate fallback responses require review.' },
    'zh-CN': { title: '检查写死的服务不可用响应', appliesTo: '应用健康处理器的 JSON 响应', limitation: '需要人工区分维护和有意设置的降级。' },
  },
  check: { engine: 'semgrep_ce', language: 'javascript', pattern: '$RESPONSE.status(503).json(...)' },
  samples: {
    violation: 'reply.status(503).json({ status: "unhealthy" });',
    corrected: 'reply.status(200).json({ status: "ok" });',
    lookalike: 'const diagnostic = { lastHealthStatus: 503 };',
  },
});
const runbook = learningCandidateSchema.parse({
  kind: 'runbook', key: 'restart-verified-stopped-app',
  text: {
    en: { title: 'Recover a stopped instance', appliesTo: 'A stopped instance of the currently verified publication', limitation: 'Stop when the result or identity is uncertain.' },
    'zh-CN': { title: '恢复停止的实例', appliesTo: '当前已核验发布中停止的实例', limitation: '实例或结果无法确认时转人工。' },
  },
  action: 'restart_current_publication', when: { observedStates: ['exited', 'dead'] },
  controls: { publicationBinding: 'exact', approval: 'portal_and_whiskers', maxNativeAttempts: 1,
    stopOn: ['target_drift', 'unknown_outcome', 'failed_health'] },
  success: { instance: 'same', newerStart: true, healthStatus: 200, access: 'protected' },
  samples: {
    eligible: { observedState: 'exited', publication: 'current', approvals: 'both' },
    healthy: { observedState: 'running', publication: 'current', approvals: 'both' },
    stale: { observedState: 'exited', publication: 'superseded', approvals: 'both' },
    unapproved: { observedState: 'exited', publication: 'current', approvals: 'missing' },
  },
});

export function extractionFixtureCall(observations: readonly AgentEvidence[]) {
  const observedCase = observations.find(item => item.data.kind === 'learning_case');
  if (observedCase?.data.kind !== 'learning_case') return { name: 'read_learning_case', input: {} };
  const prior = observations.find(item => item.data.kind === 'learning_knowledge');
  if (prior?.data.kind !== 'learning_knowledge') return { name: 'search_learning_knowledge', input: {} };
  const candidate = observedCase.data.record.document.facts.category === 'recovered_stopped_instance' ? runbook : codeRule;
  const found = prior.data.knowledge.candidates.find(item => item.semanticSha256 === learningCandidateSemanticSha256(candidate));
  return { name: 'finish_role', input: {
    evidenceIds: [observedCase.id, prior.id], rationale: '核验结算支持在所列条件下复用。',
    ...(found ? { outcome: 'duplicate', existingCandidateId: found.id } : { outcome: 'candidate', candidate }),
  } };
}
