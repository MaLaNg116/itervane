import { equal, match, ok } from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { releaseRolloutCheckSchema } from '@itervane/contracts';
import { createRolloutRealm } from '../../../verification/src/native/rollout-realm.js';

const execute = promisify(execFile);
const reference = fileURLToPath(new URL('../../../../fixtures/ingress/reference/', import.meta.url));
const loopback = '127.0.0.1';
const identityAddress = '172.31.93.4';
const identityOrigin = 'https://' + identityAddress + ':8443';
export const ingressFixtureImage = 'docker.io/library/node:24-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553';

async function loopbackPorts() {
  const listeners = [createServer(), createServer()];
  try {
    const ports = await Promise.all(listeners.map(listener => new Promise<number>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, loopback, () => {
        const address = listener.address();
        if (!address || typeof address === 'string') { reject(new Error('fixture listener')); return; }
        resolve(address.port);
      });
    })));
    return { publicPort: ports[0]!, adminPort: ports[1]! };
  } finally {
    await Promise.all(listeners.map(listener => new Promise<void>(resolve => listener.close(() => resolve()))));
  }
}

async function certificate(directory: string, address: string) {
  await mkdir(directory, { mode: 0o755 });
  const key = join(directory, 'key.pem');
  const cert = join(directory, 'certificate.pem');
  await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
    '-subj', '/CN=itervane-fixture', '-addext', 'subjectAltName=IP:' + address, '-keyout', key, '-out', cert],
  { timeout: 15_000 });
  await Promise.all([chmod(key, 0o444), chmod(cert, 0o444)]);
  return { key, cert };
}

async function mountProxy(source: string, target: string, sha256: string) {
  await copyFile(source, target);
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(target)) digest.update(chunk);
  equal(digest.digest('hex'), sha256);
  await chmod(target, 0o555);
  return target;
}

async function untilReady(probe: () => Promise<boolean>) {
  const deadline = performance.now() + 85_000;
  while (performance.now() < deadline) {
    if (await probe().catch(() => false)) return;
    await delay(450);
  }
  throw new Error('ingress readiness');
}

