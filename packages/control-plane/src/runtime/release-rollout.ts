import { operationsRestartBaselineSchema, operationsRestartRecoveryObservationSchema, operationsRuntimeStartedAtSchema, releaseRegistryHost, releaseRolloutCheckSchema,
  releaseRuntimeObservationSchema, type OperationsHealthSignal, type OperationsRestartBaseline,
  type ReleaseRegistryImageProof, type ReleaseRolloutCheck } from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { z } from 'zod';
import { createIdentityVerifier } from '../auth/identity.js';
import { fingerprintRolloutCheck } from '../service/release-targets.js';
import { KomodoReleaseError, type KomodoReleaseClient, type KomodoReleaseTarget } from './release-komodo.js';
import { readIngressJson, ReleaseIngressError, verifyTraefikIngress } from './release-traefik.js';

const probeToken = z.string().max(16_384).regex(/^[A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$/);
const healthResponse = z.strictObject({
  status: z.literal('healthy'), version: releaseRuntimeObservationSchema.shape.version,
});
const unhealthyResponse = healthResponse.extend({ status: z.literal('unhealthy') });
const tokenResponse = z.object({
  access_token: probeToken, token_type: z.literal('Bearer'), expires_in: z.int().min(1).max(300),
});

export type RolloutProbeTokenSource = (identity: ReleaseRolloutCheck['probeIdentity'], signal: AbortSignal) => Promise<string>;

export function createKeycloakRolloutTokenSource(identity: ReleaseRolloutCheck['probeIdentity'], clientSecret: string): RolloutProbeTokenSource {
  const expected = releaseRolloutCheckSchema.shape.probeIdentity.parse(identity);
  if (!clientSecret || clientSecret.length > 1024) throw new ReleaseIngressError('probe_identity');
  const verify = createIdentityVerifier({ issuer: expected.issuer, audience: expected.audience });
  const tokenUrl = expected.issuer + '/protocol/openid-connect/token';
  return async (requested, signal) => {
    if (requested.issuer !== expected.issuer || requested.clientId !== expected.clientId ||
        requested.audience !== expected.audience || requested.subject !== expected.subject) {
      throw new ReleaseIngressError('probe_identity');
    }
    signal.throwIfAborted();
    const active = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
    try {
      const response = await fetch(tokenUrl, { method: 'POST', redirect: 'manual', cache: 'no-store',
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: expected.clientId, client_secret: clientSecret }),
        signal: active,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new ReleaseIngressError('probe_identity');
      }
      const token = tokenResponse.parse(await readIngressJson(response, 24 * 1024));
      const principal = await verify(token.access_token);
      if (principal.subject !== expected.subject || principal.clientId !== expected.clientId ||
          principal.expiresAt > Math.floor(Date.now() / 1000) + 305) throw new ReleaseIngressError('probe_identity');
      active.throwIfAborted();
      return token.access_token;
    } catch {
      throw new ReleaseIngressError('probe_identity');
    }
  };
}

export type RolloutSubject = {
  check: unknown;
  rolloutCheckSha256: string;
  target: KomodoReleaseTarget;
  image: Pick<ReleaseRegistryImageProof, 'manifestDigest' | 'configDigest'>;
};

type AuthorizeObservation = () => Promise<void>;
export type RestartSubject = RolloutSubject & Pick<OperationsRestartBaseline, 'containerId'> & { version: string };

function installedCheck(input: RolloutSubject) {
  const parsed = releaseRolloutCheckSchema.safeParse(input.check);
  if (!parsed.success || fingerprintRolloutCheck(parsed.data) !== input.rolloutCheckSha256) throw new ReleaseIngressError('rollout_profile');
  return parsed.data;
}

export function matchRestartBaseline(input: RestartSubject, raw: unknown) {
  const check = installedCheck(input);
  const baseline = operationsRestartBaselineSchema.parse(raw);
  const reference = `${releaseRegistryHost(input.target.registryOrigin)}/${input.target.imageRepository}@${input.image.manifestDigest}`;
  if (baseline.containerId !== input.containerId || baseline.configDigest !== input.image.configDigest ||
      baseline.imageReference !== reference || baseline.runtimeConfigSha256 !== input.target.runtimeConfigSha256 || baseline.network !== check.network) {
    throw new ReleaseIngressError('runtime_changed');
  }
  return baseline;
}

export class ReleaseRolloutVerifier {
  constructor(private readonly komodo: Pick<KomodoReleaseClient, 'inspectRuntime' | 'inspectStoppedRuntime'>,
    private readonly tokenSource: RolloutProbeTokenSource) {}

  async observe(input: RolloutSubject, authorize: AuthorizeObservation, signal?: AbortSignal) {
    return releaseRuntimeObservationSchema.parse((await this.observeStableRuntime(input, authorize, signal)).runtime);
  }

  async captureRestartBaseline(input: RestartSubject, authorize: AuthorizeObservation, signal?: AbortSignal) {
    const check = installedCheck(input);
    const baseline = await this.komodo.inspectStoppedRuntime(input.target, input.image, check.network, authorize, signal);
    return matchRestartBaseline(input, baseline);
  }

  async observeRestart(input: RestartSubject, baseline: OperationsRestartBaseline, authorize: AuthorizeObservation, signal?: AbortSignal) {
    // Reject a stale baseline before reading a container or requesting a probe credential.
    const checked = matchRestartBaseline(input, baseline);
    const health = await this.observeStableRuntime(input, authorize, signal, { stopped: checked });
    if (health.runtime.version !== input.version) throw new ReleaseIngressError('health_failed');
    return operationsRestartRecoveryObservationSchema.parse(health);
  }

