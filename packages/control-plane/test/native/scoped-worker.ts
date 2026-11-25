import { equal, match, notEqual, ok } from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const workerAccount = 'itervane-inspection-client';

export function exitStatus(child: ChildProcess) {
  return new Promise<number | null>(resolve => {
    child.once('error', () => resolve(null));
    child.once('close', code => resolve(code));
  });
}

export async function firstLine(child: ChildProcess, timeoutMs = 8_000) {
  if (!child.stdout) throw new Error('probe_stdout');
  const lines = createInterface({ input: child.stdout });
  try {
    const [first] = await once(lines, 'line', { signal: AbortSignal.timeout(timeoutMs) });
    return String(first);
  } finally { lines.close(); child.stdout.resume(); }
}

export async function boundedExit(child: ChildProcess, exit: Promise<number | null>, timeMs: number) {
  const timeout = new AbortController();
  try {
    return await Promise.race([exit, delay(timeMs, undefined, { signal: timeout.signal }).then(() => {
      child.kill();
      throw new Error('process_exit_timeout');
    })]);
  } finally { timeout.abort(); }
}

export function sourceWorkerEnvironment(socket: string, controllerUid: string, image: string) {
  return ['PATH=/usr/bin:/bin', 'LANG=C.UTF-8', `ITERVANE_RUNNER_SOCKET=${socket}`,
    `ITERVANE_RUNNER_UID=${controllerUid}`, `ITERVANE_RUNNER_IMAGE_SHA256=${image}`, 'ITERVANE_WORKER_LEASE_SECONDS=30'];
}

export async function startScopedWorker(bundle: string, environment: string[], secrets: Record<string, string>) {
  const entries = Object.entries(secrets);
  const loadSecrets = entries.map(([name, value]) => {
    match(name, /^[A-Z][A-Z0-9_]*$/);
    ok(!/[\r\n]/.test(value));
    return `IFS= read -r ${name}; export ${name};`;
  }).join(' ');
  const child = spawn('/usr/bin/sudo', ['-n', '-u', workerAccount, '--', '/usr/bin/env', '-i', ...environment,
    '/usr/bin/setpriv', '--no-new-privs', '/bin/bash', '-c',
    `set -eu; ${loadSecrets} printf "%s\\n" "$$"; exec "$@"`, 'itervane-worker', process.execPath, bundle,
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exit = exitStatus(child);
  child.stderr.resume();
  child.stdin.on('error', () => undefined);
  const pidLine = firstLine(child);
  child.stdin.end(entries.map(([, value]) => value + '\n').join(''));
  try {
    const pid = await pidLine;
    match(pid, /^[1-9][0-9]{0,9}$/);
    let stopped = false;
    return { pid, async stop(mode: 'TERM' | 'KILL') {
      if (stopped) return;
      stopped = true;
      await execute('/usr/bin/sudo', ['-n', '-u', workerAccount, '--', '/bin/kill', `-${mode}`, pid], { timeout: 5_000 });
      const code = await boundedExit(child, exit, 15_000);
      if (mode === 'TERM') equal(code, 0);
      else notEqual(code, 0);
    } };
  } catch (error) { child.kill(); await boundedExit(child, exit, 5_000); throw error; }
}
