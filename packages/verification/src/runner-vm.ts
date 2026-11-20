import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { localeSchema, sha256Schema, type Check } from '@itervane/contracts';
import { report } from './report.js';

const outcomes = {
  passed: ['passed', 'The paused KVM guest met the profile, replied to the heartbeat, and was removed.', 'KVM 临时域通过暂停状态配置核对与心跳，并已销毁清理。'],
  kvm_unavailable: ['blocked', 'A usable x86-64 Linux KVM device is required.', '需要可用的 Linux x86-64 KVM 设备。'],
  config_required: ['blocked', 'Provide a private staging directory, a trusted raw image, and its SHA-256.', '请提供专用暂存目录、可信 raw 镜像和对应 SHA-256。'],
  libvirt_unavailable: ['blocked', 'The selected local libvirt instance and KVM capabilities are required.', '需要选定的本机 libvirt 实例及 KVM 域能力。'],
  workspace_busy: ['blocked', 'Another probe holds the staging lock.', '另一轮探针占用了暂存目录锁。'],
  pending_cleanup: ['blocked', 'Reconcile a previous run in the staging directory before starting again.', '暂存目录有上一轮待核对记录，请核对后再启动。'],
  image_rejected: ['failed', 'The raw image could not be copied within the disk and digest constraints.', '复制 raw 镜像时未满足磁盘或摘要约束。'],
  domain_conflict: ['failed', 'The generated domain identity is already in use.', '本轮生成的临时域标识已被占用。'],
  profile_rejected: ['failed', 'The domain did not match the paused transient profile.', '实际域与暂停状态下的临时域配置不一致。'],
  session_rejected: ['failed', 'The dedicated session isolation check did not pass.', '专用会话隔离检查未通过。'],
  heartbeat_rejected: ['failed', 'The guest heartbeat returned an unexpected response.', '客体心跳返回了非预期响应。'],
  job_passed: ['passed', 'The isolated guest verified the complete job input.', '隔离客体已核验完整的作业输入。'],
  job_input_rejected: ['failed', 'The isolated guest rejected the job input digest.', '隔离客体拒绝了作业输入摘要。'],
  job_channel_unavailable: ['failed', 'The named guest job channel could not be used.', '无法使用命名客体作业通道。'],
  job_protocol_rejected: ['failed', 'The guest job channel returned an invalid receipt or closed early.', '客体作业通道返回无效回执或提前关闭。'],
  job_deadline_exceeded: ['failed', 'The guest job exceeded its host-side deadline.', '客体作业超出了宿主设定的时限。'],
  source_passed: ['passed', 'The isolated guest verified the registered repository at the fixed commit.', '隔离客体已核验登记仓库的固定提交。'],
  source_rejected: ['failed', 'The host source gateway rejected the Git transfer.', '宿主源码网关拒绝了 Git 传输。'],
  source_guest_failed: ['failed', 'The guest did not complete fixed Git acquisition or object verification.', '客体未完成固定 Git 版本的获取或对象核验。'],
  inspection_passed: ['passed', 'The isolated guest verified and scanned the fixed source snapshot.', '隔离客体已核验并扫描固定源码快照。'],
  deadline_exceeded: ['failed', 'The lifecycle exceeded its deadline.', '探针超出了生命周期时限。'],
  cancelled: ['blocked', 'The lifecycle probe was cancelled.', '生命周期探针已取消。'],
  cleanup_unproven: ['failed', 'Cleanup could not be confirmed. Inspect the staging journal before another run.', '未能确认清理完成，请先核对暂存目录中的运行记录。'],
  host_error: ['failed', 'The local driver did not complete a lifecycle operation.', '本机驱动未能完成生命周期操作。'],
  driver_lost: ['failed', 'The native driver exited without a valid result. Check for an unresolved staging journal.', '原生驱动结束时缺少有效结果，请检查暂存目录是否有待核对记录。'],
} as const satisfies Record<string, readonly [Check['status'], string, string]>;