  async observeApplicationHealth(input: RestartSubject, authorize: AuthorizeObservation, signal?: AbortSignal):
  Promise<Exclude<OperationsHealthSignal, { status: 'unavailable' }>> {
    try {
      const observed = await this.observeStableRuntime(input, authorize, signal, { application: input });
      const evidenceSha256 = sha256(JSON.stringify(observed));
      return observed.runtime.healthStatus === 200 ? { status: 'healthy', evidenceSha256 }
        : { status: 'unhealthy', reason: 'application_unhealthy', evidenceSha256 };
    } catch (error) {
      if (!(error instanceof KomodoReleaseError && error.step === 'InspectDeploymentContainer' && error.reason === 'response')) throw error;
      const stopped = await this.captureRestartBaseline(input, authorize, signal);
      await authorize();
      signal?.throwIfAborted();
      return { status: 'unhealthy', reason: 'runtime_stopped', evidenceSha256: sha256(JSON.stringify(stopped)) };
    }
  }

  private async observeStableRuntime(input: RolloutSubject, authorize: AuthorizeObservation, signal?: AbortSignal,
    { stopped, application }: { stopped?: OperationsRestartBaseline; application?: Pick<RestartSubject, 'containerId' | 'version'> } = {}) {
    const check = installedCheck(input);
    const deadline = AbortSignal.timeout(30_000);
    const active = signal ? AbortSignal.any([signal, deadline]) : deadline;
    active.throwIfAborted();
    const runtime = () => this.komodo.inspectRuntime(input.target, input.image, check.network, authorize, active);
    const before = await runtime();
    if (application && (before.containerId !== application.containerId || !operationsRuntimeStartedAtSchema.safeParse(before.startedAt).success)) {
      throw new ReleaseIngressError('runtime_changed');
    }
    if (stopped) {
      const start = operationsRuntimeStartedAtSchema.safeParse(before.startedAt);
      if (!start.success || start.data <= stopped.startedAt || before.containerId !== stopped.containerId
          || before.configDigest !== stopped.configDigest || before.imageReference !== stopped.imageReference
          || before.runtimeConfigSha256 !== stopped.runtimeConfigSha256 || before.network !== stopped.network) {
        throw new ReleaseIngressError('runtime_changed');
      }
    }
    await verifyTraefikIngress(check, before.containerName, authorize, active);

    const anonymous = await this.requestHealth(check, authorize, active);
    await anonymous.body?.cancel().catch(() => undefined);
    const anonymousStatus = anonymous.status;
    if (anonymousStatus !== 401 && anonymousStatus !== 403) throw new ReleaseIngressError('anonymous_access');

    await authorize();
    active.throwIfAborted();
    const token = probeToken.safeParse(await this.tokenSource(check.probeIdentity, active));
    if (!token.success) throw new ReleaseIngressError('probe_identity');
    const allowed = await this.requestHealth(check, authorize, active, token.data);
    const responseSchema = allowed.status === 200 ? healthResponse : application && allowed.status === 503 ? unhealthyResponse : undefined;
    if (!responseSchema || !/^application\/json(?:\s*;|$)/i.test(allowed.headers.get('content-type') ?? '')) {
      await allowed.body?.cancel().catch(() => undefined);
      throw new ReleaseIngressError('health_failed');
    }
    let health: z.infer<typeof healthResponse> | z.infer<typeof unhealthyResponse>;
    try { health = responseSchema.parse(await readIngressJson(allowed, 2048)); }
    catch { throw new ReleaseIngressError('health_failed'); }
    if (application && health.version !== application.version) throw new ReleaseIngressError('runtime_changed');

    const after = await runtime();
    if (after.containerId !== before.containerId || after.containerName !== before.containerName ||
        after.configDigest !== before.configDigest || after.imageReference !== before.imageReference ||
        after.runtimeConfigSha256 !== before.runtimeConfigSha256 || after.network !== before.network || after.startedAt !== before.startedAt) {
      throw new ReleaseIngressError('runtime_changed');
    }
    await verifyTraefikIngress(check, after.containerName, authorize, active);
    await authorize();
    active.throwIfAborted();
    const observation = { rolloutCheckSha256: input.rolloutCheckSha256,
      containerId: after.containerId, configDigest: after.configDigest, imageReference: after.imageReference,
      runtimeConfigSha256: after.runtimeConfigSha256, network: after.network, anonymousStatus,
      healthStatus: health.status === 'healthy' ? 200 as const : 503 as const, version: health.version };
    return { runtime: observation, startedAt: after.startedAt };
  }

  private async requestHealth(check: ReleaseRolloutCheck, authorize: AuthorizeObservation, signal: AbortSignal, token?: string) {
    await authorize();
    signal.throwIfAborted();
    const headers: Record<string, string> = { accept: 'application/json', 'cache-control': 'no-store' };
    if (token) headers.authorization = 'Bearer ' + token;
    try {
      return await fetch(check.origin + check.healthPath, { method: 'GET', redirect: 'manual',
        cache: 'no-store', credentials: 'omit', headers, signal });
    } catch {
      throw new ReleaseIngressError('ingress_unavailable');
    }
  }
}
