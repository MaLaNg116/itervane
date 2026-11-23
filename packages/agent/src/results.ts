import type { Locale } from '@itervane/contracts';
import {
  auditReportSchema, auditScannerSchema, checkKinds, completionSchemas, repairReportSchema, verificationReportSchema,
  type AgentEvidence, type AuditReport, type RepairReport, type VerificationReport,
} from './contracts.js';
import { agentText } from './messages.js';
import { finishRepairInputSchema, formalRepairCompletionSchema } from './repair-contracts.js';
import {
  finishVerificationInputSchema, formalVerificationCompletionSchema, pendingVerificationSections,
  verificationObservations, type VerificationSection,
} from './verification-contracts.js';

type Completion = { summary: string; evidenceIds: string[] };

function cited(evidence: readonly AgentEvidence[], ids: readonly string[]) {
  const selected = ids.map(id => evidence.find(item => item.id === id));
  return selected.every(item => item !== undefined) ? selected : undefined;
}

function explainAudit(evidence: readonly AgentEvidence[], raw: unknown, requiredIds: readonly string[], facts: {
  coverage: AuditReport['coverage']; limits: string[]; findings: Array<Omit<AuditReport['findings'][number], 'impact' | 'suggestion'>>;
}): AuditReport | undefined {
  const result = completionSchemas.audit.safeParse(raw);
  if (!result.success) return;
  const input = result.data;
  const receipts = cited(evidence, input.evidenceIds);
  if (!receipts || !requiredIds.every(id => input.evidenceIds.includes(id)) || input.explanations.length !== facts.findings.length) return;
  const explanations = new Map(input.explanations.map(item => [item.findingId, item]));
  const ids = new Set(facts.findings.map(item => item.id));
  if (ids.size !== facts.findings.length || facts.findings.some(item => !explanations.has(item.id))) return;
  if (input.hypotheses.some(item => !cited(evidence, item.evidenceIds))) return;
  return auditReportSchema.parse({
    summary: input.summary, evidenceIds: input.evidenceIds, hypotheses: input.hypotheses,
    coverage: facts.coverage, limits: facts.limits, findings: facts.findings.map(item => {
      const explanation = explanations.get(item.id)!;
      return { ...item, impact: explanation.impact, suggestion: explanation.suggestion };
    }),
  });
}

export function finishAudit(evidence: readonly AgentEvidence[], raw: unknown): AuditReport | undefined {
  const reports = evidence.filter(item => item.data.kind === 'findings');
  const report = reports[0];
  if (reports.length !== 1 || report?.data.kind !== 'findings') return;
  return explainAudit(evidence, raw, [report.id], report.data);
}

export function finishFormalAudit(evidence: readonly AgentEvidence[], raw: unknown, locale: Locale): AuditReport | undefined {
  const scans = evidence.flatMap(({ data, id }) => data.kind === 'scan' ? [{ ...data, id }] : []);
  if (scans.length !== auditScannerSchema.options.length || new Set(scans.map(scan => scan.scanner)).size !== scans.length
    || new Set(scans.map(scan => scan.inspectionSha256)).size !== 1) return;
  const partial = scans.some(scan => scan.totalFindings > scan.findings.length);
  const text = agentText(locale).formal;
  return explainAudit(evidence, raw, scans.map(scan => scan.id), {
    coverage: partial ? 'partial' : 'complete', limits: partial ? [text.scope, text.truncated] : [text.scope],
    findings: scans.flatMap(scan => scan.findings),
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

export function finishFormalRepair(evidence: readonly AgentEvidence[], raw: unknown) {
  const result = finishRepairInputSchema.safeParse(raw);
  if (!result.success) return;
  const data = evidence.find(item => item.id === result.data.evidenceId)?.data;
  if (data?.kind !== 'repair_candidate') return;
  return formalRepairCompletionSchema.parse({ ...result.data, operationId: data.candidate.operationId,
    receiptSha256: data.receiptSha256, candidateManifestSha256: data.candidate.candidateManifestSha256 });
}

export function finishFormalVerification(evidence: readonly AgentEvidence[], raw: unknown) {
  const input = finishVerificationInputSchema.safeParse(raw);
  if (!input.success || pendingVerificationSections(evidence).length) return;
  const observations = verificationObservations(evidence);
  if (observations.length !== input.data.evidenceIds.length || observations.some(item => !input.data.evidenceIds.includes(item.id))
      || input.data.followUps.some(item => !input.data.evidenceIds.includes(item.evidenceId))
      || new Set(observations.map(item => item.receiptSha256)).size !== 1
      || new Set(observations.map(item => item.snapshotSha256)).size !== 1
      || new Set(observations.map(item => item.section)).size !== observations.length) return;
  const source = observations.find(item => item.section === 'source');
  const build = observations.find(item => item.section === 'build');
  const baseline = observations.find(item => item.section === 'baseline');
  const image = observations.find(item => item.section === 'image');
  if (!source || !build || !baseline || (image && baseline.result.status !== 'passed')) return;
  const unverified: VerificationSection[] = [];
  if (source.result.status !== 'compared') unverified.push('source');
  if (build.result.status !== 'built' && build.result.status !== 'failed') unverified.push('build');
  const followup = 'healthFollowup' in baseline.result ? baseline.result.healthFollowup : undefined;
  if ((baseline.result.status !== 'passed' && baseline.result.status !== 'failed') || followup?.status === 'unavailable') unverified.push('baseline');
  if (image?.result.status !== 'scanned' || !image.result.archive) unverified.push('image');

  let outcome: 'observed' | 'checks_failed' | 'source_findings' | 'incomplete' = 'observed';
  if (build.result.status === 'failed' || baseline.result.status === 'failed' || followup?.status === 'unhealthy') outcome = 'checks_failed';
  else if (source.result.status === 'compared' && (source.result.introduced > 0 || source.result.remaining > 0)) outcome = 'source_findings';
  else if (unverified.length) outcome = 'incomplete';

  return formalVerificationCompletionSchema.parse({
    ...input.data, outcome, unverified, source: source.result,
    receiptSha256: source.receiptSha256, candidateManifestSha256: source.snapshotSha256,
  });
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
