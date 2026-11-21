import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { promisify } from 'node:util';
import { localeSchema, type Check } from '@itervane/contracts';
import { z } from 'zod';
import {
  KomodoReleaseClient, KomodoReleaseError, komodoRuntimeConfigSha256, type KomodoReleaseTarget,
} from '../../../control-plane/src/runtime/release-komodo.js';
import { report } from '../report.js';
import { deployment, dockerDigest, fixtureAppNetwork, KomodoError, KomodoNativeClient, komodoVersion,
  loginLocalAdmin, observeUpdate, readBounded, requestDeploy, resource } from './komodo.js';

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
  Name: z.string(),
  Image: dockerDigest,
  Config: z.object({ Image: z.string(), Labels: z.record(z.string(), z.string()) }),
  State: z.object({ Running: z.boolean() }),
  HostConfig: z.object({ NetworkMode: fixtureAppNetwork, Privileged: z.literal(false), PublishAllPorts: z.literal(false),
    PortBindings: z.union([z.null(), z.strictObject({})]) }),
  NetworkSettings: z.object({ Networks: z.record(fixtureAppNetwork, z.unknown()) }),
});

type Version = 'a' | 'b';
type Manifest = { version: Version; digest: string; config: string; reference: string };
type Target = { id: string; server: string; name: string; label: string; actor: string; network: string };
type AppNetwork = { id: string; name: string; mark: string };

async function docker(step: string, args: string[], env = process.env) {
  try {
    return (await execute('docker', ['--host', 'unix:///var/run/docker.sock', ...args], {
      env, timeout: 150_000, killSignal: 'SIGKILL', maxBuffer: 512 * 1024,
    })).stdout.trim();
  } catch {
    throw new KomodoError(step, 'response');
  }
}

async function createAppNetwork(mark: string): Promise<AppNetwork> {
  const name = fixtureAppNetwork.parse('itervane-app-' + mark);
  const id = z.string().regex(/^[a-f0-9]{64}$/).parse(await docker('CreateAppNetwork', [
    'network', 'create', '--driver', 'bridge', '--internal', '--label', labelKey + '=' + mark, name,
  ]));
  return { id, name, mark };
}

async function confirmAppNetwork(network: AppNetwork) {
  const value = await docker('InspectAppNetwork', ['network', 'inspect', '--format',
    '{{.Name}} {{.Driver}} {{.Internal}} {{index .Labels "io.itervane.komodo-probe"}}', network.id]);
  if (value !== `${network.name} bridge true ${network.mark}`) throw new KomodoError('AppNetworkIdentity', 'binding');
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

async function bootstrap(password: string, reference: string, name: string, network: AppNetwork) {
  await confirmAppNetwork(network);
  const session = await waitFor('CoreLogin', () => loginLocalAdmin(
    new KomodoNativeClient(coreOrigin), 'itervane-bootstrap', password,
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
      server_id: serverId, image: configImage(reference), network: network.name, restart: 'no',
      labels: labelKey + '=' + network.mark, auto_update: false, poll_for_updates: false, send_alerts: false,
    },
  }, deployment);
  const foreign = await admin.call('write', 'CreateDeployment', { name: name + '-other' }, resource);
  const user = await admin.call('write', 'CreateServiceUser', {
    username: name + '-worker', description: 'This disposable Komodo test target',
  }, z.object({ _id: resource.shape._id, admin: z.literal(false), enabled: z.literal(true) }));
  const actor = user._id.$oid;
  const id = created._id.$oid;
  const setDeploymentPermissions = (specific: 'Inspect'[]) => admin.call('write', 'UpdatePermissionOnTarget', {
    user_target: { type: 'User', id: actor },
    resource_target: { type: 'Deployment', id },
    permission: { level: 'Write', specific },
  }, z.unknown());
  await setDeploymentPermissions([]);
  const credentials = await admin.call('write', 'CreateApiKeyForServiceUser', {
    user_id: actor, name: 'release-probe', expires: Date.now() + 20 * 60_000,
  }, z.object({ key: z.string().min(1).max(512), secret: z.string().min(1).max(512) }));
  const client = new KomodoNativeClient(coreOrigin, credentials);
  const target = { id, server: serverId, name, actor, label: labelKey + '=' + network.mark, network: network.name };
  await readTarget(client, target, reference);
  try {
    await client.call('read', 'GetDeployment', { deployment: foreign._id.$oid }, z.unknown());
  } catch (error) {
    if (error instanceof KomodoError && error.reason === 'permission') {
      return { client, target, credentials, foreignId: foreign._id.$oid,
        allowBoundContainerInspection: () => setDeploymentPermissions(['Inspect']) };
    }
    if (error instanceof KomodoError) throw new KomodoError('UnrelatedTargetForbidden', error.reason, error.status);
    throw error;
  }
  throw new KomodoError('UnrelatedTargetForbidden', 'binding');
}

