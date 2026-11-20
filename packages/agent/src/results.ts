import {
  auditReportSchema, checkKinds, completionSchemas, repairReportSchema, verificationReportSchema,
  type AgentEvidence, type AuditReport, type RepairReport, type VerificationReport,
} from './contracts.js';

type Completion = { summary: string; evidenceIds: string[] };

function cited(evidence: readonly AgentEvidence[], ids: readonly string[]) {
  const selected = ids.map(id => evidence.find(item => item.id === id));
  return selected.every(item => item !== undefined) ? selected : undefined;
}

export function finishAudit(evidence: readonly AgentEvidence[], raw: unknown): AuditReport | undefined {
  const result = completionSchemas.audit.safeParse(raw);
  if (!result.success) return;
  const input = result.data;
  const receipts = cited(evidence, input.evidenceIds);
  const protectedReports = evidence.filter(item => item.data.kind === 'findings');
  if (protectedReports.length !== 1 || !receipts?.includes(protectedReports[0]!)) return;
  const found = protectedReports[0]!.data;
  if (found?.kind !== 'findings' || input.explanations.length !== found.findings.length) return;
  const explanations = new Map(input.explanations.map(item => [item.findingId, item]));
  if (found.findings.some(item => !explanations.has(item.id))) return;
  if (input.hypotheses.some(item => !cited(evidence, item.evidenceIds))) return;
  return auditReportSchema.parse({
    summary: input.summary, evidenceIds: input.evidenceIds, hypotheses: input.hypotheses,
    coverage: found.coverage, limits: found.limits, findings: found.findings.map(item => {
      const explanation = explanations.get(item.id)!;
      return { ...item, impact: explanation.impact, suggestion: explanation.suggestion };
    }),
  });
}

export function finishRepair(evidence: readonly AgentEvidence[], raw: unknown): RepairReport | undefined {
  const result = completionSchemas.repair.safeParse(raw);
  if (!result.success) return;
  const input = result.data;
  const receipts = cited(evidence, input.evidenceIds);
  const candidates = receipts?.filter(item => item.data.kind === 'candidate');
  if (candidates?.length !== 1) return;
  const data = candidates[0]!.data;
  if (data.kind !== 'candidate') return;
  return repairReportSchema.parse({ ...input, candidate: data.candidate });
}

export function finishVerify(evidence: readonly AgentEvidence[], raw: unknown, audit: AuditReport, repair: RepairReport): VerificationReport | undefined {
  const result = completionSchemas.verify.safeParse(raw);
  if (!result.success) return;
  const input: Completion = result.data;
  const receipts = cited(evidence, input.evidenceIds);
  if (!receipts) return;
  const target = repair.candidate.snapshotSha256;
  const protectedReceipts = evidence.filter(item => item.data.kind === 'check' && item.snapshotSha256 === target);
  if (protectedReceipts.some(item => !receipts.includes(item))) return;
  const checks = protectedReceipts.flatMap(item => item.data.kind === 'check' ? [item.data.result] : []);
  if (checks.length !== checkKinds.length || !checkKinds.every(kind => checks.some(item => item.check === kind))) return;
  const known = audit.findings.map(item => item.id);
  const actual = new Set(checks.flatMap(item => item.findingIds));
  const remaining = known.filter(id => actual.has(id));
  const added = [...actual].filter(id => !known.includes(id)).sort();
  const unverified = checks.filter(item => item.status === 'unavailable').map(item => item.check);
  const failed = checks.some(item => item.status === 'failed');
  return verificationReportSchema.parse({
    ...input, snapshotSha256: target, checks, remaining, added, unverified,
    resolved: unverified.length ? [] : known.filter(id => !actual.has(id)),
    outcome: unverified.length ? 'unverified' : failed || actual.size ? 'needs_repair' : 'verified_fixture',
  });
}
