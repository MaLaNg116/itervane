import { formalVerificationEvidenceSchema, formalVerificationInputSchema, type FormalVerificationEvidence,
  type FormalVerificationInput } from '@itervane/contracts';
import type { ModelAdapter } from '@itervane/model';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { sha256, shaSchema, type AgentSpec } from './contracts.js';
import { createFormalVerificationHarness, type AgentHost } from './harness.js';
import { agentText } from './messages.js';
import { verificationObservationSchema, verificationSections, type VerificationObservation, type VerificationSection } from './verification-contracts.js';

const limits: AgentSpec['limits'] = {
  maxTurns: 10, maxToolCalls: 6, maxTokens: 16_000, maxContextBytes: 32_768,
  maxDurationMs: 90_000, maxStalledTurns: 3, maxRepairs: 1,
};

type VerificationOptions = {
  input: { sha256: string; document: FormalVerificationInput };
  evidence: FormalVerificationEvidence;
  checkpointer: BaseCheckpointSaver;
  model: ModelAdapter;
  providerSha256: string;
  authorize: AgentHost['authorize'];
};

/** The host supplies evidence derived from the checked receipt under the current execution lease. */
export function createFormalVerification({ input, evidence, checkpointer, model, providerSha256, authorize }: VerificationOptions) {
  const document = formalVerificationInputSchema.parse(input.document);
  const facts = formalVerificationEvidenceSchema.parse(evidence);
  const { binding } = facts;
  if (input.sha256 !== sha256(JSON.stringify(document)) || binding.verificationInputSha256 !== input.sha256
      || binding.taskId !== document.taskId || binding.runId !== document.runId || binding.projectId !== document.projectId
      || binding.generation !== document.generation || binding.source.repositoryId !== document.source.repositoryId
      || binding.source.commit !== document.source.commit || binding.subjectManifestSha256 !== document.subject.manifestSha256) {
    throw new Error('formal_verification_evidence_binding');
  }
  const sections = {} as Record<VerificationSection, VerificationObservation>;
  const sectionSha256 = {} as Record<VerificationSection, string>;
  for (const section of verificationSections) {
    const observation = verificationObservationSchema.parse({
      kind: 'verification_section', receiptSha256: binding.receiptSha256, section, result: facts[section],
    });
    sections[section] = observation;
    sectionSha256[section] = sha256(JSON.stringify(observation));
  }

  const host: AgentHost = {
    authorize,
    async observe({ scope, call, signal }) {
      signal.throwIfAborted();
      if (call.name !== 'read_verification') throw new Error('formal_verification_tool_denied');
      return { origin: 'formal_verification', bindingSha256: scope.bindingSha256,
        snapshotSha256: binding.subjectManifestSha256, data: sections[call.args.section] };
    },
  };
  const spec: AgentSpec = {
    taskId: document.taskId, runId: document.runId, projectId: document.projectId, generation: document.generation,
    source: document.source, snapshotSha256: binding.subjectManifestSha256, catalogSha256: document.catalogSha256,
    baselineSha256: document.profile.baselineSha256, locale: document.locale, limits,
    goal: agentText(document.locale).formalVerification.goal,
  };
  const harness = createFormalVerificationHarness({ checkpointer, model, host }, {
    inputSha256: input.sha256, providerSha256: shaSchema.parse(providerSha256), sectionSha256,
  });
  return { run: (options?: Parameters<typeof harness.run>[1]) => harness.run(spec, options) };
}
