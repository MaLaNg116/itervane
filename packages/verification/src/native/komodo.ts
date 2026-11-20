import { setTimeout as wait } from 'node:timers/promises';
import { z } from 'zod';

export const komodoVersion = '2.3.4';
export const dockerDigest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const objectId = z.string().regex(/^[a-f0-9]{24}$/);
export const resource = z.object({ _id: z.object({ $oid: objectId }), name: z.string().min(1).max(128) });
export const image = z.object({ type: z.literal('Image'), params: z.object({ image: z.string().max(256) }) });
export const deployment = resource.extend({
  config: z.object({
    server_id: objectId,
    image,
    network: z.literal('none'),
    restart: z.literal('no'),
    labels: z.string().max(128),
    swarm_id: z.literal('').default(''),
    custom_name: z.literal('').default(''),
    volumes: z.literal('').default(''),
    command: z.literal('').default(''),
    environment: z.literal('').default(''),
    extra_args: z.array(z.never()).max(0).default([]),
    auto_update: z.literal(false).default(false),
    poll_for_updates: z.literal(false).default(false),
  }),
});

type Routes = {
  auth: 'LoginLocalUser';
  read: 'GetVersion' | 'GetServer' | 'GetServerState' | 'GetDeployment' | 'GetUpdate';
  write: 'CreateDeployment' | 'CreateServiceUser' | 'UpdatePermissionOnTarget' | 'CreateApiKeyForServiceUser' | 'UpdateDeployment';
  execute: 'Deploy';
};

export class KomodoError extends Error {
  constructor(readonly step: string, readonly reason: 'transport' | 'response' | 'http' | 'deadline' | 'binding' | 'permission', readonly status?: number) {
    super(step);
  }
}

export async function readBounded(response: Response, maxBytes: number) {
  if (!response.body) return Buffer.alloc(0);
  const stream = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await stream.read();
      if (done) return Buffer.concat(chunks, length);
      length += value.byteLength;
      if (length > maxBytes) throw new Error('response limit');
      chunks.push(value);
    }
  } finally {
    await stream.cancel().catch(() => undefined);
    stream.releaseLock();
  }
}

type Credentials = { jwt: string } | { key: string; secret: string };

const nativeError = z.object({ error: z.string(), trace: z.array(z.string()).default([]) });
async function isDeploymentReadDenied(method: string, response: Response) {
  if (method !== 'GetDeployment' || ![403, 500].includes(response.status)) {
    await response.body?.cancel().catch(() => undefined);
    return false;
  }
  try {
    const body = await readBounded(response, 8192);
    const error = nativeError.parse(JSON.parse(body.toString('utf8')));
    // Komodo 2.3.4's permission helper wraps this denial as HTTP 500.
    const denied = 'User does not have required permissions on this Deployment. Must have at least Read permissions';
    return [error.error, ...error.trace].some(message => message === denied);
  } catch {
    return false;
  }
}

export class KomodoNativeClient {
  constructor(private readonly origin: string, private readonly credentials?: Credentials) {
    if (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(origin)) throw new KomodoError('CoreOrigin', 'binding');
  }

  async call<Group extends keyof Routes, Shape extends z.ZodType>(
    group: Group, method: Routes[Group], params: Record<string, unknown>, shape: Shape,
  ): Promise<z.output<Shape>> {
    const route = group === 'auth' ? 'auth/login' : group;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.credentials && 'jwt' in this.credentials) headers.authorization = this.credentials.jwt;
    else if (this.credentials) {
      headers['x-api-key'] = this.credentials.key;
      headers['x-api-secret'] = this.credentials.secret;
    }
    let response: Response;
    try {
      response = await fetch(this.origin + '/' + route + '/' + method, {
        method: 'POST', headers, body: JSON.stringify(params), redirect: 'error', signal: AbortSignal.timeout(8000),
      });
    } catch {
      throw new KomodoError(method, 'transport');
    }
    if (!response.ok) {
      const denied = await isDeploymentReadDenied(method, response);
      throw new KomodoError(method, denied ? 'permission' : 'http', response.status);
    }
    try {
      const body = await readBounded(response, 128 * 1024);
      return shape.parse(body.length ? JSON.parse(body.toString('utf8')) : undefined);
    } catch {
      throw new KomodoError(method, 'response');
    }
  }
}

const updateId = z.object({ _id: z.object({ $oid: objectId }) });
const loginReply = z.object({
  type: z.literal('Jwt'),
  data: z.object({ jwt: z.string().min(1).max(4096) }),
});
export async function loginLocalAdmin(client: KomodoNativeClient, username: string, password: string) {
  return (await client.call('auth', 'LoginLocalUser', { username, password }, loginReply)).data;
}

const finalUpdate = updateId.extend({
  operation: z.literal('Deploy'),
  operator: objectId,
  target: z.object({ type: z.literal('Deployment'), id: objectId }),
  status: z.enum(['Queued', 'InProgress', 'Complete']),
  success: z.boolean(),
});

export async function observeUpdate(client: KomodoNativeClient, id: string, target: string, actor: string) {
  const deadline = performance.now() + 65_000;
  while (performance.now() < deadline) {
    const observed = await client.call('read', 'GetUpdate', { id }, finalUpdate);
    if (observed._id.$oid !== id || observed.target.id !== target || observed.operator !== actor) {
      throw new KomodoError('GetUpdate', 'binding');
    }
    if (observed.status === 'Complete') return observed.success;
    await wait(500);
  }
  throw new KomodoError('GetUpdate', 'deadline');
}

export async function requestDeploy(client: KomodoNativeClient, target: string) {
  const result = await client.call('execute', 'Deploy', { deployment: target }, updateId);
  return result._id.$oid;
}