const prefixBytes = 64 * 1024;
const jobSchema = z.strictObject({
  byteCount: z.int().positive().max(32 * 1024 * 1024),
  startedBytes: z.int().positive().max(prefixBytes),
  inputSha256: sha256Schema,
  receivedSha256: sha256Schema.nullable(),
  workloadVerified: z.boolean().optional(),
});
const gitObjectId = z.string().regex(/^[0-9a-f]{40}$/);
const sourceSchema = z.strictObject({
  originSha256: sha256Schema,
  commit: gitObjectId,
  tree: gitObjectId,
  commitSha256: sha256Schema,
  files: z.int().min(1).max(5000),
  requests: z.int().min(2).max(8),
  transferredBytes: z.int().min(1).max(32 * 1024 * 1024),
});
const scanProof = {
  policySha256: sha256Schema, findings: z.int().min(1).max(2000), resultSha256: sha256Schema,
};
const repairProof = z.strictObject({
  path: z.literal('fixtures/runner/inspection-input/README.md'),
  baseSnapshotSha256: sha256Schema, beforeSha256: sha256Schema, afterSha256: sha256Schema,
  patchSha256: sha256Schema, candidateManifestSha256: sha256Schema,
  replayed: z.literal(true), protectedRejected: z.literal(true), staleRejected: z.literal(true),
  rangeRejected: z.literal(true), originalRetained: z.literal(true),
});
const inspectionSchema = z.strictObject({
  runId: z.uuidv4(), commit: gitObjectId, tree: gitObjectId, manifestSha256: sha256Schema,
  files: z.int().min(1).max(5000), totalBytes: z.int().positive().max(32 * 1024 * 1024),
  inputsSha256: sha256Schema, readOnly: z.literal(true), offline: z.literal(true),
  controlsChecked: z.literal(true), missingDatabaseRejected: z.literal(true),
  gitleaks: z.strictObject({ ...scanProof, version: z.literal('8.30.1') }),
  trivy: z.strictObject({ ...scanProof, version: z.literal('0.76.2'), databaseSha256: sha256Schema, databaseUpdatedAt: z.iso.datetime() }),
  repair: repairProof,
});
const probeSettingsSchema = z.object({
  scenario: z.enum(['heartbeat', 'job', 'job-reject-input', 'job-cancel', 'job-timeout', 'source', 'inspect']).default('heartbeat'),
  mode: z.enum(['system', 'session']).default('system'),
}).refine(({ scenario, mode }) => !['source', 'inspect'].includes(scenario) || mode === 'session');
const jobIssueSchema = z.enum(['open-channel', 'guest-ready', 'prefix', 'result']);
const sourceIssueSchema = z.enum([
  'source-open', 'source-ready', 'source-fetch', 'source-closed', 'source-objects',
  'guest-input', 'git-fetch', 'git-objects', 'guest-io',
  'origin-rejected', 'address-rejected', 'fetch-request-rejected', 'commit-rejected',
  'request-budget', 'route-rejected', 'https-failed', 'redirect-rejected', 'response-rejected', 'transfer-budget',
  'scan-results', 'snapshot-rejected', 'scan-boundary', 'scan-inputs', 'scan-gitleaks', 'scan-trivy', 'scan-controls', 'scan-integrity',
]);
type ProbeSettings = z.infer<typeof probeSettingsSchema>;

const resultSchema = z.strictObject({
  code: z.enum(Object.keys(outcomes) as (keyof typeof outcomes)[]),
  runId: z.uuidv4().nullable(),
  imageSha256: sha256Schema.nullable(),
  profileIssue: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).nullable().optional(),
  cleanupConfirmed: z.boolean().optional(),
  job: jobSchema.nullable().optional(),
  jobIssue: z.union([jobIssueSchema, sourceIssueSchema]).nullable().optional(),
  sessionVerified: z.boolean().optional(),
  source: sourceSchema.nullable().optional(),
  inspection: inspectionSchema.nullable().optional(),
});

type DriverResult = z.infer<typeof resultSchema>;
const lost: DriverResult = { code: 'driver_lost', runId: null, imageSha256: null };

