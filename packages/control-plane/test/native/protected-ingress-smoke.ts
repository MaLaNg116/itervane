import { deepStrictEqual, equal, match, ok } from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { promisify } from 'node:util';
import type { Check } from '@itervane/contracts';
import { createKeycloakRolloutTokenSource } from '../../src/runtime/release-rollout.js';
import { readIngressJson, verifyTraefikIngress } from '../../src/runtime/release-traefik.js';
import { report, saveReport } from '../../../verification/src/report.js';
import { ingressFixtureImage, openProtectedIngress } from './protected-ingress.js';

const execute = promisify(execFile);
const docker = (args: string[], timeout = 15_000) => execute('docker', args, { timeout });
const mark = randomUUID();
const network = 'itervane-app-' + mark;
const app = 'itervane-fixture-' + mark;
const label = 'io.itervane.komodo-probe=' + mark;
const checks: Check[] = [];
const pass = (id: string, detail: string) => checks.push({ id, status: 'passed', detail });
let phase = 'configuration';
let ingress: Awaited<ReturnType<typeof openProtectedIngress>> | undefined;
let networkId: string | undefined;
let appId: string | undefined;
const defaultTrust = getCACertificates('default');

try {
  const [traefik, oauth2, ...extra] = process.argv.slice(2);
  ok(process.platform === 'linux' && process.arch === 'x64' && traefik && oauth2 && extra.length === 0);
  phase = 'owned_network';
  networkId = (await docker(['network', 'create', '--internal', '--label', label, network])).stdout.trim();
  match(networkId, /^[a-f0-9]{64}$/);
  appId = (await docker(['run', '--detach', '--name', app, '--label', label, '--network', network,
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', ingressFixtureImage, 'node', '-e',
    `require('node:http').createServer((request, response) => {
      const noCredentials = !request.headers.authorization && !request.headers.cookie;
      response.writeHead(noCredentials ? 200 : 400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'healthy', version: 'network-fixture' }));
    }).listen(3000, '0.0.0.0')`], 180_000)).stdout.trim();
  match(appId, /^[a-f0-9]{64}$/);
  phase = 'startup';
  ingress = await openProtectedIngress({ network, container: app, port: 3000 }, { traefik, oauth2 }, process.env.ITERVANE_KEYCLOAK_IMAGE);
  const { check } = ingress;
  setDefaultCACertificates([...defaultTrust, await readFile(ingress.caFile, 'utf8')]);
  const request = (url: string, init?: RequestInit) => fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5_000), ...init });
  const status = async (url: string, init?: RequestInit) => {
    const result = await request(url, init);
    await result.body?.cancel();
    return result.status;
  };

  phase = 'management';
  await verifyTraefikIngress(check, app, async () => {}, AbortSignal.timeout(10_000));
  equal(await status(check.traefik.apiOrigin + '/api/http/routers', { method: 'POST' }), 404);
  pass('loopback-read-only', 'The installed Traefik route observations were read on loopback and a write method was denied.');

  phase = 'protected_health';
  const health = check.origin + check.healthPath;
  equal(await status(health), 401);
  const token = await createKeycloakRolloutTokenSource(check.probeIdentity, ingress.probeSecret)(
    check.probeIdentity, AbortSignal.timeout(10_000));
  const headers = { Authorization: 'Bearer ' + token };
  const allowed = await request(health, { headers });
  equal(allowed.status, 200);
  deepStrictEqual(await readIngressJson(allowed, 2048), { status: 'healthy', version: 'network-fixture' });
  pass('protected-tls', 'Trusted TLS denied anonymous access and accepted the enrolled short-lived identity with credentials stripped upstream.');

  phase = 'scope';
  const other = await createKeycloakRolloutTokenSource(ingress.otherIdentity, ingress.otherSecret)(
    ingress.otherIdentity, AbortSignal.timeout(10_000));
  ok([401, 403].includes(await status(health, { headers: { Authorization: 'Bearer ' + other } })));
  ok([401, 403].includes(await status(check.origin + '/', { headers })));
  ok([401, 403].includes(await status(health, { method: 'POST', headers })));
  pass('protected-probe-scope', 'The health token could not authorize another path or method, and the unassigned account was denied.');

  phase = 'private_network';
  equal((await docker(['port', appId])).stdout.trim(), '');
  await docker(['exec', appId, 'node', '--input-type=module', '-e', `
    for (const target of process.argv.slice(1)) {
      const response = await fetch(target, { signal: AbortSignal.timeout(1500) }).catch(() => null);
      if (response) { await response.body?.cancel(); process.exit(1); }
    }
  `, 'http://172.31.92.2:8080/api/http/routers', 'http://172.31.93.3:4180/ping', check.probeIdentity.issuer]);
  pass('private-targets', 'The application had no host ports and could not reach the private authorization, identity or management endpoints.');
} catch (error) {
  const detail = error instanceof Error && /^protected_ingress_[a-z]+$/.test(error.message) ? error.message : 'verification';
  checks.push({ id: 'network-fixture-failed', status: 'failed', detail: phase + ' (' + detail + ')' });
} finally {
  setDefaultCACertificates(defaultTrust);
  try {
    await ingress?.close();
    if (appId && /^[a-f0-9]{64}$/.test(appId)) await docker(['rm', '--force', appId]);
    if (networkId && /^[a-f0-9]{64}$/.test(networkId)) await docker(['network', 'rm', networkId]);
    pass('owned-resources-cleaned', 'Released the owned ingress, application container and internal network.');
  } catch {
    checks.push({ id: 'network-fixture-cleanup', status: 'failed', detail: 'Could not remove all owned ingress test resources.' });
  }
}

const result = report('protected-ingress-network', checks);
await saveReport(result);
console.log(JSON.stringify(result));
process.exitCode = result.status === 'passed' ? 0 : 1;
