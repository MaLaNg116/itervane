import {
  komodoReleaseTargetSchema, komodoResourceIdSchema, ociDigestSchema, releaseKomodoConfigurationSchema, releaseKomodoOriginSchema,
  releaseKomodoUpdateSchema, releaseRegistryHost, type ReleaseRegistryImageProof,
} from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { z } from 'zod';

export type KomodoReleaseTarget = z.infer<typeof komodoReleaseTargetSchema>;

const secret = z.string().min(1).max(512).regex(/^[!-~]+$/);
const credentialSchema = z.strictObject({ actorId: komodoResourceIdSchema, key: secret, secret });
type Credentials = z.infer<typeof credentialSchema>;
type Authorize = () => Promise<void>;

const objectId = z.object({ $oid: komodoResourceIdSchema });
const imageReference = releaseKomodoConfigurationSchema.shape.imageReference;
const imageConfig = z.strictObject({ type: z.literal('Image'), params: z.strictObject({ image: imageReference }) });
const json = z.json();
const deploymentNetwork = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/).refine(name => name !== 'host');
const deploymentConfig = z.object({
  server_id: komodoResourceIdSchema, image: imageConfig,
  network: deploymentNetwork,
  swarm_id: z.literal('').default(''), replicas: z.literal(1).default(1),
  custom_name: z.literal('').default(''), command: z.literal('').default(''), volumes: z.literal('').default(''),
  extra_args: z.array(z.never()).max(0).default([]),
  auto_update: z.literal(false).default(false), poll_for_updates: z.literal(false).default(false),
}).catchall(json);
const deployment = z.object({ _id: objectId, name: z.string().min(1).max(128), config: deploymentConfig });
const update = z.object({
  _id: objectId, operation: z.literal('Deploy'), operator: komodoResourceIdSchema,
  target: z.object({ type: z.literal('Deployment'), id: komodoResourceIdSchema }),
  status: releaseKomodoUpdateSchema.shape.status, success: z.boolean(),
});
const deployedContainer = z.object({
  Id: z.string().regex(/^[a-f0-9]{64}$/),
  Name: z.string().regex(/^\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/),
  Image: ociDigestSchema,
  State: z.object({ Status: z.literal('running'), Running: z.literal(true), Paused: z.literal(false),
    Restarting: z.literal(false), Dead: z.literal(false) }),
  Config: z.object({ Image: imageReference }),
  HostConfig: z.object({
    NetworkMode: deploymentNetwork, Privileged: z.literal(false), PublishAllPorts: z.literal(false),
    PortBindings: z.union([z.null(), z.strictObject({})]),
  }),
  NetworkSettings: z.object({ Networks: z.record(deploymentNetwork, z.unknown()) }),
});

const routes = { GetDeployment: 'read', InspectDeploymentContainer: 'read',
  UpdateDeployment: 'write', Deploy: 'execute', GetUpdate: 'read' } as const;
type Method = keyof typeof routes;

export class KomodoReleaseError extends Error {
  constructor(readonly step: Method | 'configuration' | 'target', readonly reason: 'binding' | 'transport' | 'http' | 'response',
    readonly statusCode?: number) {
    super('komodo_release_' + reason);
    this.name = 'KomodoReleaseError';
  }
}

function orderJson(value: z.infer<typeof json>): z.infer<typeof json> {
  if (Array.isArray(value)) return value.map(orderJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, orderJson(value[key]!)]));
}

function configFingerprint({ name, config: { image: _image, ...config } }: z.infer<typeof deployment>) {
  // Komodo derives the default container name from this resource name.
  return sha256(JSON.stringify(orderJson({ name, config })));
}

export function komodoRuntimeConfigSha256(rawDeployment: unknown) {
  const target = deployment.safeParse(rawDeployment);
  if (!target.success) throw new KomodoReleaseError('target', 'binding');
  return configFingerprint(target.data);
}