export async function openProtectedIngress(
  target: { network: string; container: string; port: number },
  binaries: { traefik: string; oauth2: string },
  keycloakImage?: string,
) {
  ok(process.platform === 'linux' && process.arch === 'x64');
  match(target.container, /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
  match(target.network, /^itervane-app-[a-f0-9-]{36}$/);
  ok(Number.isInteger(target.port) && target.port > 0 && target.port <= 65_535);
  const mark = target.network.slice('itervane-app-'.length);
  const network = await execute('docker', ['network', 'inspect', '--format',
    '{{.Driver}} {{.Internal}} {{index .Labels "io.itervane.komodo-probe"}}', target.network], { timeout: 10_000 });
  equal(network.stdout.trim(), 'bridge true ' + mark);

  const directory = await mkdtemp(join(tmpdir(), 'itervane-protected-ingress.'));
  const project = 'itervane-protected-' + randomUUID();
  const compose = ['compose', '--project-name', project, '--env-file', join(directory, 'install.env'),
    '--file', join(reference, 'compose.yml'), '--file', join(directory, 'override.json')];
  const docker = (args: string[], timeout = 90_000) => execute('docker', [...compose, ...args], { timeout });
  let started = false;
  const close = async () => {
    try { if (started) await docker(['down', '--timeout', '3'], 25_000); }
    finally { await rm(directory, { recursive: true, force: true }); }
  };

  let phase = 'inputs';
  try {
    const versions = JSON.parse(await readFile(join(reference, '..', 'versions.json'), 'utf8'));
    const idpImage = keycloakImage ?? versions.keycloak.reference;
    match(idpImage, /^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]{1,299}$/);
    const { publicPort, adminPort } = await loopbackPorts();
    const origin = 'https://' + loopback + ':' + publicPort;
    const apiOrigin = 'http://' + loopback + ':' + adminPort;
    const realm = 'protected-' + randomUUID();
    const issuer = identityOrigin + '/realms/' + realm;
    const identity = createRolloutRealm(realm, origin);

    phase = 'certificates';
    const tlsDir = join(directory, 'tls');
    const idpDir = join(directory, 'identity');
    const dynamic = join(directory, 'dynamic');
    const [tls, idp] = await Promise.all([certificate(tlsDir, loopback), certificate(idpDir, identityAddress)]);
    const caFile = join(directory, 'probe-ca.pem');
    await writeFile(caFile, (await readFile(tls.cert, 'utf8')) + (await readFile(idp.cert, 'utf8')), { mode: 0o600 });

    phase = 'configuration';
    const [traefik, oauth2] = await Promise.all([
      mountProxy(binaries.traefik, join(directory, 'traefik'), versions.traefik.binarySha256),
      mountProxy(binaries.oauth2, join(directory, 'oauth2-proxy'), versions.oauth2Proxy.binarySha256),
    ]);
    const routes = (await readFile(join(reference, 'traefik.example.yml'), 'utf8'))
      .replaceAll('demo.example.invalid', loopback)
      .replace('demo-container:3000', target.container + ':' + target.port)
      .replace(/\r?\ntls:[\s\S]*$/, '\ntls:\n  stores:\n    default:\n      defaultCertificate:\n' +
        '        certFile: /etc/traefik/tls/certificate.pem\n        keyFile: /etc/traefik/tls/key.pem\n');
    const oauthConfig = (await readFile(join(reference, 'oauth2-proxy.example.cfg'), 'utf8'))
      .replace('https://identity.example.invalid/realms/itervane', issuer)
      .replace('https://demo.example.invalid:8443', origin);
    await mkdir(dynamic, { mode: 0o755 });
    const configFile = join(directory, 'oauth2.cfg');
    const secretsFile = join(directory, 'oauth2.env');
    const realmFile = join(idpDir, 'realm.json');
    const edge = { image: ingressFixtureImage, entrypoint: ['/probe/traefik'], volumes: [traefik + ':/probe/traefik:ro'] };
    await Promise.all([
      writeFile(join(dynamic, 'routes.yml'), routes, { mode: 0o444 }),
      writeFile(configFile, oauthConfig, { mode: 0o444 }),
      writeFile(realmFile, JSON.stringify(identity.document), { mode: 0o444 }),
      writeFile(secretsFile, 'OAUTH2_PROXY_CLIENT_SECRET=' + identity.appSecret +
        '\nOAUTH2_PROXY_COOKIE_SECRET=' + randomBytes(32).toString('base64url') + '\n', { mode: 0o600 }),
      writeFile(join(directory, 'install.env'), [
        'ITERVANE_TRAEFIK_CONFIG_DIR=' + dynamic, 'ITERVANE_INGRESS_TLS_DIR=' + tlsDir,
        'ITERVANE_OAUTH2_CONFIG=' + configFile, 'ITERVANE_OAUTH2_SECRETS_FILE=' + secretsFile,
        'ITERVANE_APPLICATION_NETWORK=' + target.network, 'ITERVANE_INGRESS_BIND=' + loopback,
        'ITERVANE_INGRESS_PORT=' + publicPort, 'ITERVANE_INGRESS_MANAGEMENT_PORT=' + adminPort,
      ].join('\n') + '\n', { mode: 0o600 }),
      writeFile(join(directory, 'override.json'), JSON.stringify({ services: {
        traefik: edge, 'management-gateway': edge,
        'oauth2-proxy': {
          image: ingressFixtureImage, entrypoint: ['/probe/oauth2-proxy'],
          command: ['--config=/etc/itervane/oauth2-proxy.cfg', '--provider-ca-file=/probe/identity.pem'],
          volumes: [oauth2 + ':/probe/oauth2-proxy:ro', idp.cert + ':/probe/identity.pem:ro'],
        },
        keycloak: {
          image: idpImage,
          command: ['start-dev', '--import-realm', '--http-enabled=false', '--hostname=' + identityOrigin,
            '--https-certificate-file=/probe/certificate.pem', '--https-certificate-key-file=/probe/key.pem'],
          environment: { JAVA_OPTS_KC_HEAP: '-Xms128m -Xmx512m' },
          volumes: [realmFile + ':/opt/keycloak/data/import/itervane.json:ro', idp.cert + ':/probe/certificate.pem:ro',
            idp.key + ':/probe/key.pem:ro'],
          networks: { authorization: { ipv4_address: identityAddress } },
        },
      } }), { mode: 0o600 }),
    ]);
    await docker(['config', '--quiet']);

    const waitForIdentity = () => untilReady(async () => {
      const discovery = await execute('curl', ['--noproxy', '*', '--silent', '--fail', '--max-time', '2',
        '--cacert', idp.cert, issuer + '/.well-known/openid-configuration']);
      return JSON.parse(discovery.stdout).issuer === issuer;
    });
    phase = 'identity';
    started = true;
    await docker(['up', '--detach', '--no-build', 'keycloak'], 180_000);
    await waitForIdentity();
    phase = 'proxies';
    await docker(['up', '--detach', '--no-build'], 180_000);
    await untilReady(async () => {
      const response = await fetch(apiOrigin + '/api/http/routers/demo-health@file', { signal: AbortSignal.timeout(2_000) });
      await response.body?.cancel();
      if (!response.ok) return false;
      const login = await execute('curl', ['--noproxy', '*', '--silent', '--max-time', '2', '--output', '/dev/null',
        '--cacert', tls.cert, '--write-out', '%{http_code}', origin + '/oauth2/start?rd=/']);
      return login.stdout === '302';
    });

    const check = releaseRolloutCheckSchema.parse({
      version: 1, origin, healthPath: '/health', network: target.network, backendPort: target.port,
      traefik: { apiOrigin, entryPoint: 'websecure', routeName: 'demo', forwardAuthAddress: 'http://application-access:4180/oauth2/auth' },
      probeIdentity: { issuer, audience: identity.appClient, clientId: identity.probe.clientId, subject: identity.probe.subject },
    });
    return { check, caFile, probeSecret: identity.probe.secret,
      otherIdentity: { ...check.probeIdentity, clientId: identity.other.clientId, subject: identity.other.subject },
      otherSecret: identity.other.secret, close,
      async stopIdentity() { await docker(['stop', '--timeout', '3', 'keycloak'], 20_000); },
      async startIdentity() {
        await docker(['start', 'keycloak'], 20_000);
        await waitForIdentity();
      },
      async anonymousHealthStatus() {
        const { stdout } = await execute('curl', ['--noproxy', '*', '--silent', '--max-time', '4', '--output', '/dev/null',
          '--cacert', tls.cert, '--write-out', '%{http_code}', check.origin + check.healthPath], { timeout: 5_000 });
        match(stdout, /^[1-5][0-9]{2}$/);
        return Number(stdout);
      },
    };
  } catch {
    await close().catch(() => { throw new Error('protected_ingress_cleanup'); });
    throw new Error('protected_ingress_' + phase);
  }
}
