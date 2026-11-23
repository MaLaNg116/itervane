import { randomUUID } from 'node:crypto';
import { constants, readFileSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { createInspectionPlan, QualifiedInspectionClient, sha256 } from '@itervane/runner';
import { qualifiedInspectionScopeSchema, sha256Schema, type QualifiedInspectionRequest } from '@itervane/contracts';

const commit = '9167604c888416d7b6518e1c76485d7308cffb5c';
const materializedCommit = 'fbfef7c887323132fac193a4c0b538cc97f60995';
const differentMaterializedCommit = '93ce12b8bcba237ffd98412a188584b225bb0854';
const origin = 'https://github.com/MaLaNg116/itervane.git';
const example = 'fixtures/runner/inspection-input';

async function requireUnprivilegedCaller() {
  if (!process.getuid?.()) throw new Error('controller_client_identity');
  try {
    const device = await open('/dev/kvm', constants.O_RDWR);
    await device.close();
    throw new Error('controller_client_has_kvm');
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || !['EACCES', 'EPERM'].includes(String(error.code))) throw error;
  }
}

async function probeRepair(client: QualifiedInspectionClient, workspaceSha256: string) {
  const previous = JSON.parse(readFileSync(0, 'utf8'));
  const { planSha256: _planSha256, requestId: _requestId, ...source } = qualifiedInspectionScopeSchema.parse(previous.scope);
  const baseSnapshotSha256 = sha256Schema.parse(previous.snapshotSha256);
  if (previous.kind !== 'qualified-scan' || source.workspaceSha256 !== workspaceSha256 || source.commit !== commit) {
    throw new Error('controller_probe_repair_base');
  }
  const path = `${example}/README.md`;
  const before = '127ee6ca0a857feaa9ae6fa40b1204ac9c5e87cb53ebc14c744adffb37cb4bcc';
  const after = 'a9453f75e4f178583b4af83b02e814684e49f4b18c0e69c17a96695942a098cc';
  const request = () => ({ ...source, requestId: randomUUID(), fence: source.fence + 1,
    origin, baseSnapshotSha256, operationId: randomUUID(), repairInputSha256: sha256('native authorized repair fixture') });
  const workspace = (current: ReturnType<typeof request>) => ({
    version: 1 as const, operationId: current.operationId, repairInputSha256: current.repairInputSha256,
    source: { repositoryId: current.repositoryId, commit }, baseSnapshotSha256, editablePaths: [path],
    protectedPaths: [`${example}/original`, `${example}/updated`],
  });
  const patch = (beforeSha256: string) => ({
    version: 1 as const, baseSnapshotSha256, files: [{ path, beforeSha256,
      edits: [{ startByte: 391, endByte: 391, replacement: '\nRepair replays against the sealed snapshot.\n' }] }],
  });
  const deniedRequest = request();
  const denied = await client.repair(deniedRequest, workspace(deniedRequest), patch(before), async () => {
    throw new Error('controller_probe_no_lease');
  });
  if (denied.kind !== 'rejected' || denied.code !== 'lease_lost' || denied.cleanup !== 'not_started' || denied.domainId) {
    throw new Error('controller_probe_repair_lease');
  }
  const staleRequest = request();
  const stale = await client.repair(staleRequest, workspace(staleRequest), patch(sha256('stale revision')), async () => {});
  if (stale.kind !== 'rejected' || stale.code !== 'job_failed' || stale.issue !== 'repair-precondition'
      || stale.cleanup !== 'confirmed' || !stale.domainId) throw new Error('controller_probe_repair_stale');

  const current = request();
  let pulses = 0;
  const result = await client.repair(current, workspace(current), patch(before), async () => { pulses++; });
  if (result.kind !== 'repair_receipt') {
    const failure = (result.issue ?? result.code).replaceAll('-', '_');
    throw new Error('controller_probe_repair_' + failure);
  }
  const { snapshot, domainId, cleanupConfirmed } = result;
  const [change] = snapshot.candidate.changes;
  if (pulses < 2 || domainId === stale.domainId || domainId === previous.domainId || !change || change.path !== path
      || change.beforeSha256 !== before || change.afterSha256 !== after
      || change.beforeBytes !== 391 || change.afterBytes !== 436 || snapshot.files !== 305
      || snapshot.tree !== '8eef89792444aea73d0aa90b87e552bbfc2d25d9') throw new Error('controller_probe_repair_bytes');
  const readMaterialized = async (revision: string) => {
    const taskId = randomUUID(); const runId = randomUUID();
    const requestedSource = { repositoryId: source.repositoryId, commit: revision };
    const plan = createInspectionPlan({ taskId, runId, requestedSource });
    const measured = await client.inspect({ version: 1, taskId, runId, projectId: source.projectId, requestId: randomUUID(),
      ...requestedSource, origin, planSha256: plan.sha256, generation: 1, fence: 1, workspaceSha256,
      materializedFrom: { commit, baseSnapshotSha256 },
    }, async () => {});
    if (measured.kind !== 'receipt' || !measured.snapshot.materializedCandidateSha256 || !measured.cleanupConfirmed
        || measured.snapshot.reports.some(report => report.status !== 'completed')) throw new Error('controller_probe_materialized_receipt');
    return { commit: revision, domainId: measured.domainId, candidateSha256: measured.snapshot.materializedCandidateSha256,
      cleanupConfirmed: measured.cleanupConfirmed };
  };
  const matched = await readMaterialized(materializedCommit);
  const different = await readMaterialized(differentMaterializedCommit);
  if (matched.candidateSha256 !== snapshot.candidate.candidateManifestSha256 || different.candidateSha256 === matched.candidateSha256
      || new Set([matched.domainId, different.domainId, domainId]).size !== 3) throw new Error('controller_probe_materialized_content');
  console.log(JSON.stringify({
    kind: 'qualified-repair', scope: result.scope, domainId, cleanupConfirmed, readOnly: snapshot.readOnly, offline: snapshot.offline,
    candidate: snapshot.candidate, stale: { domainId: stale.domainId, issue: stale.issue, cleanup: stale.cleanup },
    noLease: { cleanup: denied.cleanup, code: denied.code }, pulses, materialized: { matched, different },
    en: 'The authorized Worker received exact repair evidence after VM cleanup.',
    zh: '已授权的 Worker 在虚拟机回收后收到精确的修复回执。',
  }));
}