export function parseRunnerProbeOutput(
  stdout: string,
  expectedDigest: string,
  mode: ProbeSettings['mode'] = 'system',
  scenario?: ProbeSettings['scenario'],
): DriverResult {
  try {
    const result = resultSchema.parse(JSON.parse(stdout));
    if (result.imageSha256 !== null && result.imageSha256 !== expectedDigest) return lost;
    if (result.code === 'passed' && (!result.runId || !result.imageSha256)) return lost;
    if (result.profileIssue && !['profile_rejected', 'session_rejected', 'host_error', 'cleanup_unproven'].includes(result.code)) return lost;
    if (result.code === 'cleanup_unproven' && !result.runId) return lost;
    if ((result.cleanupConfirmed || result.job || result.source) && (!result.runId || !result.imageSha256)) return lost;
    if (result.code === 'cleanup_unproven' && result.cleanupConfirmed) return lost;
    if (result.sessionVerified && (mode !== 'session' || !result.cleanupConfirmed || result.code === 'session_rejected')) return lost;
    const requiresSessionProof = result.code === 'passed' || result.code === 'job_passed' || (result.job && result.cleanupConfirmed);
    if (mode === 'session' && requiresSessionProof && !result.sessionVerified) return lost;
    if (mode === 'session' && result.job && !result.job.workloadVerified) return lost;
    const sourceScenario = scenario === 'source' || scenario === 'inspect';
    const sourceFailure = result.code === 'source_rejected' || result.code === 'source_guest_failed';
    const sourcePassed = result.code === 'source_passed';
    const inspectionPassed = result.code === 'inspection_passed';
    if (sourceScenario && (mode !== 'session' || result.job || ['passed', 'job_passed', 'job_input_rejected'].includes(result.code))) return lost;
    if (!sourceScenario && (result.source || sourceFailure || sourcePassed || inspectionPassed)) return lost;
    if ((sourcePassed || inspectionPassed) && (!result.sessionVerified || !result.source || result.jobIssue)) return lost;
    if ((sourcePassed && scenario !== 'source') || (result.source && !sourcePassed && !inspectionPassed)) return lost;
    if (inspectionPassed) {
      const { inspection, source } = result;
      if (scenario !== 'inspect' || !inspection || !source || inspection.runId !== result.runId
          || inspection.commit !== source.commit || inspection.tree !== source.tree || inspection.files !== source.files
          || inspection.repair.baseSnapshotSha256 !== inspection.manifestSha256
          || inspection.repair.beforeSha256 === inspection.repair.afterSha256) return lost;
    } else if (result.inspection) return lost;
    if (sourceFailure && (!result.runId || !result.imageSha256 || !result.jobIssue)) return lost;
    if (result.jobIssue) {
      const issueSchema = sourceScenario ? sourceIssueSchema : jobIssueSchema;
      const jobFailure = ['job_channel_unavailable', 'job_protocol_rejected', 'job_deadline_exceeded', 'cleanup_unproven'].includes(result.code);
      if ((!jobFailure && !sourceFailure) || !issueSchema.safeParse(result.jobIssue).success) return lost;
    }
    if (result.job && result.job.startedBytes !== Math.min(result.job.byteCount, prefixBytes)) return lost;
    if (result.code === 'job_passed' || result.code === 'job_input_rejected') {
      if (!result.cleanupConfirmed || !result.job?.receivedSha256) return lost;
      const digestMatches = result.job.receivedSha256 === result.job.inputSha256;
      if (digestMatches !== (result.code === 'job_passed')) return lost;
    }
    return result;
  } catch {
    return lost;
  }
}