function confirmTarget(value: z.infer<typeof deployment>, target: Target, reference: string) {
  if (value._id.$oid !== target.id || value.name !== target.name || value.config.server_id !== target.server
      || value.config.network !== target.network || value.config.labels.trim() !== target.label || value.config.image.params.image !== reference) {
    throw new KomodoError('DeploymentIdentity', 'binding');
  }
}

async function readTarget(client: KomodoNativeClient, target: Target, reference: string) {
  confirmTarget(await client.call('read', 'GetDeployment', { deployment: target.id }, deployment), target, reference);
}

async function inspect(target: Target) {
  const result = await docker('InspectContainer', ['container', 'inspect', '--format', '{{json .}}', target.name]);
  const container = actualContainer.parse(JSON.parse(result));
  const networks = Object.keys(container.NetworkSettings.Networks);
  if (container.HostConfig.NetworkMode !== target.network || networks.length !== 1 || networks[0] !== target.network) {
    throw new KomodoError('ObservedAppNetwork', 'binding');
  }
  return container;
}

async function observeFixture(target: Target, mark: string, expected: Manifest, previousContainer?: string) {
  const first = await inspect(target);
  if (first.Id === previousContainer || !first.State.Running || first.Image !== expected.config
    || first.Config.Image !== expected.reference || first.Config.Labels[labelKey] !== mark) {
    throw new KomodoError('ObservedContainer', 'binding');
  }
  const body = await docker('RequestFixtureHealth', [
    'exec', target.name, '/bin/busybox', 'wget', '-q', '-T', '2', '-O', '-', 'http://127.0.0.1:8080/healthz',
  ]);
  if (body !== expected.version || (await inspect(target)).Id !== first.Id) throw new KomodoError('ObservedHealth', 'binding');
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
    const observed = await waitFor('ObserveFixture', () => observeFixture(target, mark, manifest, previousContainer), 12_000);
    return { updateId, observed };
  } catch (error) {
    // A timed-out dispatch might already have run. Read the actual target once.
    // Keep the probe failed and never send another write from this branch.
    const state = await inspect(target).catch(() => undefined);
    if (state?.Config.Labels[labelKey] === mark) {
      const matched = state.State.Running && state.Config.Image === manifest.reference && state.Image === manifest.config;
      console.log('Komodo recovery observation: ' + (matched ? 'requested_image_running' : 'different_state'));
    } else {
      console.log('Komodo recovery observation: unavailable');
    }
    throw error;
  }
}

async function expectReleaseRejection(step: KomodoReleaseError['step'], reason: KomodoReleaseError['reason'],
  exercise: () => Promise<unknown>) {
  try { await exercise(); }
  catch (error) {
    if (!(error instanceof KomodoReleaseError) || error.step !== step || error.reason !== reason) throw error;
    if (reason === 'http' && error.statusCode !== 403 && error.statusCode !== 500) throw error;
    return;
  }
  throw new KomodoError(step, 'binding');
}

