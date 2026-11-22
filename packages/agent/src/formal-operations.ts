import {
  operationsDiagnosisInputSchema, operationsDiagnosisSections, operationsHypothesisCodes, operationsMemoryPressureThreshold, operationsRecommendationCodes,
  whiskersEndpointSchema, type OperationsDiagnosisInput, type OperationsDiagnosisSection,
} from '@itervane/contracts';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import type { ModelAdapter } from '@itervane/model';
import { sha256, shaSchema, type AgentSpec } from './contracts.js';
import { createFormalOperationsHarness, type AgentHost, type AgentRunOptions } from './harness.js';
import { agentText } from './messages.js';

const limits: AgentSpec['limits'] = {
  maxTurns: 9, maxToolCalls: 4, maxTokens: 16_000, maxContextBytes: 20_480,
  maxDurationMs: 90_000, maxStalledTurns: 3, maxRepairs: 1,
};
const catalogSha256 = sha256(JSON.stringify({
  version: 1, tools: ['read_operations', 'finish_role', 'request_human'], sections: operationsDiagnosisSections,
  hypotheses: operationsHypothesisCodes, recommendations: operationsRecommendationCodes,
  memoryPressureThreshold: operationsMemoryPressureThreshold,
}));

type OperationsOptions = {
  input: { sha256: string; document: OperationsDiagnosisInput };
  serverId: string;
  checkpointer: BaseCheckpointSaver;
  model: ModelAdapter;
  providerSha256: string;
  authorize: AgentHost['authorize'];
  read: (input: { section: OperationsDiagnosisSection; operationId: string; signal: AbortSignal }) =>
    Promise<{ proofSha256: string; result: unknown }>;
};

export function createFormalOperations({ input, serverId, checkpointer, model, providerSha256, authorize, read }: OperationsOptions) {
  const document = operationsDiagnosisInputSchema.parse(input.document);
  const { request } = document;
  if (input.sha256 !== sha256(JSON.stringify(document)) || document.requestSha256 !== sha256(JSON.stringify(request))) {
    throw new Error('formal_operations_input_binding');
  }
  const target = { containerId: request.containerId, serverId: whiskersEndpointSchema.shape.serverId.parse(serverId),
    releaseOperationId: request.releaseOperationId, manifestDigest: request.manifestDigest };
  const host: AgentHost = {
    authorize,
    async observe({ call, operationId, scope, signal }) {
      signal.throwIfAborted();
      if (call.name !== 'read_operations') throw new Error('formal_operations_tool_denied');
      const { section } = call.args;
      // The domain reader resolves the target and uses operationId to resume the same read.
      const { proofSha256, result } = await read({ section, operationId, signal });
      return { origin: 'formal_operations', bindingSha256: scope.bindingSha256, snapshotSha256: scope.snapshotSha256,
        data: { kind: 'operations_section', section, proofSha256, result } };
    },
  };
  const spec: AgentSpec = {
    taskId: document.taskId, runId: document.runId, projectId: request.projectId, generation: document.generation,
    source: request.source, snapshotSha256: document.requestSha256, catalogSha256, baselineSha256: request.mappingSha256,
    locale: document.locale, limits, goal: agentText(document.locale).formalOperations.goal,
  };
  const harness = createFormalOperationsHarness({ checkpointer, model, host }, {
    inputSha256: input.sha256, providerSha256: shaSchema.parse(providerSha256), target,
  });
  return { run: (options?: AgentRunOptions) => harness.run(spec, options) };
}
