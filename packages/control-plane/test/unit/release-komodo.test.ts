import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { KomodoReleaseClient, komodoRuntimeConfigSha256, type KomodoReleaseTarget } from '../../src/runtime/release-komodo.js';

const deploymentId = 'a'.repeat(24);
const serverId = 'b'.repeat(24);
const actorId = 'c'.repeat(24);
const updateId = 'd'.repeat(24);
const otherId = 'e'.repeat(24);
const origin = 'https://komodo.example.invalid';
const registryOrigin = 'https://registry.example.invalid';
const imageRepository = 'demo/sample';
const manifestDigest = 'sha256:' + 'a'.repeat(64);
const approved = `registry.example.invalid/${imageRepository}@${manifestDigest}`;
const previousImage = `registry.example.invalid/${imageRepository}@sha256:` + 'b'.repeat(64);
const credentials = { actorId, key: 'fixture-key', secret: 'fixture-secret' };

const nativeDeployment = {
  _id: { $oid: deploymentId }, name: 'demo-sample',
  config: {
    server_id: serverId, network: 'protected-demo', environment: 'MODE=demo',
    image: { type: 'Image', params: { image: previousImage } },
    future_setting: { enabled: true, values: ['first', 'second'] },
  },
};
const target = {
  komodo: { origin, actorId }, deploymentId, serverId, registryOrigin, imageRepository,
  runtimeConfigSha256: komodoRuntimeConfigSha256(nativeDeployment),
} satisfies KomodoReleaseTarget;
const configured = { ...nativeDeployment,
  config: { ...nativeDeployment.config, image: { type: 'Image', params: { image: approved } } } };
const nativeUpdate = {
  _id: { $oid: updateId }, operation: 'Deploy', operator: actorId,
  target: { type: 'Deployment', id: deploymentId }, status: 'Queued', success: true,
};
const authorization = vi.fn(async () => {});
const fetchKomodo = vi.fn<typeof fetch>();
const release = new KomodoReleaseClient(origin, credentials);

beforeEach(() => {
  authorization.mockClear();
  fetchKomodo.mockReset();
  vi.stubGlobal('fetch', fetchKomodo);
});
afterEach(() => vi.unstubAllGlobals());

it('binds the generated container name and all runtime settings except the image', () => {
  const { future_setting: _originalSetting, ...config } = configured.config;
  const orderedDifferently = { ...configured,
    config: { future_setting: { values: ['first', 'second'], enabled: true }, ...config } };
  expect(komodoRuntimeConfigSha256(orderedDifferently)).toBe(target.runtimeConfigSha256);
  expect(komodoRuntimeConfigSha256({ ...configured, name: 'changed-container' })).not.toBe(target.runtimeConfigSha256);
  expect(komodoRuntimeConfigSha256({ ...configured, config: { ...configured.config,
    future_setting: { enabled: true, values: ['second', 'first'] } } })).not.toBe(target.runtimeConfigSha256);
});

it.each([
  { network: 'host' }, { network: 'container:another' }, { swarm_id: otherId },
  { replicas: 2 }, { volumes: '/host/path:/app' }, { extra_args: ['--privileged'] },
  { command: 'different-command' }, { custom_name: 'other-container' }, { auto_update: true }, { poll_for_updates: true },
])('rejects a runtime configuration outside the bound deploy profile %j', config => {
  expect(() => komodoRuntimeConfigSha256({ ...nativeDeployment, config: { ...nativeDeployment.config, ...config } }))
    .toThrow('komodo_release_binding');
});

