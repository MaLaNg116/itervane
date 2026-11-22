import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { promisify } from 'node:util';
import { z } from 'zod';
import { whiskersRestartImageDigest } from '@itervane/contracts';
import { restartTool, whiskersOrigin } from '../../../verification/src/native/whiskers.js';

const execute = promisify(execFile);
const labelKey = 'io.itervane.whiskers-probe';
const publishedWhiskers = 'ghcr.io/lupusmalusdeviant/whiskers:0.15.0@' + whiskersRestartImageDigest;
export const adminEmail = 'itervane-approver@example.test';
export const operatorEmail = 'itervane-restart-operator@example.test';
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

function writerKeys() {
  return { primary: randomBytes(32).toString('hex'), alternate: randomBytes(32).toString('hex'), broad: randomBytes(32).toString('hex') };
}

export class WhiskersFixture {
  private readonly runId = randomUUID();
  private readonly base = 'itervane-ops-' + this.runId;
  private readonly owned = new Set<string>();
  private readonly image = this.base + ':probe';
  private readonly provisionedFiles = new Set<string>();
  private temp?: string;
  private writerPasswordPath?: string;
  readonly adminPassword = 'Iv!' + randomBytes(24).toString('hex') + 'A1';
  readonly operatorPassword = 'Iv!' + randomBytes(24).toString('hex') + 'A1';
  readonly primary = this.base + '-a';
  readonly other = this.base + '-b';
  readonly primaryWriter = 'itervane-probe-primary';
  readonly writers = writerKeys();
  readonly readKey = randomBytes(32).toString('hex');

  async start(mode: 'isolated-probe' | 'published-read-only' = 'isolated-probe') {
    const platform = await docker(['version', '--format', '{{.Server.Os}}/{{.Server.Arch}}']);
    if (platform !== 'linux/amd64') throw new Error('Unexpected fixture daemon');
    this.temp = await mkdtemp(join(tmpdir(), 'itervane-native-'));
    const writerProbe = mode === 'isolated-probe';
    const passwordPath = await this.provision('bootstrap-password', writerProbe ? this.operatorPassword : this.adminPassword);
    if (writerProbe) {
      this.writerPasswordPath = passwordPath;
      await docker(['build', '--quiet', '--network', 'none', '--build-arg', 'FIXTURE_VERSION=a', '--tag', this.image, resolve('fixtures/komodo')]);
      const isolated = ['--network', 'none', '--cap-drop', 'ALL', this.image];
      await this.create(this.primary, isolated);
      await this.create(this.other, [...isolated, '/bin/busybox', 'sh', '-c',
        "printf '%s\\n' 'WARNING diagnostic fixture' 'ERROR diagnostic fixture'; exec /bin/busybox httpd -f -p 8080 -h /www"]);
    }
    await this.bootWhiskers(passwordPath, writerProbe ? this.writers : undefined);
  }

  async rotateWriter() {
    if (!this.writerPasswordPath) throw new Error('Expected a scoped writer fixture');
    const previous = await this.inspectOwned(this.base);
    await docker(['container', 'rm', '--force', previous.Id]);
    this.owned.delete(this.base);
    const keys = writerKeys();
    await this.bootWhiskers(this.writerPasswordPath, keys);
    return keys.primary;
  }

