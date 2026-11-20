import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { promisify } from 'node:util';
import { z } from 'zod';
import { whiskersOrigin } from '../../../verification/src/native/whiskers.js';

const execute = promisify(execFile);
const labelKey = 'io.itervane.whiskers-probe';
const publishedWhiskers = 'ghcr.io/lupusmalusdeviant/whiskers:0.15.0@sha256:876510ea689a7cca7c6d36a8c1d60f5b5cf09549ece6d4ad2d54e29aa599148c';
export const adminEmail = 'itervane-approver@example.test';
const identifiedState = z.object({
  Id: z.string().regex(/^[a-f0-9]{64}$/),
  Name: z.string(),
  State: z.object({ Running: z.boolean(), StartedAt: z.string().datetime({ offset: true }) }),
  Config: z.object({ Labels: z.record(z.string(), z.string()) }),
});

async function docker(args: string[]) {
  return (await execute('docker', ['--host', 'unix:///var/run/docker.sock', ...args], {
    timeout: 150_000, maxBuffer: 512 * 1024, killSignal: 'SIGKILL',
  })).stdout.trim();
}

export function eligibleHost(env = process.env) {
  return process.platform === 'linux' && process.arch === 'x64' && env.GITHUB_ACTIONS === 'true'
    && env.RUNNER_ENVIRONMENT === 'github-hosted' && ['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME ?? '');
}

async function awaitWhiskers() {
  const deadline = performance.now() + 75_000;
  while (performance.now() < deadline) {
    let ready = false;
    try {
      const response = await fetch(whiskersOrigin + '/readyz', { redirect: 'error', signal: AbortSignal.timeout(2000) });
      ready = response.ok;
      await response.body?.cancel();
    } catch { /* Wait for this dedicated fixture only. */ }
    if (ready) return;
    await wait(800);
  }
  throw new Error('Native fixture never became ready');
}

export class WhiskersFixture {
  private readonly runId = randomUUID();
  private readonly base = 'itervane-ops-' + this.runId;
  private readonly owned = new Set<string>();
  private readonly image = this.base + ':probe';
  private temp?: string;
  readonly adminPassword = 'Iv!' + randomBytes(24).toString('hex') + 'A1';
  readonly primary = this.base + '-a';
  readonly other = this.base + '-b';

  async start() {
    const platform = await docker(['version', '--format', '{{.Server.Os}}/{{.Server.Arch}}']);
    if (platform !== 'linux/amd64') throw new Error('Unexpected fixture daemon');
    this.temp = await mkdtemp(join(tmpdir(), 'itervane-native-'));
    const passwordPath = join(this.temp, 'admin-password');
    await writeFile(passwordPath, this.adminPassword, { mode: 0o600, flag: 'wx' });
    await docker(['build', '--quiet', '--network', 'none', '--build-arg', 'FIXTURE_VERSION=a', '--tag', this.image, resolve('fixtures/komodo')]);
    for (const name of [this.primary, this.other]) {
      await this.create(name, ['--network', 'none', '--cap-drop', 'ALL', this.image]);
    }
    await this.create(this.base, [
      '--publish', '127.0.0.1:49220:8080',
      '--tmpfs', '/app/data:rw,nosuid,nodev,size=128m',
      '--mount', 'type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
      '--mount', 'type=bind,source=' + passwordPath + ',target=/run/secrets/probe-admin,readonly',
      '--mount', 'type=bind,source=' + resolve('fixtures/whiskers/guardrails.json') + ',target=/app/data/guardrails.json,readonly',
      '--env', 'ASPNETCORE_URLS=http://+:8080',
      '--env', 'Auth__Disabled=false',
      '--env', 'WHISKERS_ADMIN_EMAIL=' + adminEmail,
      '--env', 'WHISKERS_ADMIN_PASSWORD_FILE=/run/secrets/probe-admin',
      '--env', 'Features__agent__Enabled=true',
      '--env', 'VPN_PROVIDER=none',
      publishedWhiskers,
    ]);
    await awaitWhiskers();
  }

  async snapshot(name: string) {
    if (!this.owned.has(name)) throw new Error('Unrecorded fixture');
    const raw = await docker(['container', 'inspect', '--format', '{{json .}}', name]);
    const state = identifiedState.parse(JSON.parse(raw));
    if (state.Name !== '/' + name || state.Config.Labels[labelKey] !== this.runId || !state.State.Running) {
      throw new Error('Unexpected fixture state');
    }
    return { id: state.Id, started: state.State.StartedAt };
  }

  async healthy(name: string) {
    const before = await this.snapshot(name);
    const response = await docker(['exec', before.id, '/bin/busybox', 'wget', '-q', '-T', '2', '-O', '-', 'http://127.0.0.1:8080/healthz']);
    return response === 'a' && before.started === (await this.snapshot(name)).started;
  }

  async close() {
    let clean = true;
    try {
      const containers = await docker(['container', 'ls', '--all', '--filter', 'label=' + labelKey + '=' + this.runId, '--no-trunc', '--format', '{{.ID}}']);
      for (const item of containers.split(/\r?\n/).filter(Boolean)) {
        if (!/^[a-f0-9]{64}$/.test(item)) throw new Error('Unexpected Docker identity');
        await docker(['container', 'rm', '--force', item]);
      }
    } catch { clean = false; }
    if (this.temp) {
      try {
        await unlink(join(this.temp, 'admin-password'));
        await rmdir(this.temp);
      } catch { clean = false; }
    }
    return clean;
  }

  private async create(name: string, args: string[]) {
    const id = await docker(['run', '--detach', '--name', name, '--label', labelKey + '=' + this.runId, ...args]);
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Unexpected Docker identity');
    this.owned.add(name);
  }
}