it('configures only the approved image, then binds the original dispatch and independent readback', async () => {
  for (const response of [nativeDeployment, configured, configured, configured, nativeUpdate, { ...nativeUpdate, status: 'Complete' }]) {
    fetchKomodo.mockResolvedValueOnce(Response.json(response));
  }
  expect(await release.configureImage(target, { previousImage, manifestDigest }, authorization))
    .toMatchObject({ imageReference: approved, runtimeConfigSha256: target.runtimeConfigSha256 });
  expect(await release.dispatch(target, manifestDigest, authorization)).toMatchObject({ updateId, status: 'Queued' });
  expect(await release.observeUpdate(target, updateId, authorization))
    .toEqual({ updateId, actorId, deploymentId, status: 'Complete', success: true });

  expect(fetchKomodo.mock.calls.map(([url, request]) => {
    expect(request).toMatchObject({ method: 'POST', redirect: 'error',
      headers: { 'x-api-key': credentials.key, 'x-api-secret': credentials.secret } });
    return [String(url), JSON.parse(String(request?.body))];
  })).toEqual([
    [origin + '/read/GetDeployment', { deployment: deploymentId }],
    [origin + '/write/UpdateDeployment', { id: deploymentId, config: { image: configured.config.image } }],
    [origin + '/read/GetDeployment', { deployment: deploymentId }],
    [origin + '/read/GetDeployment', { deployment: deploymentId }],
    [origin + '/execute/Deploy', { deployment: deploymentId }],
    [origin + '/read/GetUpdate', { id: updateId }],
  ]);
  expect(authorization).toHaveBeenCalledTimes(12);
});

it('rejects an unbound origin or actor before authorizing a request', async () => {
  await expect(release.inspectTarget({ ...target, komodo: { origin: 'https://different.invalid', actorId } }, authorization))
    .rejects.toMatchObject({ step: 'target', reason: 'binding' });
  await expect(release.inspectTarget({ ...target, komodo: { origin, actorId: otherId } }, authorization))
    .rejects.toMatchObject({ step: 'target', reason: 'binding' });
  expect(authorization).not.toHaveBeenCalled();
  expect(fetchKomodo).not.toHaveBeenCalled();
});

it('stops before a configuration write if approval is lost after reading the target', async () => {
  fetchKomodo.mockResolvedValueOnce(Response.json(nativeDeployment));
  authorization.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('revoked'));
  await expect(release.configureImage(target, { previousImage, manifestDigest }, authorization)).rejects.toThrow('revoked');
  expect(fetchKomodo).toHaveBeenCalledExactlyOnceWith(origin + '/read/GetDeployment', expect.anything());
});

it('does not dispatch again when the write response is lost and independently rejects an unrelated update', async () => {
  fetchKomodo.mockResolvedValueOnce(Response.json(configured)).mockRejectedValueOnce(new Error('private response details'));
  await expect(release.dispatch(target, manifestDigest, authorization))
    .rejects.toMatchObject({ step: 'Deploy', reason: 'transport', message: 'komodo_release_transport' });
  expect(fetchKomodo.mock.calls.map(([url]) => url)).toEqual([origin + '/read/GetDeployment', origin + '/execute/Deploy']);

  fetchKomodo.mockResolvedValueOnce(Response.json({ ...nativeUpdate, _id: { $oid: otherId } }));
  await expect(release.observeUpdate(target, updateId, authorization)).rejects.toMatchObject({ step: 'GetUpdate', reason: 'binding' });
  expect(fetchKomodo.mock.lastCall?.[0]).toBe(origin + '/read/GetUpdate');
});

it('returns an already issued update under observation authority after write permission ends', async () => {
  let revoked = false;
  const authorizeWrite = vi.fn(async () => {
    if (revoked) throw new Error('approval_ended');
  });
  const authorizeObservation = vi.fn(async () => {});
  fetchKomodo.mockResolvedValueOnce(Response.json(configured))
    .mockImplementationOnce(async () => {
      revoked = true;
      return Response.json(nativeUpdate);
    })
    .mockResolvedValueOnce(Response.json(configured));
  await expect(release.dispatch(target, manifestDigest, authorizeWrite, undefined, authorizeObservation))
    .resolves.toMatchObject({ updateId });
  expect(authorizeWrite).toHaveBeenCalledTimes(1);
  expect(authorizeObservation).toHaveBeenCalledTimes(3);
  await expect(release.dispatch(target, manifestDigest, authorizeWrite, undefined, authorizeObservation)).rejects.toThrow('approval_ended');
  expect(fetchKomodo.mock.calls.map(([url]) => url)).toEqual([
    origin + '/read/GetDeployment', origin + '/execute/Deploy', origin + '/read/GetDeployment',
  ]);
});
