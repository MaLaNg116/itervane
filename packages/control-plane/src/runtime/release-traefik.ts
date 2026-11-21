import type { ReleaseRolloutCheck } from '@itervane/contracts';
import { z } from 'zod';

const dockerDnsName = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const allowedHostRule = /^Host\(`([a-z0-9.-]+)`\)(?: && (?:PathPrefix\(`\/oauth2\/`\)|Path\(`\/health`\) && Method\(`GET`\)))?$/;
const routerStatus = z.object({
  status: z.string(), entryPoints: z.array(z.string()).default([]), using: z.array(z.string()).default([]),
});
const httpRouter = routerStatus.extend({
  name: z.string(), provider: z.string(), rule: z.string(), service: z.string(),
  middlewares: z.array(z.string()).default([]), tls: z.object({}).optional(),
});
const liveResource = z.object({ name: z.string(), provider: z.literal('file'), status: z.literal('enabled') });
const httpService = liveResource.extend({
  type: z.literal('loadbalancer'),
  loadBalancer: z.object({ servers: z.tuple([z.object({ url: z.string() })]) }),
});
const forwardAuth = liveResource.extend({
  type: z.literal('forwardauth'),
  forwardAuth: z.object({
    address: z.string(),
    trustForwardHeader: z.literal(false).optional(),
    authRequestHeaders: z.array(z.string()),
    authResponseHeaders: z.array(z.never()).default([]),
    authResponseHeadersRegex: z.literal('').optional(),
    addAuthCookiesToResponse: z.array(z.never()).default([]),
    forwardBody: z.literal(false).optional(),
    tls: z.object({ insecureSkipVerify: z.literal(false).optional() }).optional(),
  }),
});
const credentialRemoval = liveResource.extend({
  type: z.literal('headers'),
  headers: z.object({ customRequestHeaders: z.record(z.string(), z.literal('')) }),
});

export class ReleaseIngressError extends Error {
  constructor(readonly reason: 'ingress_route' | 'ingress_unavailable' | 'anonymous_access' | 'health_failed' |
    'runtime_changed' | 'rollout_profile' | 'probe_identity') {
    super('release_' + reason);
    this.name = 'ReleaseIngressError';
  }
}

