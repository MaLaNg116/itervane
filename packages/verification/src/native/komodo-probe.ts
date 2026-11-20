import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { promisify } from 'node:util';
import { localeSchema, type Check } from '@itervane/contracts';
import { z } from 'zod';
import { report } from '../report.js';
import { deployment, dockerDigest, KomodoError, KomodoNativeClient, komodoVersion, observeUpdate, readBounded, requestDeploy, resource } from './komodo.js';

const execute = promisify(execFile);
const coreOrigin = 'http://127.0.0.1:49120';
const registry = '127.0.0.1:49500';
const repository = registry + '/itervane-fixture';
const registeredServer = 'itervane-native';
const labelKey = 'io.itervane.komodo-probe';
const digestManifest = z.object({
  schemaVersion: z.literal(2),
  config: z.object({ digest: dockerDigest }),
});

const actualContainer = z.object({
  Id: z.string().regex(/^[a-f0-9]{64}$/),
  Image: dockerDigest,
  Config: z.object({ Image: z.string(), Labels: z.record(z.string(), z.string()) }),
  State: z.object({ Running: z.boolean() }),
  HostConfig: z.object({ NetworkMode: z.literal('none'), Privileged: z.literal(false) }),
});

type Version = 'a' | 'b';
type Manifest = { version: Version; digest: string; config: string; reference: string };
type Target = { id: string; server: string; name: string; label: string; actor: string };

async function docker(step: string, args: string[], env = process.env) {
  try {
    return (await execute('docker', ['--host', 'unix:///var/run/docker.sock', ...args], {
      env, timeout: 150_000, killSignal: 'SIGKILL', maxBuffer: 512 * 1024,
    })).stdout.trim();
  } catch {
    throw new KomodoError(step, 'response');
  }
}

async function waitFor<T>(step: string, find: () => Promise<T | undefined>, duration: number) {
  const deadline = performance.now() + duration;
  let lastError: KomodoError | undefined;
  while (performance.now() < deadline) {
    try {
      const result = await find();
      if (result !== undefined) return result;
    } catch (error) {
      if (!(error instanceof KomodoError)) throw error;
      lastError = error;
    }
    await wait(600);
  }
  throw lastError ?? new KomodoError(step, 'deadline');
}

function configImage(reference: string) {
  return { type: 'Image', params: { image: reference } };
}

async function publishFixture(version: Version) {
  const tagged = repository + ':' + version;
  await docker('BuildFixture', [
    'build', '--pull', '--quiet', '--network', 'none', '--build-arg', 'FIXTURE_VERSION=' + version, '--tag', tagged,
    resolve('fixtures/komodo'),
  ]);
  await docker('PushFixture', ['push', tagged]);
  const response = await fetch('http://' + registry + '/v2/itervane-fixture/manifests/' + version, {
    headers: { accept: 'application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json' },
    redirect: 'error', signal: AbortSignal.timeout(8_000),
  });
  const body = await readBounded(response, 32 * 1024);
  const manifest = digestManifest.safeParse(response.ok ? JSON.parse(body.toString('utf8')) : null);
  const digest = 'sha256:' + createHash('sha256').update(body).digest('hex');
  const local = await docker('InspectFixtureImage', ['image', 'inspect', '--format', '{{.Id}}', tagged]);
  if (!manifest.success || digest !== response.headers.get('docker-content-digest') || local !== manifest.data.config.digest) {
    throw new KomodoError('FixtureManifest', 'binding');
  }
  return { version, digest, config: local, reference: repository + '@' + digest } satisfies Manifest;
}