function launch(root: string, image: string, digest: string, settings: ProbeSettings): Promise<DriverResult> {
  const script = fileURLToPath(new URL('../../runner/host/libvirt_probe.py', import.meta.url));
  return new Promise(resolve => {
    let cancelled = false;
    const child = execFile('/usr/bin/python3', ['-I', '-B', script, root, image, digest, settings.scenario, settings.mode], {
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      timeout: 200_000,
      killSignal: 'SIGKILL',
      maxBuffer: 4096,
    }, (error, stdout) => {
      process.off('SIGINT', requestStop);
      process.off('SIGTERM', requestStop);
      if (error) return resolve(lost);
      const result = parseRunnerProbeOutput(stdout, digest, settings.mode, settings.scenario);
      const succeeded = ['passed', 'job_passed', 'source_passed', 'inspection_passed'].includes(result.code);
      resolve(cancelled && succeeded ? { ...result, code: 'cancelled', source: null, inspection: null } : result);
    });

    function requestStop() {
      cancelled = true;
      child.kill('SIGTERM');
    }

    process.on('SIGINT', requestStop);
    process.on('SIGTERM', requestStop);

    if (settings.scenario === 'job-cancel') {
      let event = '';
      child.stderr?.on('data', (chunk: Buffer | string) => {
        event += chunk.toString();
        if (event === 'itervane-job-input-started\n') requestStop();
      });
    }
  });
}