export async function readIngressJson(response: Response, maximumBytes: number) {
  if (!response.body) throw new Error('missing ingress response');
  const reader = response.body.getReader();
  try {
    const parts: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) return JSON.parse(Buffer.concat(parts, bytes).toString('utf8')) as unknown;
      bytes += part.value.length;
      if (bytes > maximumBytes) throw new Error('ingress response limit');
      parts.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function fileResource(name: string) {
  return name.includes('@') ? name : name + '@file';
}

function headerSetMatches(actual: readonly string[], expected: ReadonlySet<string>) {
  return actual.length === expected.size && new Set(actual.map(name => name.toLowerCase())).size === expected.size
    && actual.every(name => expected.has(name.toLowerCase()));
}

const bearerAndCookie = new Set(['authorization', 'cookie']);
const browserCookie = new Set(['cookie']);

export async function verifyTraefikIngress(check: ReleaseRolloutCheck, containerName: string,
  authorize: () => Promise<void>, signal: AbortSignal) {
  const { apiOrigin, entryPoint, routeName, forwardAuthAddress } = check.traefik;
  if (!dockerDnsName.test(containerName)) throw new ReleaseIngressError('ingress_route');
  const hostname = new URL(check.origin).hostname;
  const hostRule = 'Host(`' + hostname + '`)';
  const loginRule = hostRule + ' && PathPrefix(`/oauth2/`)';
  const healthRule = hostRule + ' && Path(`/health`) && Method(`GET`)';
  const authName = routeName + '-auth';
  const healthAuthName = routeName + '-health-auth';
  const stripName = routeName + '-strip';
  const loginName = routeName + '-login';
  const healthName = routeName + '-health';
  const backend = 'http://' + containerName + ':' + check.backendPort;
  const proxy = new URL(forwardAuthAddress).origin;
  const activeHere = (router: z.infer<typeof routerStatus>) => router.status !== 'disabled' &&
    (router.entryPoints.includes(entryPoint) || router.using.includes(entryPoint));
  const atEntry = (router: z.infer<typeof httpRouter>) => router.provider === 'file' && router.status === 'enabled'
    && router.using.includes(entryPoint) && !!router.tls;
  const protectedRoute = (router: z.infer<typeof httpRouter>, auth: string) => atEntry(router) &&
    fileResource(router.service) === fileResource(routeName) && router.middlewares.length === 2 &&
    fileResource(router.middlewares[0]!) === fileResource(auth) && fileResource(router.middlewares[1]!) === fileResource(stripName);

  async function read<Shape extends z.ZodType>(path: string, shape: Shape) {
    signal.throwIfAborted();
    await authorize();
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(apiOrigin + path, { redirect: 'manual', cache: 'no-store', credentials: 'omit',
        headers: { accept: 'application/json' }, signal });
    } catch {
      throw new ReleaseIngressError('ingress_unavailable');
    }
    const nextPage = response.headers.get('x-next-page');
    // Traefik 3.7 uses page 1 as the terminal marker. No verdict may rely on a partial route inventory.
    if (response.status !== 200 || (nextPage !== null && nextPage !== '1')) {
      await response.body?.cancel().catch(() => undefined);
      throw new ReleaseIngressError('ingress_unavailable');
    }
    try { return shape.parse(await readIngressJson(response, 96 * 1024)); }
    catch { throw new ReleaseIngressError('ingress_route'); }
  }

  // Consider every active route on the application entry point, including TCP routers that could bypass HTTP authentication.
  const [http, tcp] = await Promise.all([
    read('/api/http/routers?per_page=100', z.array(httpRouter)),
    read('/api/tcp/routers?per_page=100', z.array(routerStatus)),
  ]);
  const routes = http.filter(activeHere);
  if (tcp.some(activeHere) || routes.some(route => !allowedHostRule.test(route.rule))) {
    throw new ReleaseIngressError('ingress_route');
  }
  const matching = routes.filter(route => allowedHostRule.exec(route.rule)?.[1] === hostname);
  const main = matching.find(route => route.name === fileResource(routeName));
  const login = matching.find(route => route.name === fileResource(loginName));
  const health = matching.find(route => route.name === fileResource(healthName));
  if (matching.length !== 3 || !main || !login || !health ||
      main.rule !== hostRule || !protectedRoute(main, authName) || health.rule !== healthRule || !protectedRoute(health, healthAuthName) ||
      login.rule !== loginRule || !atEntry(login) || login.middlewares.length !== 0 || fileResource(login.service) !== fileResource(loginName)) {
    throw new ReleaseIngressError('ingress_route');
  }

  const [applicationService, loginService, auth, healthAuth, strip] = await Promise.all([
    read('/api/http/services/' + encodeURIComponent(fileResource(routeName)), httpService),
    read('/api/http/services/' + encodeURIComponent(fileResource(loginName)), httpService),
    read('/api/http/middlewares/' + encodeURIComponent(fileResource(authName)), forwardAuth),
    read('/api/http/middlewares/' + encodeURIComponent(fileResource(healthAuthName)), forwardAuth),
    read('/api/http/middlewares/' + encodeURIComponent(fileResource(stripName)), credentialRemoval),
  ]);
  if (applicationService.name !== fileResource(routeName) || applicationService.loadBalancer.servers[0].url !== backend ||
      loginService.name !== fileResource(loginName) || loginService.loadBalancer.servers[0].url !== proxy ||
      auth.name !== fileResource(authName) || auth.forwardAuth.address !== forwardAuthAddress ||
      !headerSetMatches(auth.forwardAuth.authRequestHeaders, browserCookie) ||
      healthAuth.name !== fileResource(healthAuthName) || healthAuth.forwardAuth.address !== forwardAuthAddress ||
      !headerSetMatches(healthAuth.forwardAuth.authRequestHeaders, bearerAndCookie) ||
      strip.name !== fileResource(stripName) || !headerSetMatches(Object.keys(strip.headers.customRequestHeaders), bearerAndCookie)) {
    throw new ReleaseIngressError('ingress_route');
  }
}
