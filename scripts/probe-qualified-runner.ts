import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { createInspectionPlan, QualifiedInspectionClient, sha256 } from '@itervane/runner';
import type { QualifiedInspectionRequest } from '@itervane/contracts';

const commit = '9167604c888416d7b6518e1c76485d7308cffb5c';
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

async function probe() {
  const [socketPath, uid, imageSha256, mode, trigger, ...extra] = process.argv.slice(2);
  if (!socketPath || !uid || !imageSha256 || !mode || extra.length
      || !['scan', 'origin', 'no-lease', 'revoke', 'disconnect'].includes(mode)
      || Boolean(trigger) !== ['revoke', 'disconnect'].includes(mode)) throw new Error('controller_probe_config');
  await requireUnprivilegedCaller();
  const client = new QualifiedInspectionClient({ socketPath, controllerUid: Number(uid), imageSha256 });
  const taskId = randomUUID(); const runId = randomUUID(); const repositoryId = randomUUID();
  const plan = createInspectionPlan({ taskId, runId, requestedSource: { repositoryId, commit } });
  const request: QualifiedInspectionRequest = {
    version: 1, taskId, runId, projectId: randomUUID(), requestId: randomUUID(), repositoryId, commit,
    planSha256: plan.sha256, generation: 1, fence: 1,
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