async function verifyFormalAdapter(setup: Awaited<ReturnType<typeof bootstrap>>, mark: string, previous: Manifest,
  approved: Manifest, previousContainer?: string) {
  const { client, target, credentials, foreignId } = setup;
  const native = await client.call('read', 'GetDeployment', { deployment: target.id }, z.unknown());
  const binding = {
    deploymentId: target.id, serverId: target.server, imageRepository: 'itervane-fixture',
    registryOrigin: 'http://' + registry, runtimeConfigSha256: komodoRuntimeConfigSha256(native),
    komodo: { origin: coreOrigin, actorId: target.actor },
  } satisfies KomodoReleaseTarget;
  const adapter = new KomodoReleaseClient(coreOrigin, { ...credentials, actorId: target.actor });
  const mismatch = new KomodoReleaseClient(coreOrigin, { ...credentials, actorId: foreignId });
  await adapter.verifyCredentialOwner();
  await expectReleaseRejection('ListApiKeys', 'binding', () => mismatch.verifyCredentialOwner());
  const authorize = async () => {};
  const attempt = { previousImage: previous.reference, manifestDigest: approved.digest };
  const initial = await adapter.inspectTarget(binding, authorize);
  if (initial.imageReference !== previous.reference) throw new KomodoError('FormalAdapterPreviousImage', 'binding');
  await expectReleaseRejection('target', 'binding', () =>
    adapter.inspectTarget({ ...binding, komodo: { ...binding.komodo, origin: 'http://127.0.0.1:49121' } }, authorize));
  await expectReleaseRejection('target', 'binding', () =>
    adapter.inspectTarget({ ...binding, komodo: { ...binding.komodo, actorId: foreignId } }, authorize));
  await expectReleaseRejection('GetDeployment', 'binding', () =>
    adapter.inspectTarget({ ...binding, serverId: foreignId }, authorize));
  await expectReleaseRejection('GetDeployment', 'binding', () =>
    adapter.configureImage({ ...binding, runtimeConfigSha256: '0'.repeat(64) }, attempt, authorize));
  await expectReleaseRejection('GetDeployment', 'http', () =>
    adapter.inspectTarget({ ...binding, deploymentId: foreignId }, authorize));
  await expectReleaseRejection('UpdateDeployment', 'binding', () =>
    adapter.configureImage(binding, { ...attempt, previousImage: approved.reference }, authorize));
  await expectReleaseRejection('Deploy', 'binding', () => adapter.dispatch(binding, approved.digest, authorize));
  const configured = await adapter.configureImage(binding, attempt, authorize);
  if (configured.imageReference !== approved.reference) throw new KomodoError('FormalAdapterConfiguredImage', 'binding');
  const { updateId } = await adapter.dispatch(binding, approved.digest, authorize);
  const result = await waitFor('FormalAdapterUpdate', async () => {
    const update = await adapter.observeUpdate(binding, updateId, authorize);
    return update.status === 'Complete' ? update : undefined;
  }, 65_000);
  if (!result.success) throw new KomodoError('FormalAdapterUpdate', 'response');
  await expectReleaseRejection('GetUpdate', 'binding', () =>
    mismatch.observeUpdate({ ...binding, komodo: { ...binding.komodo, actorId: foreignId } }, updateId, authorize));
  const observed = await waitFor('FormalAdapterFixture', () => observeFixture(target, mark, approved, previousContainer), 12_000);
  const runningImage = { manifestDigest: approved.digest, configDigest: approved.config };
  await expectReleaseRejection('InspectDeploymentContainer', 'http', () =>
    adapter.inspectRuntime(binding, runningImage, target.network, authorize));
  await setup.allowBoundContainerInspection();
  const runtime = await adapter.inspectRuntime(binding, runningImage, target.network, authorize);
  await expectReleaseRejection('InspectDeploymentContainer', 'binding', () =>
    adapter.inspectRuntime(binding, runningImage, 'itervane-app-' + randomUUID(), authorize));
  if (runtime.containerId !== observed.Id || '/' + runtime.containerName !== observed.Name || runtime.configDigest !== observed.Image) {
    throw new KomodoError('FormalAdapterRunningImage', 'binding');
  }
  return { updateId, runtimeConfigSha256: binding.runtimeConfigSha256, observed };
}