async function bootstrap(password: string, sample: Manifest, name: string, mark: string) {
  const session = await waitFor('CoreLogin', () => new KomodoNativeClient(coreOrigin).call(
    'auth', 'LoginLocalUser', { username: 'itervane-bootstrap', password }, z.object({ jwt: z.string().min(1).max(4096) }),
  ), 75_000);
  const admin = new KomodoNativeClient(coreOrigin, session);
  const { version } = await admin.call('read', 'GetVersion', {}, z.object({ version: z.string() }));
  if (version !== komodoVersion && version !== 'v' + komodoVersion) throw new KomodoError('CoreVersion', 'binding');
  const server = await admin.call('read', 'GetServer', { server: registeredServer }, resource);
  if (server.name !== registeredServer) throw new KomodoError('ServerIdentity', 'binding');
  const serverId = server._id.$oid;
  await waitFor('PeripheryReady', async () => {
    const state = await admin.call('read', 'GetServerState', { server: serverId }, z.object({ status: z.string() }));
    return state.status === 'Ok' ? true : undefined;
  }, 45_000);
  const created = await admin.call('write', 'CreateDeployment', {
    name,
    config: {
      server_id: serverId, image: configImage(sample.reference), network: 'none', restart: 'no',
      labels: labelKey + '=' + mark, auto_update: false, poll_for_updates: false, send_alerts: false,
    },
  }, deployment);
  const foreign = await admin.call('write', 'CreateDeployment', { name: name + '-other' }, resource);
  const user = await admin.call('write', 'CreateServiceUser', {
    username: 'itervane-release-probe', description: 'This disposable Komodo test target',
  }, z.object({ _id: resource.shape._id, admin: z.literal(false), enabled: z.literal(true) }));
  const actor = user._id.$oid;
  const id = created._id.$oid;
  await admin.call('write', 'UpdatePermissionOnTarget', {
    user_target: { type: 'User', id: actor },
    resource_target: { type: 'Deployment', id },
    permission: { level: 'Write', specific: [] },
  }, z.unknown());
  const credentials = await admin.call('write', 'CreateApiKeyForServiceUser', {
    user_id: actor, name: 'release-probe', expires: Date.now() + 20 * 60_000,
  }, z.object({ key: z.string().min(1).max(512), secret: z.string().min(1).max(512) }));
  const client = new KomodoNativeClient(coreOrigin, credentials);
  const target = { id, server: serverId, name, actor, label: labelKey + '=' + mark };
  await readTarget(client, target, sample.reference);
  try {
    await client.call('read', 'GetDeployment', { deployment: foreign._id.$oid }, z.unknown());
  } catch (error) {
    if (error instanceof KomodoError && error.reason === 'http' && [403, 404].includes(error.status ?? 0)) {
      return { client, target };
    }
    throw error;
  }
  throw new KomodoError('UnrelatedTargetForbidden', 'binding');
}

function confirmTarget(value: z.infer<typeof deployment>, target: Target, reference: string) {
  if (value._id.$oid !== target.id || value.name !== target.name || value.config.server_id !== target.server
    || value.config.labels.trim() !== target.label || value.config.image.params.image !== reference) {
    throw new KomodoError('DeploymentIdentity', 'binding');
  }
}

async function readTarget(client: KomodoNativeClient, target: Target, reference: string) {
  confirmTarget(await client.call('read', 'GetDeployment', { deployment: target.id }, deployment), target, reference);
}

async function inspect(name: string) {
  const result = await docker('InspectContainer', ['container', 'inspect', '--format', '{{json .}}', name]);
  return actualContainer.parse(JSON.parse(result));
}

async function observeFixture(name: string, mark: string, expected: Manifest, previousContainer?: string) {
  const first = await inspect(name);
  if (first.Id === previousContainer || !first.State.Running || first.Image !== expected.config
    || first.Config.Image !== expected.reference || first.Config.Labels[labelKey] !== mark) {
    throw new KomodoError('ObservedContainer', 'binding');
  }
  const body = await docker('RequestFixtureHealth', [
    'exec', name, '/bin/busybox', 'wget', '-q', '-T', '2', '-O', '-', 'http://127.0.0.1:8080/healthz',
  ]);
  if (body !== expected.version || (await inspect(name)).Id !== first.Id) throw new KomodoError('ObservedHealth', 'binding');
  return first;
}

async function deployFixture(
  client: KomodoNativeClient, target: Target, mark: string, manifest: Manifest, previous: Manifest, previousContainer?: string,
) {
  await readTarget(client, target, previous.reference);
  if (manifest.reference !== previous.reference) {
    confirmTarget(await client.call('write', 'UpdateDeployment', {
      id: target.id, config: { image: configImage(manifest.reference) },
    }, deployment), target, manifest.reference);
    await readTarget(client, target, manifest.reference);
  }
  let updateId: string | undefined;
  try {
    updateId = await requestDeploy(client, target.id);
    if (!await observeUpdate(client, updateId, target.id, target.actor)) throw new KomodoError('DeployComplete', 'response');
    await readTarget(client, target, manifest.reference);
    const observed = await observeFixture(target.name, mark, manifest, previousContainer);
    return { updateId, observed };
  } catch (error) {
    // A timed-out dispatch might already have run. Read the actual target once.
    // Keep the probe failed and never send another write from this branch.
    const state = await inspect(target.name).catch(() => undefined);
    if (state?.Config.Labels[labelKey] === mark) {
      const matched = state.State.Running && state.Config.Image === manifest.reference && state.Image === manifest.config;
      console.log('Komodo recovery observation: ' + (matched ? 'requested_image_running' : 'different_state'));
    } else {
      console.log('Komodo recovery observation: unavailable');
    }
    throw error;
  }
}

