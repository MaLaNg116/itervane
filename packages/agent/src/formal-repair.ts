import {
  formalAuditResultSchema, formalRepairInputSchema, qualifiedRepairObservationResponseSchema, qualifiedRepairResponseSchema,
  repairPatchSchema, type FormalAuditResult, type FormalRepairInput, type QualifiedRepairObservationResponse,
  type QualifiedRepairResponse, type RepairObservation, type RepairPatch,
} from '@itervane/contracts';
import type { ModelAdapter } from '@itervane/model';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { sha256, shaSchema, type AgentSpec } from './contracts.js';
import { createFormalRepairHarness, type AgentHost, type AgentRunOptions } from './harness.js';
import { agentText } from './messages.js';
import { repairFailureCodeSchema, type RepairFailureCode } from './repair-contracts.js';
import { repairActionSha256, type PlannedTool } from './tools.js';

type ApplyCall = Extract<PlannedTool, { name: 'apply_repair_template' | 'apply_repair_patch' }>;
type RepairProposal = { callKeySha256: string; findingIds: string[]; patch: RepairPatch };
type Rejection = Extract<QualifiedRepairResponse, { kind: 'rejected' }>;
type RepairOptions = {
  input: { sha256: string; document: FormalRepairInput };
  audit: FormalAuditResult;
  checkpointer: BaseCheckpointSaver;
  model: ModelAdapter;
  providerSha256: string;
  authorize: AgentHost['authorize'];
  readTargets(findingIds: readonly string[], signal: AbortSignal): Promise<QualifiedRepairObservationResponse>;
  apply(proposal: RepairProposal, signal: AbortSignal): Promise<QualifiedRepairResponse>;
};

const limits: AgentSpec['limits'] = {
  maxTurns: 12, maxToolCalls: 8, maxTokens: 20_000, maxContextBytes: 32_768,
  maxDurationMs: 180_000, maxStalledTurns: 3, maxRepairs: 1,
};

function rejectionCode(outcome: Rejection) {
  if (outcome.cleanup === 'unknown') return 'cleanup_unproven';
  return repairFailureCodeSchema.safeParse(outcome.issue ?? outcome.code).data ?? 'job_failed';
}

function compileProposal(call: ApplyCall, observation: RepairObservation) {
  const template = call.name === 'apply_repair_template' ? call.args : null;
  const editsByTarget = call.name === 'apply_repair_patch' ? call.args.targets : [{ targetIndex: call.args.targetIndex, edits: [] }];
  const files = new Map<string, RepairPatch['files'][number]>();
  const findingIds = new Set<string>();
  for (const { targetIndex, edits } of editsByTarget) {
    const target = observation.targets[targetIndex];
    if (target?.status !== 'text' || !target.file || (target.line !== null && !target.range)) return;
    const { file, range } = target;
    if (template && (!range || !target.templates.includes(template.templateId))) return;
    const replacements = template && range ? [{ startByte: range.startByte, endByte: range.endByte, replacement: '' }] : edits;
    if (replacements.some(edit => edit.startByte < (range?.startByte ?? 0) || edit.endByte > (range?.endByte ?? file.bytes)
      || (range && edit.startByte === range.endByte))) return;
    const change = files.get(target.path);
    if (change && change.beforeSha256 !== file.sha256) return;
    if (change) change.edits.push(...replacements);
    else files.set(target.path, { path: target.path, beforeSha256: file.sha256, edits: [...replacements] });
    findingIds.add(target.findingId);
  }
  const patch = repairPatchSchema.safeParse({ version: 1, baseSnapshotSha256: observation.baseSnapshotSha256,
    files: [...files.values()].sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
      .map(file => ({ ...file, edits: file.edits.sort((left, right) => left.startByte - right.startByte) })),
  }).data;
  return patch && { patch, findingIds: [...findingIds].sort() };
}

