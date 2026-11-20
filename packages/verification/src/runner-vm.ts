import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { localeSchema, sha256Schema, type Check } from '@itervane/contracts';
import { report } from './report.js';

const outcomes = {
  passed: ['passed', 'The paused KVM guest met the profile, replied to the heartbeat, and was removed.', 'KVM 临时域通过暂停状态配置核对与心跳，并已销毁清理。'],
  kvm_unavailable: ['blocked', 'A usable x86-64 Linux KVM device is required.', '需要可用的 Linux x86-64 KVM 设备。'],
  config_required: ['blocked', 'Provide a private staging directory, a trusted raw image, and its SHA-256.', '请提供专用暂存目录、可信 raw 镜像和对应 SHA-256。'],
  libvirt_unavailable: ['blocked', 'The local system libvirt connection and KVM capabilities are required.', '需要本机 system libvirt 连接及 KVM 域能力。'],
  workspace_busy: ['blocked', 'Another probe holds the staging lock.', '另一轮探针占用了暂存目录锁。'],
  pending_cleanup: ['blocked', 'Reconcile a previous run in the staging directory before starting again.', '暂存目录有上一轮待核对记录，请核对后再启动。'],
  image_rejected: ['failed', 'The raw image could not be copied within the disk and digest constraints.', '复制 raw 镜像时未满足磁盘或摘要约束。'],
  domain_conflict: ['failed', 'The generated domain identity is already in use.', '本轮生成的临时域标识已被占用。'],
  profile_rejected: ['failed', 'The domain did not match the paused transient profile.', '实际域与暂停状态下的临时域配置不一致。'],
  heartbeat_rejected: ['failed', 'The guest heartbeat returned an unexpected response.', '客体心跳返回了非预期响应。'],
  deadline_exceeded: ['failed', 'The lifecycle exceeded its deadline.', '探针超出了生命周期时限。'],
  cancelled: ['blocked', 'The lifecycle probe was cancelled.', '生命周期探针已取消。'],
  cleanup_unproven: ['failed', 'Cleanup could not be confirmed. Inspect the staging journal before another run.', '未能确认清理完成，请先核对暂存目录中的运行记录。'],
  host_error: ['failed', 'The local driver did not complete a lifecycle operation.', '本机驱动未能完成生命周期操作。'],
  driver_lost: ['failed', 'The native driver exited without a valid result. Check for an unresolved staging journal.', '原生驱动结束时缺少有效结果，请检查暂存目录是否有待核对记录。'],
} as const satisfies Record<string, readonly [Check['status'], string, string]>;

const resultSchema = z.strictObject({
  code: z.enum(Object.keys(outcomes) as (keyof typeof outcomes)[]),
  runId: z.uuidv4().nullable(),
  imageSha256: sha256Schema.nullable(),
});

type DriverResult = z.infer<typeof resultSchema>;
const lost: DriverResult = { code: 'driver_lost', runId: null, imageSha256: null };

export function parseRunnerProbeOutput(stdout: string, expectedDigest: string): DriverResult {
  try {
    const result = resultSchema.parse(JSON.parse(stdout));
    if (result.imageSha256 !== null && result.imageSha256 !== expectedDigest) return lost;
    if (result.code === 'passed' && (!result.runId || !result.imageSha256)) return lost;
    if (result.code === 'cleanup_unproven' && !result.runId) return lost;
    return result;
  } catch {
    return lost;
  }
}

function launch(root: string, image: string, digest: string): Promise<DriverResult> {
  const script = fileURLToPath(new URL('../../runner/host/libvirt_probe.py', import.meta.url));
  return new Promise(resolve => {
    let cancelled = false;
    const child = execFile('/usr/bin/python3', ['-I', '-B', script, root, image, digest], {
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      timeout: 200_000,
      killSignal: 'SIGKILL',
      maxBuffer: 4096,
    }, (error, stdout) => {
      process.off('SIGINT', requestStop);
      process.off('SIGTERM', requestStop);
      if (error) return resolve(lost);
      const result = parseRunnerProbeOutput(stdout, digest);
      resolve(cancelled && result.code === 'passed' ? { ...result, code: 'cancelled' } : result);
    });

    function requestStop() {
      cancelled = true;
      child.kill('SIGTERM');
    }

    process.on('SIGINT', requestStop);
    process.on('SIGTERM', requestStop);
  });
}

export async function probeRunnerVm(env: NodeJS.ProcessEnv = process.env) {
  const locale = localeSchema.catch('en').parse(env.ITERVANE_RUNNER_PROBE_LOCALE);
  const { ITERVANE_RUNNER_PROBE_ROOT = '', ITERVANE_RUNNER_PROBE_IMAGE = '',
    ITERVANE_RUNNER_PROBE_IMAGE_SHA256 = '' } = env;
  const result = process.platform === 'linux' && process.arch === 'x64'
    ? await launch(ITERVANE_RUNNER_PROBE_ROOT, ITERVANE_RUNNER_PROBE_IMAGE, ITERVANE_RUNNER_PROBE_IMAGE_SHA256)
    : { code: 'kvm_unavailable', runId: null, imageSha256: null } as const;

  const [status, en, zh] = outcomes[result.code];
  const check: Check = { id: 'runner-' + result.code.replaceAll('_', '-'), status, detail: locale === 'zh-CN' ? zh : en };
  if (result.runId) check.detail += (locale === 'zh-CN' ? ' 运行标识 ' : ' Run ID ') + result.runId + '.';
  if (result.imageSha256) check.detail += ' SHA-256 ' + result.imageSha256 + '.';
  return report('runner-vm', [check]);
}