  private async bootWhiskers(passwordPath: string, keys?: ReturnType<typeof writerKeys>) {
    const sealed = keys ? await this.sealWriterPolicy(keys) : [];
    const guardrails = resolve('fixtures/whiskers', keys ? 'guardrails.json' : 'read-only-guardrails.json');
    await this.create(this.base, [
      '--publish', '127.0.0.1:49220:8080',
      '--tmpfs', '/app/data:rw,nosuid,nodev,size=128m',
      '--mount', 'type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
      '--mount', 'type=bind,source=' + passwordPath + ',target=/run/secrets/probe-admin,readonly',
      '--mount', 'type=bind,source=' + guardrails + ',target=/app/data/guardrails.json,readonly',
      '--env', 'ASPNETCORE_URLS=http://+:8080',
      '--env', 'Auth__Disabled=false',
      '--env', 'WHISKERS_ADMIN_EMAIL=' + (keys ? operatorEmail : adminEmail),
      '--env', 'WHISKERS_ADMIN_PASSWORD_FILE=/run/secrets/probe-admin',
      '--env', 'Features__agent__Enabled=true',
      '--env', 'VPN_PROVIDER=none',
      ...sealed, publishedWhiskers,
      ...(keys ? ['-ec', 'cp /run/itervane/mcp-permissions.json /app/data/mcp-permissions.json\nexec /app/entrypoint.sh'] : []),
    ]);
    await awaitWhiskers();
  }

  private async provision(name: string, document: string) {
    if (!this.temp) throw new Error('Missing fixture directory');
    const path = join(this.temp, name);
    await writeFile(path, document, { mode: 0o600, flag: 'wx' });
    this.provisionedFiles.add(path);
    return path;
  }

  private async sealWriterPolicy(writers: ReturnType<typeof writerKeys>) {
    // The required setup Admin is an offline role entry without a login.
    // The only local account seeded into this fresh data volume is the Operator.
    const generation = randomUUID();
    const roles = await this.provision(generation + '-roles.json', JSON.stringify({
      Roles: [{ Email: 'offline-admin@example.invalid', Role: 2 }, { Email: operatorEmail, Role: 1 }], DefaultRole: 0,
    }));
    const keys = [
      { name: this.primaryWriter, key: writers.primary, level: 'write', tools: [restartTool] },
      { name: 'itervane-probe-alternate', key: writers.alternate, level: 'write', tools: [restartTool] },
      { name: 'itervane-probe-broad-negative', key: writers.broad, level: 'write', tools: null },
      { name: 'itervane-probe-observe', key: this.readKey, level: 'read',
        tools: ['get_container_details', 'get_container_logs', 'get_container_metrics'] },
    ];
    const permissions = await this.provision(generation + '-mcp-permissions.json', JSON.stringify({
      ApiKeys: keys.map(({ name, key, level, tools }) => ({
        Id: randomBytes(4).toString('hex'), Name: name, KeyHash: createHash('sha256').update(key).digest('hex'),
        Enabled: true, PermissionLevel: level, AllowedTools: tools,
      })),
    }));
    return [
      '--mount', 'type=bind,source=' + roles + ',target=/app/data/roles.json,readonly',
      '--mount', 'type=bind,source=' + permissions + ',target=/run/itervane/mcp-permissions.json,readonly',
      '--entrypoint', '/bin/sh',
    ];
  }

  async snapshot(name: string) {
    const state = await this.inspectOwned(name);
    if (!state.State.Running) throw new Error('Fixture was not running');
    return { id: state.Id, started: state.State.StartedAt };
  }

  private async inspectOwned(name: string) {
    if (!this.owned.has(name)) throw new Error('Unrecorded fixture');
    const raw = await docker(['container', 'inspect', '--format', '{{json .}}', name]);
    const state = identifiedState.parse(JSON.parse(raw));
    if (state.Name !== '/' + name || state.Config.Labels[labelKey] !== this.runId) {
      throw new Error('Unexpected fixture state');
    }
    return state;
  }

  async stopOther() {
    const before = await this.snapshot(this.other);
    await docker(['container', 'stop', '--time', '2', before.id]);
    const stopped = await this.inspectOwned(this.other);
    if (stopped.Id !== before.id || stopped.State.Running) throw new Error('Fixture did not stop');
  }

  async withPausedWhiskers(observe: () => Promise<void>) {
    const { id } = await this.snapshot(this.base);
    await docker(['container', 'pause', id]);
    try { await observe(); }
    finally { await docker(['container', 'unpause', id]); }
    await awaitWhiskers();
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
        for (const path of this.provisionedFiles) await unlink(path);
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
