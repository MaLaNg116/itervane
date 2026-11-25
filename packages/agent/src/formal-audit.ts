import {
  formalAuditInputSchema, qualifiedInspectionResponseSchema, requiredAuditScanners,
  type AuditScanner, type FormalAuditInput, type Locale, type QualifiedInspectionReceipt,
} from '@itervane/contracts';
import type { ModelAdapter } from '@itervane/model';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { auditFindingsPerScan, formalReceiptSchema, sha256, shaSchema, type AgentSpec, type FormalAuditReceipt } from './contracts.js';
import { createFormalAuditHarness, type AgentHost, type AgentRunOptions } from './harness.js';
import { agentText } from './messages.js';
import { finishFormalAudit } from './results.js';

type Scan = QualifiedInspectionReceipt['snapshot']['reports'][number];
type AuditScan = Pick<Scan, 'version' | 'policySha256' | 'findings' | 'database'> & { scanner: AuditScanner };
type ProjectedScan = Extract<FormalAuditReceipt['data'], { kind: 'scan' }>;
type ProjectedRule = Extract<FormalAuditReceipt['data'], { kind: 'rule' }>;
const severityRank = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 };
const auditLimits: AgentSpec['limits'] = {
  maxTurns: 12, maxToolCalls: 8, maxTokens: 20_000, maxContextBytes: 32_768,
  maxDurationMs: 90_000, maxStalledTurns: 3, maxRepairs: 1,
};

export function publishedAuditScan(receipt: QualifiedInspectionReceipt): AuditScan | undefined {
  const { scope, snapshot } = receipt;
  const recorded = snapshot.publishedCode;
  if (!recorded) return;
  const { scan } = recorded;
  const { basis, reports } = scan.document;
  if (sha256(JSON.stringify(scan.document)) !== scan.sha256 || recorded.commandSha256 !== scope.publishedCode?.commandSha256
      || basis.taskId !== scope.taskId || basis.projectId !== scope.projectId || basis.manifestSha256 !== snapshot.manifestSha256
      || basis.source.repositoryId !== scope.repositoryId || basis.source.commit !== scope.commit
      || basis.profile.runnerImageSha256 !== receipt.imageSha256 || reports.some(report => report.status === 'unavailable')) {
    throw new Error('formal_audit_published_scan_binding');
  }
  const findings = reports.flatMap(report => report.status === 'checked' ? report.findings.map(match => ({
    id: sha256(JSON.stringify([scan.sha256, match.ruleKey, match.path, match.start, match.end])),
    ruleId: match.ruleKey, path: match.path, line: match.start.line, severity: 'unknown' as const,
  })) : []);
  return { scanner: 'semgrep_ce', version: basis.profile.engineVersion, policySha256: basis.ruleSetSha256, findings, database: null };
}

function projectScan(scan: AuditScan, inspectionSha256: string, locale: Locale): ProjectedScan {
  const text = agentText(locale).formal;
  const title = { gitleaks: text.secret, trivy: text.dependency, semgrep_ce: text.publishedRule }[scan.scanner];
  // The authoritative receipt retains the exact path. Only a line number and opaque finding ID reach the model.
  const findings = scan.findings.toSorted((left, right) =>
    severityRank[left.severity] - severityRank[right.severity] || left.id.localeCompare(right.id))
    .slice(0, auditFindingsPerScan).map(({ id, ruleId, severity, line }) => ({
      id, ruleId, severity, certainty: scan.scanner === 'gitleaks' ? 'suspected' as const : 'confirmed' as const,
      title, location: line === null ? text.file : `${text.line} ${line}`,
    }));
  return { kind: 'scan', scanner: scan.scanner, version: scan.version, inspectionSha256, policySha256: scan.policySha256,
    databaseSha256: scan.database?.sha256 ?? null, totalFindings: scan.findings.length, findings };
}

type AuditOptions = {
  input: { sha256: string; document: FormalAuditInput }; inspection: QualifiedInspectionReceipt;
  checkpointer: BaseCheckpointSaver; model: ModelAdapter; providerSha256: string; authorize: AgentHost['authorize'];
};

