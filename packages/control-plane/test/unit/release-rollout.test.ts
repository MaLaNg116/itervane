import { releaseRolloutCheckSchema, type OperationsRestartBaseline, type ReleaseRolloutCheck } from '@itervane/contracts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { KomodoReleaseError } from '../../src/runtime/release-komodo.js';
import { ReleaseRolloutVerifier } from '../../src/runtime/release-rollout.js';
import { fingerprintRolloutCheck } from '../../src/service/release-targets.js';

const profile = {
  version: 1, origin: 'https://demo.example.invalid', healthPath: '/health', network: 'demo-private', backendPort: 3000,
  traefik: { apiOrigin: 'http://127.0.0.1:8089', entryPoint: 'websecure', routeName: 'demo',
    forwardAuthAddress: 'http://demo-access:4180/oauth2/auth' },
  probeIdentity: { issuer: 'https://idp.example.invalid/realms/demo', clientId: 'demo-probe', audience: 'demo', subject: 'demo-service-account' },
} as const satisfies ReleaseRolloutCheck;
const manifestDigest = 'sha256:' + 'c'.repeat(64);
const configDigest = 'sha256:' + 'd'.repeat(64);
const input = { check: profile, rolloutCheckSha256: fingerprintRolloutCheck(profile), image: { manifestDigest, configDigest },
  target: { deploymentId: 'a'.repeat(24), serverId: 'b'.repeat(24), runtimeConfigSha256: 'e'.repeat(64),
    registryOrigin: 'https://registry.example.invalid', imageRepository: 'demo',
    komodo: { origin: 'https://komodo.example.invalid', actorId: 'f'.repeat(24) } } };
const runtime = { ...input.target, containerName: 'demo-runtime', containerId: '1'.repeat(64), configDigest,
  imageReference: 'registry.example.invalid/demo@' + manifestDigest, network: profile.network };
const { containerId, imageReference, runtimeConfigSha256, network } = runtime;
const restartInput = { ...input, containerId, version: 'v2' };
const stopped = { containerId, imageReference, runtimeConfigSha256, network, configDigest,
  state: 'exited', startedAt: '2026-11-22T08:18:15.123456789Z' } satisfies OperationsRestartBaseline;
const restarted = { ...runtime, startedAt: '2026-11-22T08:18:15.123456790Z' };
const route = { name: 'demo@file', provider: 'file', status: 'enabled', tls: {}, using: ['websecure'],
  rule: 'Host(`demo.example.invalid`)', service: 'demo', middlewares: ['demo-auth', 'demo-strip'] };
const login = { ...route, name: 'demo-login@file', rule: route.rule + ' && PathPrefix(`/oauth2/`)',
  service: 'demo-login', middlewares: [] };
const health = { ...route, name: 'demo-health@file', rule: route.rule + ' && Path(`/health`) && Method(`GET`)',
  middlewares: ['demo-health-auth', 'demo-strip'] };
const fixtures = {
  '/api/http/routers?per_page=100': [route, login, health],
  '/api/tcp/routers?per_page=100': [],
  '/api/http/services/demo%40file': { name: 'demo@file', provider: 'file', status: 'enabled',
    type: 'loadbalancer', loadBalancer: { servers: [{ url: 'http://demo-runtime:3000' }] } },
  '/api/http/services/demo-login%40file': { name: 'demo-login@file', provider: 'file', status: 'enabled',
    type: 'loadbalancer', loadBalancer: { servers: [{ url: 'http://demo-access:4180' }] } },
  '/api/http/middlewares/demo-auth%40file': { name: 'demo-auth@file', provider: 'file', status: 'enabled', type: 'forwardauth',
    forwardAuth: { address: profile.traefik.forwardAuthAddress, trustForwardHeader: false, authRequestHeaders: ['Cookie'] } },
  '/api/http/middlewares/demo-health-auth%40file': { name: 'demo-health-auth@file', provider: 'file', status: 'enabled', type: 'forwardauth',
    forwardAuth: { address: profile.traefik.forwardAuthAddress, trustForwardHeader: false, authRequestHeaders: ['Authorization', 'Cookie'] } },
  '/api/http/middlewares/demo-strip%40file': { name: 'demo-strip@file', provider: 'file', status: 'enabled', type: 'headers',
    headers: { customRequestHeaders: { Authorization: '', Cookie: '' } } },
};

const token = 'test.token.value';
const tokenSource = vi.fn(async () => token);
const inspectRuntime = vi.fn<() => Promise<typeof runtime & { startedAt?: string }>>();
const inspectStoppedRuntime = vi.fn<() => Promise<OperationsRestartBaseline>>();
const authenticate = vi.fn(async () => {});
const verifier = new ReleaseRolloutVerifier({ inspectRuntime, inspectStoppedRuntime }, tokenSource);
const request = vi.fn<typeof fetch>();

