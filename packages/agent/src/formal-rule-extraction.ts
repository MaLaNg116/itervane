import { extractionCaseSchema, learningKnowledgeSchema, type ExtractionCase, type LearningKnowledge } from '@itervane/contracts';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import type { ModelAdapter } from '@itervane/model';
import { sha256, shaSchema, type AgentSpec } from './contracts.js';
import { createFormalRuleExtractionHarness, type AgentHost, type AgentRunOptions } from './harness.js';
import { agentText } from './messages.js';

const limits: AgentSpec['limits'] = {
  maxTurns: 8, maxToolCalls: 2, maxTokens: 18_000, maxContextBytes: 28_672,
  maxDurationMs: 90_000, maxStalledTurns: 3, maxRepairs: 1,
};
const catalogSha256 = sha256(JSON.stringify({ version: 1, tools: [
  'read_learning_case', 'search_learning_knowledge', 'finish_role', 'request_human',
] }));

type ExtractionOptions = {
  caseRecord: ExtractionCase; knowledge: LearningKnowledge; knowledgeSha256: string;
  coordinates: Pick<AgentSpec, 'taskId' | 'runId' | 'projectId' | 'generation' | 'source' | 'locale'>;
  checkpointer: BaseCheckpointSaver; model: ModelAdapter; providerSha256: string; authorize: AgentHost['authorize'];
};

export function createFormalRuleExtraction({ caseRecord, knowledge: rawKnowledge, knowledgeSha256,
  coordinates, checkpointer, model, providerSha256, authorize }: ExtractionOptions) {
  const record = extractionCaseSchema.parse(caseRecord);
  const knowledge = learningKnowledgeSchema.parse(rawKnowledge);
  if (sha256(JSON.stringify(record.document)) !== record.sha256 || sha256(JSON.stringify(knowledge)) !== knowledgeSha256
      || record.document.projectId !== coordinates.projectId || knowledge.category !== record.document.facts.category
      || knowledge.cases.some(item => item.caseId === record.caseId)) throw new Error('rule_extraction_input_binding');
  const host: AgentHost = {
    authorize,
    async observe({ scope, call, signal }) {
      signal.throwIfAborted();
      const binding = { origin: 'formal_rule_extraction' as const, bindingSha256: scope.bindingSha256, snapshotSha256: scope.snapshotSha256 };
      if (call.name === 'read_learning_case') return { ...binding, data: { kind: 'learning_case', record } };
      if (call.name === 'search_learning_knowledge') return { ...binding, data: { kind: 'learning_knowledge', knowledge } };
      throw new Error('formal_rule_extraction_tool_denied');
    },
  };
  const spec: AgentSpec = { ...coordinates, limits, snapshotSha256: record.sha256, catalogSha256, baselineSha256: knowledgeSha256,
    goal: agentText(coordinates.locale).formalRuleExtraction.goal };
  const harness = createFormalRuleExtractionHarness({ checkpointer, model, host }, {
    providerSha256: shaSchema.parse(providerSha256), caseId: record.caseId, caseSha256: record.sha256, knowledgeSha256,
  });
  return { run: (options?: AgentRunOptions) => harness.run(spec, options) };
}