// The Worker obtains these inputs under its current lease from the verified inspection and audit records.
export function createFormalAudit({ input, inspection, checkpointer, model, providerSha256, authorize }: AuditOptions) {
  const document = formalAuditInputSchema.parse(input.document);
  const receipt = qualifiedInspectionResponseSchema.parse(inspection);
  if (receipt.kind !== 'receipt') throw new Error('formal_audit_receipt_missing');
  const scope = receipt.scope;
  const pinned = document.inspection;
  if (input.sha256 !== sha256(JSON.stringify(document)) || pinned.receiptSha256 !== sha256(JSON.stringify(receipt))
    || pinned.requestId !== scope.requestId || pinned.planSha256 !== scope.planSha256
    || document.taskId !== scope.taskId || document.runId !== scope.runId || document.projectId !== scope.projectId
    || document.generation !== scope.generation || document.source.repositoryId !== scope.repositoryId || document.source.commit !== scope.commit
    || receipt.snapshot.runId !== receipt.domainId || receipt.snapshot.repositoryId !== scope.repositoryId || receipt.snapshot.commit !== scope.commit
    || pinned.snapshotSha256 !== receipt.snapshot.manifestSha256) throw new Error('formal_audit_receipt_binding');

  const scans = new Map<AuditScanner, ProjectedScan>();
  for (const scanner of requiredAuditScanners(false)) {
    const scan = receipt.snapshot.reports.find(report => report.scanner === scanner);
    if (!scan || scan.status !== 'completed' || scan.snapshotSha256 !== pinned.snapshotSha256) throw new Error('formal_audit_scan_incomplete');
    scans.set(scanner, projectScan(scan, pinned.receiptSha256, document.locale));
  }
  const published = publishedAuditScan(receipt);
  if (published) scans.set(published.scanner, projectScan(published, pinned.receiptSha256, document.locale));
  const text = agentText(document.locale).formal;
  const rules = new Map<string, ProjectedRule>(document.catalog.rules.map(rule => {
    const { guidance, limitation } = rule.material.text[document.locale];
    return [rule.material.id, { kind: 'rule' as const, ruleId: rule.material.id, sha256: rule.sha256,
      guidance: guidance.slice(0, 480).toWellFormed(), limitation: limitation.slice(0, 480).toWellFormed() }];
  }));
  const { designGuidance } = document;
  if (designGuidance) {
    for (const entry of designGuidance.entries) {
      rules.set(entry.ruleId, { kind: 'rule', ruleId: entry.ruleId, sha256: entry.reference.versionSha256,
        guidance: entry.guidance, limitation: text.designGuidanceLimit,
        designSkill: { authority: 'advisory', snapshotSha256: designGuidance.snapshotSha256, reference: entry.reference, version: entry.version } });
    }
  }
  const reproduction = document.healthReproduction && {
    kind: 'health_reproduction' as const, reproduction: document.healthReproduction,
    check: 'second_health_request' as const, statusCode: 503 as const,
  };
  if (reproduction && (document.generation !== 2 || document.runId === reproduction.reproduction.previousRunId
      || pinned.snapshotSha256 !== reproduction.reproduction.subjectManifestSha256)) throw new Error('formal_audit_health_binding');
  if (rules.size !== document.catalog.rules.length + (designGuidance?.entries.length ?? 0)) throw new Error('formal_audit_catalog_duplicate');
  const host: AgentHost = {
    authorize,
    async observe({ scope: current, call, signal }) {
      signal.throwIfAborted();
      const base = { origin: 'formal_audit' as const, bindingSha256: current.bindingSha256, snapshotSha256: pinned.snapshotSha256 };
      if (call.name === 'read_scan') return { ...base, data: scans.get(call.args.scanner) };
      if (call.name === 'read_rule') return { ...base, data: rules.get(call.args.ruleId) };
      if (call.name === 'read_health_reproduction' && reproduction) return { ...base, data: reproduction };
      throw new Error('formal_audit_tool_denied');
    },
  };
  const spec: AgentSpec = {
    taskId: document.taskId, runId: document.runId, projectId: document.projectId, generation: document.generation,
    source: document.source, snapshotSha256: pinned.snapshotSha256, catalogSha256: document.catalog.sha256,
    baselineSha256: pinned.planSha256, locale: document.locale,
    goal: (published ? text.goalWithPublished : text.goal) + (designGuidance ? ' ' + text.designGuidanceLimit : ''), limits: auditLimits,
  };
  const harness = createFormalAuditHarness({ checkpointer, model, host }, {
    inputSha256: input.sha256, providerSha256: shaSchema.parse(providerSha256), ruleIds: [...rules.keys()],
    ...(reproduction ? { healthReproduction: true as const } : {}),
    ...(published ? { publishedCode: true as const } : {}),
  });
  return {
    async run(options?: AgentRunOptions) {
      const report = await harness.run(spec, options);
      if (!report.checkpointId) return report;
      for (const { id, data } of report.evidence) {
        const expected = data.kind === 'scan' ? scans.get(data.scanner) : data.kind === 'rule' ? rules.get(data.ruleId)
          : data.kind === 'health_reproduction' ? reproduction : undefined;
        const canonical = formalReceiptSchema.parse({ origin: 'formal_audit', bindingSha256: report.bindingSha256,
          snapshotSha256: pinned.snapshotSha256, data: expected });
        if (sha256(JSON.stringify(canonical)) !== id) throw new Error('formal_audit_checkpoint_evidence');
      }
      if (report.audit) {
        if (reproduction && !report.evidence.some(item => item.data.kind === 'health_reproduction')) {
          throw new Error('formal_audit_health_missing');
        }
        const { summary, evidenceIds, hypotheses, findings } = report.audit;
        const audit = finishFormalAudit(report.evidence, { summary, evidenceIds, hypotheses,
          explanations: findings.map(({ id, impact, suggestion }) => ({ findingId: id, impact, suggestion })),
        }, document.locale, Boolean(published));
        if (JSON.stringify(audit) !== JSON.stringify(report.audit)) throw new Error('formal_audit_checkpoint_conclusion');
      }
      return report;
    },
  };
}
