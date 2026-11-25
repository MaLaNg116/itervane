import { deepStrictEqual, equal, notEqual, ok } from 'node:assert/strict';
import type { Client } from '@modelcontextprotocol/client';
import {
  formalAuditDtoSchema, qualifiedInspectionResponseSchema, sha256Schema, sourceInspectionDtoSchema, taskRuleSnapshotViewSchema,
  type Locale, type PublishedCodeScanEvidence, type TaskDto,
} from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import type { databaseFixture } from '../helpers/database.js';

export const ruleReuseRevisions = {
  violation: '10e95785b608fff1a231c10d8f5ee02efb4cc6a9',
  clean: '35751364b222c229a7969decafaa7d35fedc86e7',
} as const;

type PublishedRule = {
  packageId: string; packageKey: string; versionId: string; versionSha256: string; reviewSha256: string | null; sequence: number;
};
type Request = (path: string, payload?: object, human?: boolean, locale?: Locale) => Promise<unknown>;

export function summarizePublishedRuleScan({ sha256: evidenceSha256, document }: PublishedCodeScanEvidence) {
  const { basis, reports } = document;
  equal(sha256(JSON.stringify(document)), evidenceSha256);
  const findings = reports.flatMap(report => {
    equal(report.status, 'checked');
    return report.findings;
  });
  return { evidenceSha256, manifestSha256: basis.manifestSha256, ruleSnapshotSha256: basis.snapshotSha256,
    ruleSetSha256: basis.ruleSetSha256, profile: basis.profile, batches: basis.batches, findings };
}

/** Compare the published version and recorded scan to what the two formal read interfaces expose. */
export async function readNativeRuleReuse(task: TaskDto, rule: PublishedRule, expectedMatches: 0 | 1,
  { request, mcp, admin }: { request: Request; mcp: Client; admin: Awaited<ReturnType<typeof databaseFixture>>['admin'] }) {
  const taskId = task.id;
  const base = `/v1/tasks/${taskId}`;
  const readMcp = async (name: string) => (await mcp.callTool({ name, arguments: { taskId } })).structuredContent;
  const pinned = taskRuleSnapshotViewSchema.parse(await request(`${base}/rule-snapshot`, undefined, false, 'zh-CN'));
  deepStrictEqual(taskRuleSnapshotViewSchema.parse(await readMcp('get_task_rule_snapshot')), pinned);
  const english = taskRuleSnapshotViewSchema.parse(await request(`${base}/rule-snapshot`, undefined, false, 'en'));
  equal(english.locale, 'en');
  notEqual(english.message, pinned.message);
  deepStrictEqual(english.snapshot, pinned.snapshot);
  ok(pinned.snapshot);
  const { document, sha256: pinnedSha256 } = pinned.snapshot;
  equal(document.projectId, task.projectId);
  equal(document.taskId, taskId);
  equal(document.purpose, 'delivery');
  const { packageId, packageKey, versionId, versionSha256, reviewSha256, sequence } = rule;
  deepStrictEqual(document.entries, [{ packageId, packageKey, versionId, versionSha256, sequence,
    reviewSha256: sha256Schema.parse(reviewSha256), kind: 'code_rule' }]);
  equal(sha256(JSON.stringify(document)), pinnedSha256);

  const inspection = sourceInspectionDtoSchema.parse(await request(`${base}/source-inspection`));
  deepStrictEqual(sourceInspectionDtoSchema.parse(await readMcp('get_source_inspection')), inspection);
  ok(inspection.status === 'completed' && inspection.result.publishedCode?.status === 'complete');
  equal(inspection.result.publishedCode.findings, expectedMatches);
  ok(inspection.result.publishedCode.checkedFiles > 0);
  deepStrictEqual(inspection.requestedSource, task.source);
  for (const report of inspection.result.scans) {
    equal(report.status, 'completed');
    equal(report.findingsCount, 0);
  }
  const { rows } = await admin.query<{ receipt: unknown; receipt_sha256: string }>(`SELECT receipt, receipt_sha256
    FROM itervane.inspection_attempts WHERE run_id=$1 AND state='recorded'`, [task.runId]);
  equal(rows.length, 1);
  const stored = rows[0]!;
  const receipt = qualifiedInspectionResponseSchema.parse(stored.receipt);
  ok(receipt.kind === 'receipt' && receipt.snapshot.publishedCode);
  equal(receipt.scope.taskId, taskId);
  equal(receipt.scope.runId, task.runId);
  equal(receipt.scope.projectId, task.projectId);
  equal(stored.receipt_sha256, sha256(JSON.stringify(receipt)));
  equal(stored.receipt_sha256, inspection.result.receiptSha256);
  deepStrictEqual(receipt.snapshot.publishedCode.manifest.source, task.source);
  const scan = summarizePublishedRuleScan(receipt.snapshot.publishedCode.scan);
  equal(scan.manifestSha256, inspection.result.snapshotSha256);
  equal(scan.ruleSnapshotSha256, pinnedSha256);
  equal(scan.evidenceSha256, inspection.result.publishedCode.evidenceSha256);
  deepStrictEqual(scan.findings.map(({ path, ruleKey }) => ({ path, ruleKey })), expectedMatches
    ? [{ path: 'server/readiness.mjs', ruleKey: rule.packageKey }] : []);

  const audit = formalAuditDtoSchema.parse(await request(`${base}/audit`, undefined, false, 'zh-CN'));
  deepStrictEqual(formalAuditDtoSchema.parse(await readMcp('get_audit')), audit);
  ok(audit.status === 'recorded' && audit.result.status === 'completed' && audit.result.checklist);
  equal(audit.result.inspectionSha256, stored.receipt_sha256);
  const observation = audit.result.evidence.find(item => item.kind === 'scan' && item.scanner === 'semgrep_ce');
  ok(observation?.kind === 'scan');
  equal(observation.totalFindings, expectedMatches);
  equal(observation.policySha256, scan.ruleSetSha256);
  ok(audit.result.trace.some(item => item.tool === 'read_scan' && item.evidenceId === observation.id));
  deepStrictEqual(audit.result.checklist.findings.map(({ path, ruleId, scanner }) => ({ path, ruleId, scanner })), expectedMatches
    ? [{ path: 'server/readiness.mjs', ruleId: rule.packageKey, scanner: 'semgrep_ce' }] : []);
  return { taskId, runId: task.runId, projectId: task.projectId, source: task.source, state: task.state, pin: document.entries[0]!,
    scan, auditSha256: audit.sha256, inspectionReceiptSha256: stored.receipt_sha256, domainId: receipt.domainId,
    cleanupConfirmed: receipt.cleanupConfirmed, sessionVerified: receipt.sessionVerified, httpMcpAgreement: true, bilingual: true };
}
