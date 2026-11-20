import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { report } from './report.js';

const execute = promisify(execFile);
// Constant read-only script: caller-controlled strings never become remote shell code.
const inspection = `printf 'OS='; uname -s
printf 'ARCH='; uname -m
printf 'CPU='; getconf _NPROCESSORS_ONLN
printf 'KVM='; if test -c /dev/kvm && test -r /dev/kvm && test -w /dev/kvm; then echo usable; else echo unavailable; fi
printf 'VIRTUALIZATION='; if grep -Eq '(^| )(vmx|svm)( |$)' /proc/cpuinfo; then echo present; else echo absent; fi
printf 'VIRSH='; if command -v virsh >/dev/null 2>&1; then virsh --version; else echo missing; fi`;

export function cloudArguments(env: NodeJS.ProcessEnv): string[] | undefined {
  const target = env.ITERVANE_VALIDATION_SSH;
  if (!target) return undefined;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@:[\]-]{0,253}$/.test(target)) throw new Error('Invalid SSH target');
  const port = Number(env.ITERVANE_SSH_PORT ?? 22);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid SSH port');
  const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', '-p', String(port)];
  if (env.ITERVANE_SSH_IDENTITY) args.push('-i', env.ITERVANE_SSH_IDENTITY, '-o', 'IdentitiesOnly=yes');
  return [...args, target, inspection];
}

export async function probeCloud(env: NodeJS.ProcessEnv = process.env) {
  const args = cloudArguments(env);
  if (!args) return report('cloud', [{ id: 'ssh-configuration', status: 'blocked', detail: 'Configure a verified SSH target locally.' }]);
  let stdout: string;
  try { ({ stdout } = await execute('ssh', args, { timeout: 20_000, maxBuffer: 64 * 1024 })); }
  catch { return report('cloud', [{ id: 'ssh-connection', status: 'blocked', detail: 'SSH failed. Verify the login, key, and known_hosts locally; no host-key checking was bypassed.' }]); }
  const values = new Map(stdout.trim().split(/\r?\n/).map(line => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  return report('cloud', [
    { id: 'linux-host', status: values.get('OS') === 'Linux' ? 'passed' : 'blocked', detail: 'Linux reference host check; target identifiers are omitted.' },
    { id: 'kvm-device', status: values.get('KVM') === 'usable' ? 'passed' : 'blocked', detail: values.get('KVM') === 'usable' ? 'KVM device usable.' : 'No usable KVM device; do not replace VM isolation with ordinary containers.' },
    { id: 'cpu-virtualization', status: values.get('VIRTUALIZATION') === 'present' ? 'passed' : 'blocked', detail: values.get('VIRTUALIZATION') === 'present' ? 'Virtualization flags exposed.' : 'Virtualization CPU flags not exposed.' },
    { id: 'libvirt', status: values.get('VIRSH') && values.get('VIRSH') !== 'missing' ? 'passed' : 'blocked', detail: values.get('VIRSH') && values.get('VIRSH') !== 'missing' ? 'virsh installed.' : 'virsh unavailable; lifecycle not verified.' },
    { id: 'disposable-vm-lifecycle', status: 'blocked', detail: 'A successful read-only host inspection is not VM lifecycle, network isolation, or cleanup evidence.' },
  ]);
}