async function probe() {
  const [socketPath, uid, imageSha256, mode, trigger, ...extra] = process.argv.slice(2);
  if (!socketPath || !uid || !imageSha256 || !mode || extra.length
      || !['scan', 'origin', 'no-lease', 'revoke', 'disconnect', 'repair'].includes(mode)
      || Boolean(trigger) !== ['revoke', 'disconnect'].includes(mode)) throw new Error('controller_probe_config');
  await requireUnprivilegedCaller();
  const client = new QualifiedInspectionClient({ socketPath, controllerUid: Number(uid), imageSha256 });
  const status = await client.observe();
  if (status?.state !== 'idle') throw new Error('controller_probe_not_idle');
  if (mode === 'repair') return probeRepair(client, status.workspaceSha256);
  const taskId = randomUUID(); const runId = randomUUID(); const repositoryId = randomUUID();
  const plan = createInspectionPlan({ taskId, runId, requestedSource: { repositoryId, commit } });
  const request: QualifiedInspectionRequest = {
    version: 1, taskId, runId, projectId: randomUUID(), requestId: randomUUID(), repositoryId, commit,
    planSha256: plan.sha256, workspaceSha256: status.workspaceSha256, generation: 1, fence: 1,
    origin: mode === 'origin' ? 'https://example.invalid/unregistered.git' : origin,
  };
  const outcome = await client.inspect(request, async () => {
    if (mode === 'no-lease') throw new Error('controller_probe_no_lease');
    if (trigger) {
      const triggerExists = await stat(trigger).then(() => true, () => false);
      if (triggerExists) {
        if (mode === 'disconnect') process.exit(0);
        throw new Error('controller_probe_lease_revoked');
      }
    }
  });
  if (mode === 'scan') {
    if (outcome.kind !== 'receipt') throw new Error('controller_probe_scan_' + outcome.code);
    const { snapshot } = outcome;
    const [gitleaks, trivy] = snapshot.reports;
    if (snapshot.tree !== '8eef89792444aea73d0aa90b87e552bbfc2d25d9' || snapshot.files !== 305
        || snapshot.totalBytes !== 1844359 || !gitleaks.findings.some(item => item.path === `${example}/original/config.txt`)
        || !trivy.findings.some(item => item.path === `${example}/original/package-lock.json` && item.ruleId === 'CVE-2021-23337')
        || gitleaks.status !== 'completed' || trivy.status !== 'completed') throw new Error('controller_probe_scan_content');
    console.log(JSON.stringify({
      kind: 'qualified-scan', scope: outcome.scope, domainId: outcome.domainId, imageSha256, snapshotSha256: snapshot.manifestSha256,
      originSha256: outcome.originSha256, readOnly: snapshot.readOnly, offline: snapshot.offline, cleanupConfirmed: outcome.cleanupConfirmed,
      scans: snapshot.reports.map(report => ({ scanner: report.scanner, count: report.findings.length, fingerprint: sha256(JSON.stringify(report)) })),
      en: 'The separate Worker account received scoped scan results and verified VM cleanup.',
      zh: '独立 Worker 账户收到绑定作用域的扫描结果，虚拟机清理已核对。',
    }));
    return;
  }
  if (mode === 'disconnect') throw new Error('controller_probe_disconnect_without_trigger');
  const reason = mode === 'origin' ? 'origin_denied' : 'lease_lost';
  const cleanup = mode === 'revoke' ? 'confirmed' : 'not_started';
  if (outcome.kind !== 'rejected' || outcome.code !== reason || outcome.cleanup !== cleanup
      || Boolean(outcome.domainId) !== (mode === 'revoke')) {
    throw new Error('controller_probe_rejection_' + (outcome.kind === 'rejected' ? outcome.code + '_' + outcome.cleanup : 'receipt'));
  }
  console.log(JSON.stringify({ kind: mode, code: reason, cleanup, domainId: outcome.domainId }));
}

try { await probe(); }
catch (error) {
  const code = error instanceof Error && /^controller_[a-z_]+$/.test(error.message) ? error.message : 'controller_probe_failed';
  console.error(code);
  process.exitCode = 1;
}