export function createFormalRepair({ input, audit: rawAudit, checkpointer, model, providerSha256, authorize, readTargets, apply }: RepairOptions) {
  const document = formalRepairInputSchema.parse(input.document);
  const audit = formalAuditResultSchema.parse(rawAudit);
  const { checklist } = audit;
  const { taskId, runId, projectId, generation, source, locale, catalogSha256, inspection } = document;
  const { snapshotSha256 } = inspection;
  if (input.sha256 !== sha256(JSON.stringify(document)) || document.audit.resultSha256 !== sha256(JSON.stringify(audit))
    || audit.status !== 'completed' || checklist?.coverage !== 'complete' || checklist.hypotheses.length
    || audit.checkpointId !== document.audit.checkpointId || audit.inputSha256 !== document.audit.inputSha256
    || audit.taskId !== taskId || audit.runId !== runId || audit.projectId !== projectId || audit.generation !== generation
    || audit.locale !== locale || audit.catalogSha256 !== catalogSha256 || audit.inspectionSha256 !== inspection.receiptSha256
    || audit.snapshotSha256 !== snapshotSha256 || JSON.stringify(document.findingIds) !== JSON.stringify(checklist.findings.map(finding => finding.id))) {
    throw new Error('formal_repair_audit_binding');
  }
  const findings = checklist.findings.map(({ id, ruleId, severity, certainty, scanner }) => ({ id, ruleId, severity, certainty, scanner }));

  function requireReceipt(receipt: Exclude<QualifiedRepairObservationResponse | QualifiedRepairResponse, Rejection>) {
    const { scope, snapshot, domainId } = receipt;
    if (scope.taskId !== taskId || scope.runId !== runId || scope.projectId !== projectId || scope.generation !== generation
      || scope.repositoryId !== source.repositoryId || scope.commit !== source.commit || scope.repairInputSha256 !== input.sha256
      || scope.baseSnapshotSha256 !== snapshotSha256 || snapshot.manifestSha256 !== snapshotSha256
      || snapshot.runId !== domainId || snapshot.repositoryId !== source.repositoryId || snapshot.commit !== source.commit
      || snapshot.commandSha256 !== scope.commandSha256) throw new Error('formal_repair_receipt_binding');
  }
  const host: AgentHost = {
    authorize,
    async observe({ scope, call, operationId, evidence, signal }) {
      signal.throwIfAborted();
      const base = { origin: 'formal_repair' as const, bindingSha256: scope.bindingSha256, snapshotSha256 };
      const actionSha256 = repairActionSha256(call);
      if (call.name !== 'read_repair_targets' && call.name !== 'apply_repair_template' && call.name !== 'apply_repair_patch') {
        throw new Error('formal_repair_tool_denied');
      }
      const failure = (code: RepairFailureCode) =>
        ({ ...base, data: { kind: 'repair_failure', action: call.name, actionSha256, code } });
      if (call.name === 'read_repair_targets') {
        const receipt = qualifiedRepairObservationResponseSchema.parse(await readTargets([...call.args.findingIds].sort(), signal));
        if (receipt.kind === 'rejected') return failure(rejectionCode(receipt));
        requireReceipt(receipt);
        const { observation } = receipt.snapshot;
        if (observation.operationId !== receipt.scope.operationId || observation.repairInputSha256 !== input.sha256
          || observation.targets.some(target => !findings.some(finding => finding.id === target.findingId && finding.scanner === target.scanner))) {
          throw new Error('formal_repair_observation_binding');
        }
        return { ...base, data: { kind: 'repair_targets', actionSha256, receiptSha256: sha256(JSON.stringify(receipt)), observation } };
      }
      const entry = evidence.find(item => item.id === call.args.observationId);
      // Only the guest observation supplies paths, byte ranges and the original file hash.
      const proposal = entry?.data.kind === 'repair_targets' && entry.data.observation.repairInputSha256 === input.sha256
        ? compileProposal(call, entry.data.observation) : undefined;
      if (!proposal) return failure('invalid_proposal');
      const receipt = qualifiedRepairResponseSchema.parse(await apply({ callKeySha256: operationId, ...proposal }, signal));
      if (receipt.kind === 'rejected') return failure(rejectionCode(receipt));
      requireReceipt(receipt);
      const { candidate } = receipt.snapshot;
      if (candidate.operationId !== receipt.scope.operationId || candidate.repairInputSha256 !== input.sha256
        || candidate.patchSha256 !== sha256(JSON.stringify(proposal.patch))) throw new Error('formal_repair_candidate_binding');
      return { ...base, data: { kind: 'repair_candidate', action: call.name, actionSha256, observationId: call.args.observationId,
        receiptSha256: sha256(JSON.stringify(receipt)), candidate } };
    },
  };
  const spec: AgentSpec = { taskId, runId, projectId, generation, source, snapshotSha256, locale, catalogSha256,
    baselineSha256: inspection.planSha256, goal: agentText(locale).formalRepair.goal, limits };
  const harness = createFormalRepairHarness({ model, checkpointer, host }, {
    inputSha256: input.sha256, providerSha256: shaSchema.parse(providerSha256), findings,
  });
  return { run: (options?: AgentRunOptions) => harness.run(spec, options) };
}