export async function probeRunnerVm(env: NodeJS.ProcessEnv = process.env) {
  const locale = localeSchema.catch('en').parse(env.ITERVANE_RUNNER_PROBE_LOCALE);
  const zh = locale === 'zh-CN';
  const settings = probeSettingsSchema.safeParse({ scenario: env.ITERVANE_RUNNER_PROBE_SCENARIO, mode: env.ITERVANE_RUNNER_PROBE_MODE });
  const { ITERVANE_RUNNER_PROBE_ROOT = '', ITERVANE_RUNNER_PROBE_IMAGE = '',
    ITERVANE_RUNNER_PROBE_IMAGE_SHA256 = '' } = env;
  const result: DriverResult = !settings.success
    ? { code: 'config_required', runId: null, imageSha256: null }
    : process.platform === 'linux' && process.arch === 'x64'
      ? await launch(ITERVANE_RUNNER_PROBE_ROOT, ITERVANE_RUNNER_PROBE_IMAGE, ITERVANE_RUNNER_PROBE_IMAGE_SHA256, settings.data)
      : { code: 'kvm_unavailable', runId: null, imageSha256: null };

  const [status, english, chinese] = outcomes[result.code];
  const check: Check = { id: 'runner-' + result.code.replaceAll('_', '-'), status, detail: zh ? chinese : english };
  if (result.runId) check.detail += (zh ? ' 运行标识 ' : ' Run ID ') + result.runId + '.';
  if (result.imageSha256) check.detail += ' SHA-256 ' + result.imageSha256 + '.';
  if (result.profileIssue) check.detail += (zh ? ' 配置差异 ' : ' Profile issue ') + result.profileIssue + '.';
  if (result.jobIssue) check.detail += (zh ? ' 作业阶段 ' : ' Job phase ') + result.jobIssue + '.';
  const checks = [check];
  if (result.job) {
    checks.push({
      id: 'runner-job-started', status: 'passed',
      detail: zh
        ? `客体已确认收到 ${result.job.startedBytes} / ${result.job.byteCount} 字节。输入 SHA-256 ${result.job.inputSha256}。`
        : `The guest acknowledged ${result.job.startedBytes} of ${result.job.byteCount} bytes. Input SHA-256 ${result.job.inputSha256}.`,
    });
    if (result.job.receivedSha256) {
      checks.push({
        id: 'runner-job-receipt', status: 'passed',
        detail: (zh ? '客体计算的完整输入 SHA-256 ' : 'Guest-computed SHA-256 of all received bytes ') + result.job.receivedSha256 + '.',
      });
    }
  }
  if (result.source) {
    const { originSha256, commit, tree, commitSha256, files, requests, transferredBytes } = result.source;
    checks.push({
      id: 'runner-source-objects', status: 'passed',
      detail: zh
        ? `客体已核验提交 ${commit}、树 ${tree} 和 ${files} 个文件。提交内容 SHA-256 ${commitSha256}。`
        : `The guest verified commit ${commit}, tree ${tree}, and ${files} files. Commit content SHA-256 ${commitSha256}.`,
    }, {
      id: 'runner-source-egress-closed', status: 'passed',
      detail: zh
        ? `已核验固定来源 SHA-256 ${originSha256}。完成 ${requests} 次请求，接收 ${transferredBytes} 字节。出口关闭后的请求已被阻断。`
        : `The fixed origin SHA-256 was ${originSha256}. Transferred ${transferredBytes} bytes across ${requests} requests. A request after closure was rejected.`,
    });
  }
  if (result.inspection) {
    const { manifestSha256, totalBytes, inputsSha256, gitleaks, trivy, repair } = result.inspection;
    checks.push({
      id: 'runner-inspection-snapshot', status: 'passed',
      detail: zh ? `扫描前后均核验了 ${totalBytes} 字节。清单 SHA-256 ${manifestSha256}。`
        : `Verified ${totalBytes} bytes before and after scanning. Manifest SHA-256 ${manifestSha256}.`,
    }, {
      id: 'runner-inspection-offline', status: 'passed',
      detail: zh ? `扫描账户的源码挂载为只读，IP socket 和源码通道均被拒绝。封存输入 SHA-256 ${inputsSha256}。`
        : `The scan account had read-only source mounts and was denied IP sockets and the source port. Sealed input SHA-256 ${inputsSha256}.`,
    }, {
      id: 'runner-inspection-gitleaks', status: 'passed',
      detail: zh
        ? `Gitleaks ${gitleaks.version} 归一化 ${gitleaks.findings} 个发现，合成密钥对照通过。策略 ${gitleaks.policySha256}，结果 ${gitleaks.resultSha256}。`
        : `Gitleaks ${gitleaks.version} normalized ${gitleaks.findings} findings and passed the synthetic secret controls. Policy ${gitleaks.policySha256}. Result ${gitleaks.resultSha256}.`,
    }, {
      id: 'runner-inspection-trivy', status: 'passed',
      detail: zh
        ? `Trivy ${trivy.version} 归一化 ${trivy.findings} 个发现，锁文件对照及缺库拒绝通过。策略 ${trivy.policySha256}，结果 ${trivy.resultSha256}。数据库 SHA-256 ${trivy.databaseSha256}，更新于 ${trivy.databaseUpdatedAt}。`
        : `Trivy ${trivy.version} normalized ${trivy.findings} findings, passed the lockfile controls, and rejected the missing database. Policy ${trivy.policySha256}. Result ${trivy.resultSha256}. Database SHA-256 ${trivy.databaseSha256} at ${trivy.databaseUpdatedAt}.`,
    }, {
      id: 'runner-repair-replay', status: 'passed',
      detail: zh
        ? `对 ${repair.path} 的补丁已重放，保留原始文件，拒绝受保护路径、过期摘要和跨字符字节区间。修改前 SHA-256 ${repair.beforeSha256}，修改后 ${repair.afterSha256}。补丁 ${repair.patchSha256}，候选清单 ${repair.candidateManifestSha256}。`
        : `Replayed the patch for ${repair.path} and preserved the original. Rejected a protected path, stale digest and split character. Before SHA-256 ${repair.beforeSha256}. After ${repair.afterSha256}. Patch ${repair.patchSha256}. Candidate manifest ${repair.candidateManifestSha256}.`,
    });
  }
  if (settings.success && settings.data.scenario !== 'heartbeat' && result.cleanupConfirmed) {
    checks.push({
      id: 'runner-job-cleaned', status: 'passed',
      detail: zh ? '已独立核对域消失，临时磁盘和运行记录已移除。' : 'A fresh lookup confirmed domain removal. The working disk and run journal were removed.',
    });
  }
  if (result.sessionVerified) {
    checks.push({
      id: 'runner-dedicated-session', status: 'passed',
      detail: zh ? '已核对专用非 root 会话、宿主标记拒绝和实际 QEMU 进程退出。' : 'A dedicated non-root session denied access to the host marker, and the identified QEMU process exited.',
    });
  }
  if (result.job?.workloadVerified) {
    checks.push({
      id: 'runner-guest-workload', status: 'passed',
      detail: zh
        ? '独立客体身份通过了可写作业目录、宿主标记不可见、受保护文件与设备、网络及资源限制检查。'
        : 'The dedicated guest workload verified its writable task directory, hidden host marker, protected file and device, network, and resource limits.',
    });
  }
  return report('runner-vm', checks);
}