const text = {
  environment: ['Run the trusted fixture on a dedicated GitHub-hosted Linux x64 runner.', '请使用独立的 GitHub 托管 Linux x64 工作机运行可信样例。'],
  authorized: ['Periphery connected; service access was confined by native resource permissions.', 'Periphery 已连接，原生权限按资源约束了服务身份访问。'],
  match: ['Native update, OCI manifest, running image and HTTP health matched.', '原生操作、OCI manifest、实际运行镜像和 HTTP 健康响应一致。'],
  formal: ['The release adapter enforced target and update bindings and verified the fixture.',
    '正式发布适配器校验了目标与更新绑定，并核对了实际样例。'],
  cleaned: ['Removed the owned fixture and temporary Compose resources.', '本轮样例和临时 Compose 资源已清理。'],
  privateNetwork: ['The running target only joined its internal bridge and published no host ports.',
    '实际运行目标只加入自己的内部桥接网络，未发布宿主端口。'],
  failure: ['Verification interrupted at', '验证中止于'],
} as const;

function nativeStack(name: string, env: NodeJS.ProcessEnv) {
  const adminPassword = randomBytes(32).toString('hex');
  const configured = {
    ...env,
    ITERVANE_PROBE_DB_PASSWORD: randomBytes(32).toString('hex'),
    ITERVANE_PROBE_ADMIN_PASSWORD: adminPassword,
    ITERVANE_PROBE_JWT_SECRET: randomBytes(32).toString('hex'),
    ITERVANE_PROBE_WEBHOOK_SECRET: randomBytes(32).toString('hex'),
  };
  const compose = ['compose', '--env-file', '/dev/null', '--project-name', name, '--file', resolve('fixtures/komodo/compose.yaml')];
  return {
    adminPassword,
    start: async (withRegistry: boolean) => {
      const dockerPlatform = await docker('DockerIdentity', ['version', '--format', '{{.Server.Os}}/{{.Server.Arch}}']);
      if (dockerPlatform !== 'linux/amd64') throw new KomodoError('DockerIdentity', 'binding');
      await docker('ComposeUp', [...compose, 'up', '--detach', '--quiet-pull', ...(withRegistry ? [] : ['mongo', 'core', 'periphery'])], configured);
    },
    stop: () => docker('ComposeDown', [...compose, 'down', '--volumes'], configured),
  };
}

async function removeOwnedFixture(mark: string) {
  const owned = await docker('FindFixture', ['container', 'ls', '--all', '--filter', 'label=' + labelKey + '=' + mark, '--format', '{{.ID}}']);
  if (owned) {
    const id = z.string().regex(/^[a-f0-9]{12,64}$/).parse(owned);
    await docker('RemoveFixture', ['container', 'rm', '--force', id]);
  }
}

async function removeAppTarget(network: AppNetwork) {
  try {
    await removeOwnedFixture(network.mark);
  } finally {
    await confirmAppNetwork(network);
    await docker('RemoveAppNetwork', ['network', 'rm', network.id]);
  }
}