async function readBody(response: Response) {
  if (!response.body) throw new Error('missing_response_body');
  const reader = response.body.getReader();
  try {
    const parts: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) return Buffer.concat(parts, size);
      size += part.value.byteLength;
      if (size > 128 * 1024) throw new Error('response_limit');
      parts.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export class KomodoReleaseClient {
  private readonly origin: string;
  readonly #credentials: Credentials;

  constructor(origin: string, credentials: Credentials) {
    const address = releaseKomodoOriginSchema.safeParse(origin);
    const auth = credentialSchema.safeParse(credentials);
    if (!address.success || !auth.success) throw new KomodoReleaseError('configuration', 'binding');
    this.origin = address.data;
    this.#credentials = auth.data;
  }

  private binding(raw: unknown) {
    const target = komodoReleaseTargetSchema.safeParse(raw);
    if (!target.success || target.data.komodo.origin !== this.origin || target.data.komodo.actorId !== this.#credentials.actorId) {
      throw new KomodoReleaseError('target', 'binding');
    }
    return target.data;
  }

  private async call<Shape extends z.ZodType>(method: Method, params: Record<string, unknown>, schema: Shape,
    authorize: Authorize, signal?: AbortSignal, authorizeReceipt: Authorize = authorize): Promise<z.output<Shape>> {
    signal?.throwIfAborted();
    await authorize();
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(8_000);
    const active = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetch(`${this.origin}/${routes[method]}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json',
          'x-api-key': this.#credentials.key, 'x-api-secret': this.#credentials.secret },
        body: JSON.stringify(params), redirect: 'error', signal: active,
      });
    } catch { throw new KomodoReleaseError(method, 'transport'); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new KomodoReleaseError(method, 'http', response.status);
    }
    let result: z.output<Shape>;
    try { result = schema.parse(JSON.parse((await readBody(response)).toString('utf8'))); }
    catch { throw new KomodoReleaseError(method, 'response'); }
    await authorizeReceipt();
    signal?.throwIfAborted();
    return result;
  }

  private verifyDeployment(method: 'GetDeployment' | 'UpdateDeployment', target: KomodoReleaseTarget, observed: z.infer<typeof deployment>) {
    const runtimeConfigSha256 = configFingerprint(observed);
    if (observed._id.$oid !== target.deploymentId || observed.config.server_id !== target.serverId
        || runtimeConfigSha256 !== target.runtimeConfigSha256) throw new KomodoReleaseError(method, 'binding');
    return { deploymentId: target.deploymentId, serverId: target.serverId, runtimeConfigSha256,
      imageReference: observed.config.image.params.image };
  }

  private approvedReference(target: KomodoReleaseTarget, digest: string) {
    const parsed = ociDigestSchema.safeParse(digest);
    if (!parsed.success) throw new KomodoReleaseError('target', 'binding');
    return `${releaseRegistryHost(target.registryOrigin)}/${target.imageRepository}@${parsed.data}`;
  }

  private verifyUpdate(method: 'Deploy' | 'GetUpdate', target: KomodoReleaseTarget, observed: z.infer<typeof update>, expectedId?: string) {
    const { _id, operator, status, success } = observed;
    if (observed.target.id !== target.deploymentId || operator !== target.komodo.actorId
        || (expectedId && _id.$oid !== expectedId)) throw new KomodoReleaseError(method, 'binding');
    return { updateId: _id.$oid, deploymentId: target.deploymentId, actorId: operator, status, success };
  }

  async inspectTarget(raw: KomodoReleaseTarget, authorize: Authorize, signal?: AbortSignal) {
    const target = this.binding(raw);
    const observed = await this.call('GetDeployment', { deployment: target.deploymentId }, deployment, authorize, signal);
    return this.verifyDeployment('GetDeployment', target, observed);
  }

  async inspectRuntime(raw: KomodoReleaseTarget, image: Pick<ReleaseRegistryImageProof, 'manifestDigest' | 'configDigest'>,
    network: string, authorize: Authorize, signal?: AbortSignal) {
    const target = this.binding(raw);
    const reference = this.approvedReference(target, image.manifestDigest);
    const digest = ociDigestSchema.safeParse(image.configDigest);
    const expectedNetwork = deploymentNetwork.safeParse(network);
    if (!digest.success || !expectedNetwork.success) throw new KomodoReleaseError('InspectDeploymentContainer', 'binding');
    const configured = await this.inspectTarget(target, authorize, signal);
    if (configured.imageReference !== reference) throw new KomodoReleaseError('InspectDeploymentContainer', 'binding');
    const container = await this.call('InspectDeploymentContainer', { deployment: target.deploymentId }, deployedContainer, authorize, signal);
    const networks = Object.keys(container.NetworkSettings.Networks);
    if (container.Config.Image !== reference || container.Image !== digest.data || container.HostConfig.NetworkMode !== expectedNetwork.data
      || networks.length !== 1 || networks[0] !== expectedNetwork.data) throw new KomodoReleaseError('InspectDeploymentContainer', 'binding');
    // The native response includes container environment and networking details. Keep only facts needed for rollout verification.
    return { ...configured, containerId: container.Id, containerName: container.Name.slice(1),
      configDigest: container.Image, network: expectedNetwork.data };
  }

  async configureImage(raw: KomodoReleaseTarget, release: { previousImage: string; manifestDigest: string },
    authorizeWrite: Authorize, signal?: AbortSignal, authorizeObservation: Authorize = authorizeWrite) {
    const target = this.binding(raw);
    const approved = this.approvedReference(target, release.manifestDigest);
    const before = await this.inspectTarget(target, authorizeObservation, signal);
    if (before.imageReference === approved) return before;
    if (before.imageReference !== release.previousImage) throw new KomodoReleaseError('UpdateDeployment', 'binding');
    const configured = await this.call('UpdateDeployment', {
      id: target.deploymentId, config: { image: { type: 'Image', params: { image: approved } } },
    }, deployment, authorizeWrite, signal, authorizeObservation);
    if (this.verifyDeployment('UpdateDeployment', target, configured).imageReference !== approved) {
      throw new KomodoReleaseError('UpdateDeployment', 'binding');
    }
    const checked = await this.inspectTarget(target, authorizeObservation, signal);
    if (checked.imageReference !== approved) throw new KomodoReleaseError('UpdateDeployment', 'binding');
    return checked;
  }

  async dispatch(raw: KomodoReleaseTarget, manifestDigest: string, authorizeWrite: Authorize, signal?: AbortSignal,
    authorizeObservation: Authorize = authorizeWrite) {
    const target = this.binding(raw);
    const approved = this.approvedReference(target, manifestDigest);
    const checked = await this.inspectTarget(target, authorizeObservation, signal);
    if (checked.imageReference !== approved) throw new KomodoReleaseError('Deploy', 'binding');
    const received = await this.call('Deploy', { deployment: target.deploymentId }, update, authorizeWrite, signal, authorizeObservation);
    return this.verifyUpdate('Deploy', target, received);
  }

  async observeUpdate(raw: KomodoReleaseTarget, updateId: string, authorize: Authorize, signal?: AbortSignal) {
    const target = this.binding(raw);
    const id = komodoResourceIdSchema.safeParse(updateId);
    if (!id.success) throw new KomodoReleaseError('GetUpdate', 'binding');
    const observed = await this.call('GetUpdate', { id: id.data }, update, authorize, signal);
    return this.verifyUpdate('GetUpdate', target, observed, id.data);
  }
}