function emulateIngress(changes: Record<string, unknown> = {}, health: (hasToken: boolean) => Response = allowed =>
  allowed ? Response.json({ status: 'healthy', version: 'v2' }) : new Response(null, { status: 401 })) {
  request.mockImplementation(async (url, init) => {
    const address = new URL(String(url));
    const path = address.pathname + address.search;
    if (address.origin === profile.traefik.apiOrigin) return Response.json({ ...fixtures, ...changes }[path], {
      headers: address.search ? { 'x-next-page': '1' } : {},
    });
    if (address.origin === profile.origin && path === profile.healthPath) {
      return health(new Headers(init?.headers).get('authorization') === 'Bearer ' + token);
    }
    throw new Error('Unexpected request');
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  inspectRuntime.mockReset().mockResolvedValue(runtime);
  inspectStoppedRuntime.mockReset().mockResolvedValue(stopped);
  vi.stubGlobal('fetch', request);
  emulateIngress();
});
afterEach(() => { vi.unstubAllGlobals(); });

it('requires two stable runtime reads and sends a credential to the single approved HTTPS path', async () => {
  const result = await verifier.observe(input, authenticate);
  expect(result).toMatchObject({ rolloutCheckSha256: input.rolloutCheckSha256,
    anonymousStatus: 401, healthStatus: 200, containerId: runtime.containerId, configDigest, version: 'v2' });
  expect(inspectRuntime).toHaveBeenCalledTimes(2);
  expect(tokenSource).toHaveBeenCalledOnce();
  const credentialRequests = request.mock.calls.filter(([, init]) => new Headers(init?.headers).has('authorization'));
  expect(credentialRequests.map(([url]) => url)).toEqual([profile.origin + '/health']);
  expect(request.mock.calls.every(([, init]) => init?.redirect === 'manual')).toBe(true);
  expect(JSON.stringify(result)).not.toContain(token);
});

it('captures the stopped baseline and confirms its exact container with a new stable start and protected health', async () => {
  const before = await verifier.captureRestartBaseline(restartInput, authenticate);
  expect(before).toEqual(stopped);
  expect(inspectStoppedRuntime).toHaveBeenCalledWith(input.target, input.image, profile.network, authenticate, undefined);
  expect(request).not.toHaveBeenCalled();
  inspectRuntime.mockResolvedValue(restarted);
  await expect(verifier.observeRestart(restartInput, before, authenticate)).resolves.toMatchObject({
    startedAt: restarted.startedAt, runtime: { containerId, configDigest, version: 'v2', anonymousStatus: 401, healthStatus: 200 },
  });
  expect(inspectRuntime).toHaveBeenCalledTimes(2);
  expect(tokenSource).toHaveBeenCalledOnce();
});

it.each([
  runtime,
  { ...runtime, startedAt: stopped.startedAt },
  { ...runtime, startedAt: '2026-11-22T08:18:15.123456788Z' },
  { ...restarted, containerId: '2'.repeat(64) },
  { ...restarted, configDigest: 'sha256:' + '0'.repeat(64) },
])('requires a newer start on the same frozen runtime before requesting health credentials', async observed => {
  inspectRuntime.mockResolvedValue(observed);
  await expect(verifier.observeRestart(restartInput, stopped, authenticate)).rejects.toMatchObject({ reason: 'runtime_changed' });
  expect(request).not.toHaveBeenCalled();
  expect(tokenSource).not.toHaveBeenCalled();
});

it('refuses a baseline from another container, a restart during health verification and a stale health version', async () => {
  inspectStoppedRuntime.mockResolvedValueOnce({ ...stopped, containerId: '2'.repeat(64) });
  await expect(verifier.captureRestartBaseline(restartInput, authenticate)).rejects.toMatchObject({ reason: 'runtime_changed' });
  await expect(verifier.observeRestart(restartInput, { ...stopped, imageReference: stopped.imageReference.replace('/demo@', '/other@') }, authenticate))
    .rejects.toMatchObject({ reason: 'runtime_changed' });
  expect(inspectRuntime).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
  inspectRuntime.mockResolvedValueOnce(restarted).mockResolvedValueOnce({ ...restarted, startedAt: '2026-11-22T08:18:15.123456791Z' });
  await expect(verifier.observeRestart(restartInput, stopped, authenticate)).rejects.toMatchObject({ reason: 'runtime_changed' });
  inspectRuntime.mockResolvedValue(restarted);
  await expect(verifier.observeRestart({ ...restartInput, version: 'v1' }, stopped, authenticate)).rejects.toMatchObject({ reason: 'health_failed' });
});

it('observes an authenticated application 503 for the published version while preserving the release health gate', async () => {
  inspectRuntime.mockResolvedValue(restarted);
  emulateIngress({}, authorized => authorized ? Response.json({ status: 'unhealthy', version: 'v2' }, { status: 503 })
    : new Response(null, { status: 401 }));
  await expect(verifier.observeApplicationHealth(restartInput, authenticate)).resolves.toEqual({
    status: 'unhealthy', reason: 'application_unhealthy', evidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  await expect(verifier.observe(input, authenticate)).rejects.toMatchObject({ reason: 'health_failed' });
});

it('declines to attribute a proxy error, mismatched version or replacement container to the published runtime', async () => {
  inspectRuntime.mockResolvedValue(restarted);
  emulateIngress({}, authorized => authorized ? new Response('Service unavailable', { status: 503 }) : new Response(null, { status: 401 }));
  await expect(verifier.observeApplicationHealth(restartInput, authenticate)).rejects.toMatchObject({ reason: 'health_failed' });
  emulateIngress({}, authorized => authorized ? Response.json({ status: 'unhealthy', version: 'v1' }, { status: 503 })
    : new Response(null, { status: 401 }));
  await expect(verifier.observeApplicationHealth(restartInput, authenticate)).rejects.toMatchObject({ reason: 'runtime_changed' });
  tokenSource.mockClear();
  inspectRuntime.mockResolvedValue({ ...restarted, containerId: '2'.repeat(64) });
  await expect(verifier.observeApplicationHealth(restartInput, authenticate)).rejects.toMatchObject({ reason: 'runtime_changed' });
  expect(tokenSource).not.toHaveBeenCalled();
});

it('requires an independently confirmed stopped state for the same container', async () => {
  inspectRuntime.mockRejectedValue(new KomodoReleaseError('InspectDeploymentContainer', 'response'));
  await expect(verifier.observeApplicationHealth(restartInput, authenticate)).resolves.toMatchObject({
    status: 'unhealthy', reason: 'runtime_stopped',
  });
  inspectStoppedRuntime.mockResolvedValue({ ...stopped, containerId: '2'.repeat(64) });
  await expect(verifier.observeApplicationHealth(restartInput, authenticate)).rejects.toMatchObject({ reason: 'runtime_changed' });
  expect(tokenSource).not.toHaveBeenCalled();
});

it.each([
  ['a different backend', { '/api/http/services/demo%40file': {
    ...fixtures['/api/http/services/demo%40file'], loadBalancer: { servers: [{ url: 'http://healthy-other:3000' }] },
  } }],
  ['missing credential scrubbing', { '/api/http/middlewares/demo-strip%40file': {
    ...fixtures['/api/http/middlewares/demo-strip%40file'], headers: { customRequestHeaders: { Cookie: '' } },
  } }],
  ['bearer credentials accepted on the browser route', { '/api/http/middlewares/demo-auth%40file': {
    ...fixtures['/api/http/middlewares/demo-auth%40file'], forwardAuth: {
      ...fixtures['/api/http/middlewares/demo-auth%40file'].forwardAuth, authRequestHeaders: ['Authorization', 'Cookie'],
    },
  } }],
  ['another route for the same host', { '/api/http/routers?per_page=100': [route, login, health, { ...route, name: 'unexpected@file' }] }],
  ['a TCP route on the protected entry point', { '/api/tcp/routers?per_page=100': [{ status: 'enabled', using: ['websecure'] }] }],
])('refuses %s before using a credential', async (_name, changes) => {
  emulateIngress(changes);
  await expect(verifier.observe(input, authenticate)).rejects.toMatchObject({ reason: 'ingress_route' });
  expect(tokenSource).not.toHaveBeenCalled();
});

it('does not authenticate to an anonymously open or redirected application', async () => {
  emulateIngress({}, () => Response.json({ status: 'healthy', version: 'v2' }));
  await expect(verifier.observe(input, authenticate)).rejects.toMatchObject({ reason: 'anonymous_access' });
  expect(tokenSource).not.toHaveBeenCalled();

  emulateIngress({}, authorized => authorized ? Response.redirect('https://other.example.invalid/') : new Response(null, { status: 403 }));
  await expect(verifier.observe(input, authenticate)).rejects.toMatchObject({ reason: 'health_failed' });
  expect(request.mock.calls.some(([url]) => String(url).includes('other.example.invalid'))).toBe(false);
});

it('refuses supplemental health data and a replaced container', async () => {
  emulateIngress({}, authorized => authorized
    ? Response.json({ status: 'healthy', version: 'v2', extra: 'unexpected' })
    : new Response(null, { status: 401 }));
  await expect(verifier.observe(input, authenticate)).rejects.toMatchObject({ reason: 'health_failed' });

  emulateIngress();
  inspectRuntime.mockResolvedValueOnce(runtime).mockResolvedValueOnce({ ...runtime, containerId: '2'.repeat(64) });
  await expect(verifier.observe(input, authenticate)).rejects.toMatchObject({ reason: 'runtime_changed' });
});

it('rejects stale fingerprints before any outbound request', async () => {
  await expect(verifier.observe({ ...input, check: { ...profile, origin: 'https://changed.example.invalid' } }, authenticate))
    .rejects.toMatchObject({ reason: 'rollout_profile' });
  expect(inspectRuntime).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});

it.each([
  { origin: 'http://demo.example.invalid' },
  { origin: 'https://test@demo.example.invalid' },
  { healthPath: '//wrong.example.invalid/health' },
  { network: 'bridge' },
  { probeIdentity: { ...profile.probeIdentity, secret: 'fixture' } },
])('rejects an unsafe or credential-bearing profile', changes => {
  expect(releaseRolloutCheckSchema.safeParse({ ...profile, ...changes }).success).toBe(false);
});