/** Test-only Core/Periphery. The approved artifact is served by the calling trial's private registry. */
export async function openNativeReleaseKomodo(env: NodeJS.ProcessEnv = process.env) {
  if (process.platform !== 'linux' || process.arch !== 'x64' || env.GITHUB_ACTIONS !== 'true'
    || env.PROBE_HOST_ENVIRONMENT !== 'github-hosted') throw new KomodoError('ReleaseFixtureHost', 'binding');
  const owned = new Set<AppNetwork>();
  const stack = nativeStack('itervane-release-' + randomUUID(), env);
  try { await stack.start(false); }
  catch (error) { await stack.stop().catch(() => undefined); throw error; }
  return {
    async prepare() {
      const mark = randomUUID();
      const network = await createAppNetwork(mark);
      owned.add(network);
      const setup = await bootstrap(stack.adminPassword, '', 'itervane-release-' + mark, network);
      const { target, credentials, client } = setup;
      const raw = await client.call('read', 'GetDeployment', { deployment: target.id }, z.unknown());
      const observeContainer = async (reference: string, configDigest: string) => {
        const container = await waitFor('ObserveApprovedContainer', async () => {
          const status = await inspect(target);
          return status.State.Running ? status : undefined;
        }, 20_000);
        if (container.Config.Labels[labelKey] !== mark || container.Config.Image !== reference || container.Image !== configDigest) {
          throw new KomodoError('ApprovedRuntimeIdentity', 'binding');
        }
        return { reference: container.Config.Image, configDigest: container.Image, containerId: container.Id };
      };
      return {
        binding: { deploymentId: target.id, serverId: target.server, runtimeConfigSha256: komodoRuntimeConfigSha256(raw),
          komodo: { origin: coreOrigin, actorId: target.actor } },
        endpoint: { network: target.network, container: target.name },
        credentials: { ...credentials, actorId: target.actor },
        allowContainerInspection: setup.allowBoundContainerInspection,
        async assertUnchanged() {
          await readTarget(client, target, '');
          const ownedContainer = await docker('FindTargetFixture', [
            'container', 'ls', '--all', '--filter', 'label=' + labelKey + '=' + mark, '--format', '{{.ID}}',
          ]);
          if (ownedContainer) throw new KomodoError('UnexpectedFixtureDeployment', 'binding');
        },
        observeContainer,
        async exerciseFixtureHealth(reference: string, configDigest: string, port: number, failHealth: boolean) {
          if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new KomodoError('FixtureHealthPort', 'binding');
          const before = await observeContainer(reference, configDigest);
          const readStatus = () => docker('ReadFixtureHealth', ['container', 'exec', before.containerId, '/opt/itervane/bin/node', '-e',
            'fetch(process.argv[1], { signal: AbortSignal.timeout(2500) }).then(response => console.log(response.status)).catch(() => { process.exitCode = 1; });',
            `http://127.0.0.1:${port}/health`]);
          await waitFor('FixtureHealthInitial', async () => await readStatus() === '200' ? true : undefined, 12_000);
          if (failHealth) await docker('SignalFixtureHealth', ['container', 'kill', '--signal=USR2', before.containerId]);
          const afterStatus = failHealth ? 503 : 200;
          await waitFor('FixtureHealthExpected', async () => await readStatus() === String(afterStatus) ? true : undefined, 12_000);
          const after = await observeContainer(reference, configDigest);
          if (after.containerId !== before.containerId) throw new KomodoError('FixtureHealthContainerChanged', 'binding');
          return { beforeStatus: 200, afterStatus, containerId: before.containerId };
        },
      };
    },
    async close() {
      const cleanup = await Promise.allSettled([...owned].map(removeAppTarget));
      await stack.stop();
      if (cleanup.some(result => result.status === 'rejected')) throw new KomodoError('ReleaseFixtureCleanup', 'response');
    },
  };
}

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
  const stack = nativeStack(name, env);
  let network: AppNetwork | undefined;
  try {
    await stack.start(true);
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
    network = await createAppNetwork(mark);
    const setup = await bootstrap(stack.adminPassword, a.reference, name, network);
    const { client, target } = setup;
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
    const release = await verifyFormalAdapter(setup, mark, a, b, previousContainer);
    if (seen.has(release.updateId)) throw new KomodoError('FormalAdapterDistinctUpdate', 'binding');
    checks.push({ id: 'formal-komodo-adapter', status: 'passed', detail: text.formal[lang] + ' Update=' + release.updateId
      + ' OCI=' + b.digest + ' Image=' + release.observed.Image + ' Runtime=' + release.runtimeConfigSha256 + '.' });
    await confirmAppNetwork(network);
    checks.push({ id: 'protected-container-network', status: 'passed', detail: text.privateNetwork[lang] });
  } catch (error) {
    const reason = error instanceof KomodoError
      ? error.step + ' (' + error.reason + (error.status ? ', HTTP ' + error.status : '') + ')'
      : error instanceof KomodoReleaseError
        ? error.step + ' (' + error.reason + (error.statusCode ? ', HTTP ' + error.statusCode : '') + ')'
        : 'FixtureEvidence';
    checks.push({ id: 'native-verification', status: 'failed', detail: text.failure[lang] + ' ' + reason + '.' });
  } finally {
    let cleanupFailed = false;
    try {
      if (network) await removeAppTarget(network);
    } catch { cleanupFailed = true; }
    try { await stack.stop(); }
    catch { cleanupFailed = true; }
    checks.push({
      id: 'cleanup', status: cleanupFailed ? 'failed' : 'passed',
      detail: cleanupFailed ? text.failure[lang] + ' FixtureCleanup.' : text.cleaned[lang],
    });
  }
  return report('komodo-native', checks);
}