const text = {
  environment: ['Run the trusted fixture on a dedicated GitHub-hosted Linux x64 runner.', '请使用独立的 GitHub 托管 Linux x64 工作机运行可信样例。'],
  authorized: ['Periphery connected; service access was confined by native resource permissions.', 'Periphery 已连接，原生权限按资源约束了服务身份访问。'],
  match: ['Native update, OCI manifest, running image and HTTP health matched.', '原生操作、OCI manifest、实际运行镜像和 HTTP 健康响应一致。'],
  cleaned: ['Removed the owned fixture and temporary Compose resources.', '本轮样例和临时 Compose 资源已清理。'],
  failure: ['Verification interrupted at', '验证中止于'],
} as const;

export async function probeKomodoNative(env: NodeJS.ProcessEnv = process.env) {
  const locale = localeSchema.catch('en').parse(env.ITERVANE_NATIVE_LOCALE);
  const lang = locale === 'zh-CN' ? 1 : 0;
  const checks: Check[] = [];
  if (process.platform !== 'linux' || process.arch !== 'x64' || env.GITHUB_ACTIONS !== 'true'
    || env.RUNNER_ENVIRONMENT !== 'github-hosted' || !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME ?? '')) {
    return report('komodo-native', [{ id: 'dedicated-host', status: 'blocked', detail: text.environment[lang] }]);
  }
  const mark = randomUUID();
  const name = 'itervane-probe-' + mark;
  const adminPassword = randomBytes(32).toString('hex');
  const composeEnv = {
    ...env,
    ITERVANE_PROBE_DB_PASSWORD: randomBytes(32).toString('hex'),
    ITERVANE_PROBE_ADMIN_PASSWORD: adminPassword,
    ITERVANE_PROBE_JWT_SECRET: randomBytes(32).toString('hex'),
    ITERVANE_PROBE_WEBHOOK_SECRET: randomBytes(32).toString('hex'),
  };
  const compose = ['compose', '--env-file', '/dev/null', '--project-name', name, '--file', resolve('fixtures/komodo/compose.yaml')];
  try {
    const dockerPlatform = await docker('DockerIdentity', ['version', '--format', '{{.Server.Os}}/{{.Server.Arch}}']);
    if (dockerPlatform !== 'linux/amd64') throw new KomodoError('DockerIdentity', 'binding');
    await docker('ComposeUp', [...compose, 'up', '--detach', '--quiet-pull'], composeEnv);
    await waitFor('RegistryReady', async () => {
      let result: Response;
      try { result = await fetch('http://' + registry + '/v2/', { redirect: 'error', signal: AbortSignal.timeout(2_000) }); }
      catch { return undefined; }
      await result.body?.cancel();
      return result.ok ? true : undefined;
    }, 20_000);
    const a = await publishFixture('a');
    const b = await publishFixture('b');
    if (a.digest === b.digest || a.config === b.config) throw new KomodoError('FixtureVersions', 'binding');
    const { client, target } = await bootstrap(adminPassword, a, name, mark);
    checks.push({ id: 'native-komodo-identity', status: 'passed', detail: 'Komodo ' + komodoVersion + '. ' + text.authorized[lang] });
    const seen = new Set<string>();
    let previous = a;
    let previousContainer: string | undefined;
    for (const [id, manifest] of [['initial-release', a], ['upgrade', b], ['restore', a]] as const) {
      const result = await deployFixture(client, target, mark, manifest, previous, previousContainer);
      if (seen.has(result.updateId)) throw new KomodoError('UpdateIdentity', 'binding');
      seen.add(result.updateId);
      previous = manifest;
      previousContainer = result.observed.Id;
      checks.push({ id, status: 'passed', detail: text.match[lang]
        + ' Update=' + result.updateId + ' OCI=' + manifest.digest + ' Image=' + result.observed.Image + '.' });
    }
  } catch (error) {
    const reason = error instanceof KomodoError
      ? error.step + ' (' + error.reason + (error.status ? ', HTTP ' + error.status : '') + ')'
      : 'FixtureEvidence';
    checks.push({ id: 'native-verification', status: 'failed', detail: text.failure[lang] + ' ' + reason + '.' });
  } finally {
    let cleanupFailed = false;
    try {
      const owned = await docker('FindFixture', ['container', 'ls', '--all', '--filter', 'label=' + labelKey + '=' + mark, '--format', '{{.ID}}']);
      if (owned) {
        const id = z.string().regex(/^[a-f0-9]{12,64}$/).parse(owned);
        await docker('RemoveFixture', ['container', 'rm', '--force', id]);
      }
    } catch { cleanupFailed = true; }
    try { await docker('ComposeDown', [...compose, 'down', '--volumes'], composeEnv); }
    catch { cleanupFailed = true; }
    checks.push({
      id: 'cleanup', status: cleanupFailed ? 'failed' : 'passed',
      detail: cleanupFailed ? text.failure[lang] + ' ComposeDown.' : text.cleaned[lang],
    });
  }
  return report('komodo-native', checks);
}
