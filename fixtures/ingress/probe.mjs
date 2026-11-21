import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { promisify } from 'node:util';
import { setTimeout as wait } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { createKeycloakRolloutTokenSource, ReleaseRolloutVerifier } from '../../packages/control-plane/src/runtime/release-rollout.ts';
import { fingerprintRolloutCheck } from '../../packages/control-plane/src/service/release-targets.ts';
import { report, saveReport } from '../../packages/verification/src/report.ts';

const versions = JSON.parse(await readFile(new URL('versions.json', import.meta.url), 'utf8'));
const [traefik, oauth2, ...extra] = process.argv.slice(2);
const exec = promisify(execFile);
const dir = await mkdtemp('/tmp/itervane-ingress-probe.');
const uid = randomUUID();
const name = 'itervane-ingress-probe-' + uid;
const child = [];
let server;
let alternateServer;
let docker = false;
let phase = 'startup';
const exchanges = [];
const checks = [];
const fetchRequest = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const path = new URL(String(input)).pathname;
  try {
    const response = await fetchRequest(input,init);
    exchanges.push([path.replace(/^\/realms\/[^/]+/, '/realm'), response.status, response.headers.get('x-next-page')]);
    return response;
  } catch (error) {
    const code = error.cause?.code;
    exchanges.push([path.replace(/^\/realms\/[^/]+/, '/realm'), 'transport', /^[A-Z0-9_]+$/.test(code ?? '') ? code : null]);
    throw error;
  }
};
const run = (program, args, env = {}) => {
  const process = spawn(program, args, { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', ...env },
    stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  process.stderr?.on('data', data => {
    if (stderr.length < 12_000) stderr += Buffer.from(data).toString('utf8');
  });
  process.preservingDiagnostic = () => {
    const lower = stderr.toLowerCase();
    return ['configuration', 'unknown flag', 'group', 'unsupported', 'oidc', 'issuer', 'invalid', 'error', 'listen', 'refused']
      .filter(value => lower.includes(value));
  };
  child.push(process);
  return process;
};
async function until(callback, process) {
  for (let i=0; i<160; i++) {
    if (process && process.exitCode !== null) throw new Error('child:' + process.preservingDiagnostic().join(','));
    try { if (await callback()) return; } catch {}
    await wait(450);
  }
  throw new Error('readiness');
}
const openPort = async () => {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
};

async function verifyBinary(path, expected) {
  const file = await stat(path);
  assert.ok(file.isFile() && file.size <= 160 * 1024 * 1024);
  assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), expected);
}

const passed = (id, detail) => checks.push({ id, status: 'passed', detail });

try {
  phase = 'inputs';
  assert.ok(process.platform === 'linux' && process.arch === 'x64' && traefik && oauth2 && extra.length === 0);
  const keycloak = process.env.ITERVANE_KEYCLOAK_IMAGE ?? versions.keycloak.reference;
  assert.ok(/^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]{1,299}$/.test(keycloak));
  await verifyBinary(traefik, versions.traefik.binarySha256);
  await verifyBinary(oauth2, versions.oauth2Proxy.binarySha256);
  passed('pinned-gateway', 'The Traefik and OAuth2 Proxy executables matched the pinned release digests.');
  phase = 'trusted-app';
  const tlsPort = await openPort();
  const adminPort = await openPort();
  const authPort = await openPort();
  const origin = 'https://127.0.0.1:' + tlsPort;
  let healthy = true;
  let authorizedReachesApp = 0;
  server = createServer((req,res) => {
    if (req.headers.authorization || req.headers.cookie) { res.writeHead(400).end(); return; }
    authorizedReachesApp++;
    res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: healthy ? 'healthy' : 'unhealthy', version: 'trusted-demo' }));
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const appPort = server.address().port;
  phase = 'local-certificate';
  await exec('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-sha256','-days','1','-subj','/CN=itervane-test',
    '-addext','subjectAltName=IP:127.0.0.1','-keyout',dir+'/server-key.pem','-out',dir+'/server-cert.pem']);
  setDefaultCACertificates([...getCACertificates('default'), await readFile(dir+'/server-cert.pem','utf8')]);

  phase = 'keycloak';
  const realm = 'rollout-' + uid;
  const appClient = 'demo';
  const probeClient = 'demo-health';
  const otherClient = 'other-health';
  const appSecret = randomBytes(28).toString('hex');
  const probeSecret = randomBytes(28).toString('hex');
  const otherSecret = randomBytes(28).toString('hex');
  const probeId = randomUUID();
  const otherId = randomUUID();
  const groups = { name: 'groups', protocol: 'openid-connect', protocolMapper: 'oidc-group-membership-mapper', config: {
    'full.path': 'true', 'claim.name': 'groups', 'id.token.claim': 'true', 'access.token.claim': 'true', 'userinfo.token.claim': 'true',
  } };
  const audience = { name: 'app-only', protocol: 'openid-connect', protocolMapper: 'oidc-audience-mapper', config: {
    'included.client.audience': appClient, 'access.token.claim': 'true', 'id.token.claim': 'false',
  } };
  const machine = (clientId, secret) => ({ clientId, secret, serviceAccountsEnabled: true, standardFlowEnabled: false,
    publicClient: false, protocol: 'openid-connect', fullScopeAllowed: false, protocolMappers: [groups,audience] });
  const principal = (id, clientId, authorized) => ({ id, username: 'service-account-' + clientId, enabled: true,
    serviceAccountClientId: clientId, email: clientId + '@example.invalid', emailVerified: true, groups: authorized ? ['/demo'] : [] });
  await mkdir(dir+'/idp', { mode: 0o700 });
  await writeFile(dir+'/idp/realm.json',JSON.stringify({ realm, enabled:true, sslRequired:'none', accessTokenLifespan:120,
    groups:[{name:'demo'}],
    clients:[{ clientId:appClient, secret:appSecret, enabled: true, publicClient:false, standardFlowEnabled:true, protocol:'openid-connect',
      redirectUris:[origin+'/oauth2/callback'], protocolMappers:[groups] }, machine(probeClient,probeSecret), machine(otherClient,otherSecret)],
    users:[principal(probeId,probeClient,true),principal(otherId,otherClient,false)],
  }), { mode: 0o644 });
  docker = true;
  await exec('docker',['run','--detach','--rm','--name',name,'--label','io.itervane.ingress-test='+uid,'--publish','127.0.0.1::8080',
    '--mount','type=bind,source='+dir+'/idp/realm.json,target=/opt/keycloak/data/import/itervane.json,readonly',
    '--env','JAVA_OPTS_KC_HEAP=-Xms128m -Xmx512m',keycloak,'start-dev','--import-realm','--hostname-strict=false'],
    { timeout: 90_000 });
  const mapping = await exec('docker',['port',name,'8080/tcp']);
  assert.match(mapping.stdout.trim(), /^127\.0\.0\.1:[1-9][0-9]{0,4}$/);
  const issuer = 'http://' + mapping.stdout.trim() + '/realms/' + realm;
  await until(async () => (await fetch(issuer + '/.well-known/openid-configuration', { signal: AbortSignal.timeout(1000) })).ok);
  phase = 'oauth2-proxy';
  const auth = run(oauth2, ['--http-address=127.0.0.1:'+authPort,'--provider=keycloak-oidc','--email-domain=*',
    '--allowed-group=/demo','--oidc-email-claim=sub','--upstream=static://202','--skip-jwt-bearer-tokens=true',
    '--bearer-token-login-fallback=false','--cookie-secure=true','--reverse-proxy=true','--redirect-url='+origin+'/oauth2/callback'], {
    OAUTH2_PROXY_CLIENT_ID: appClient, OAUTH2_PROXY_CLIENT_SECRET: appSecret, OAUTH2_PROXY_OIDC_ISSUER_URL: issuer,
    OAUTH2_PROXY_COOKIE_SECRET: randomBytes(32).toString('base64url'),
  });
  const authOrigin = 'http://127.0.0.1:' + authPort;
  await until(async () => (await fetch(authOrigin+'/ping')).ok,auth);

  phase = 'traefik';
  const rule = 'Host(`127.0.0.1`)';
  const config = { http:{ routers:{
    demo: { entryPoints:['websecure'], rule, tls:{}, service:'demo', middlewares:['demo-auth','demo-strip'] },
    'demo-health': {entryPoints:['websecure'],rule:rule+' && Path(`/health`) && Method(`GET`)',
      tls:{}, service:'demo', middlewares:['demo-health-auth','demo-strip']},
    'demo-login': {entryPoints:['websecure'],rule:rule+' && PathPrefix(`/oauth2/`)', tls:{}, service:'demo-login'},
  }, services:{
    demo:{loadBalancer:{servers:[{url:'http://localhost:'+appPort}]}},
    'demo-login':{loadBalancer:{servers:[{url:authOrigin}]}},
  }, middlewares:{
    'demo-auth':{forwardAuth:{address:authOrigin+'/oauth2/auth',trustForwardHeader:false,authRequestHeaders:['Cookie']}},
    'demo-health-auth':{forwardAuth:{address:authOrigin+'/oauth2/auth',trustForwardHeader:false,authRequestHeaders:['Authorization','Cookie']}},
    'demo-strip':{headers:{customRequestHeaders:{Authorization:'',Cookie:''}}},
  } }, tls:{stores:{default:{defaultCertificate:{certFile:dir+'/server-cert.pem',keyFile:dir+'/server-key.pem'}}}} };
  await writeFile(dir+'/dynamic.yml', JSON.stringify(config));
  const edge = run(traefik,['--entrypoints.websecure.address=127.0.0.1:'+tlsPort, '--entrypoints.traefik.address=127.0.0.1:'+adminPort,
    '--providers.file.filename='+dir+'/dynamic.yml','--api.insecure=true']);
  const apiOrigin = 'http://127.0.0.1:'+adminPort;
  await until(async () => (await fetch(apiOrigin+'/api/http/routers/demo@file')).ok,edge);
  const check = { version: 1, origin, healthPath: '/health', network: 'demo-private', backendPort: appPort,
    traefik:{ apiOrigin, entryPoint:'websecure', routeName:'demo', forwardAuthAddress:authOrigin+'/oauth2/auth' },
    probeIdentity:{ issuer, audience:appClient, clientId:probeClient, subject:probeId },
  };
  const runtime = { deploymentId:'a'.repeat(24),serverId:'b'.repeat(24),runtimeConfigSha256:'c'.repeat(64),
    containerId:'d'.repeat(64),containerName:'localhost',configDigest:'sha256:'+'e'.repeat(64),
    imageReference:'fixture@sha256:'+'f'.repeat(64),network:'demo-private' };
  let runtimeReads = 0;
  const observer = { inspectRuntime:async () => { runtimeReads++; return runtime; } };
  const access = createKeycloakRolloutTokenSource(check.probeIdentity,probeSecret);
  const verifier = new ReleaseRolloutVerifier(observer, access);
  const subject = { check, rolloutCheckSha256:fingerprintRolloutCheck(check), target:{}, image:{} };
  const authorize = async () => {};
  phase = 'positive-proof';
  const evidence = await verifier.observe(subject,authorize);
  assert.equal(evidence.healthStatus,200);
  assert.equal(evidence.anonymousStatus,401);
  assert.equal(authorizedReachesApp,1);
  assert.equal(runtimeReads,2);
  passed('protected-health', 'The HTTPS route rejected anonymous access and returned healthy for the enrolled Keycloak actor. No bearer or cookie reached the application.');
  phase = 'probe-path-boundary';
  const probe = await access(check.probeIdentity,AbortSignal.timeout(5000));
  const otherPath = await fetch(origin+'/',{headers:{authorization:'Bearer '+probe}, redirect:'manual'});
  await otherPath.body?.cancel();
  assert.ok([401,403].includes(otherPath.status));
  const otherMethod = await fetch(origin + '/health', { method: 'POST', headers: { authorization: 'Bearer ' + probe }, redirect: 'manual' });
  await otherMethod.body?.cancel();
  assert.ok([401,403].includes(otherMethod.status));
  assert.equal(authorizedReachesApp,1);
  passed('probe-scope', 'The enrolled bearer did not authorize another path or an HTTP write method.');
  phase = 'wrong-app-role';
  const wrongIdentity = { ...check.probeIdentity, clientId:otherClient, subject:otherId };
  const wrongRole = createKeycloakRolloutTokenSource(wrongIdentity,otherSecret);
  const token = await wrongRole(wrongIdentity,AbortSignal.timeout(5000));
  const wrong = await fetch(origin+'/health',{headers:{authorization:'Bearer '+token}, redirect:'manual'});
  await wrong.body?.cancel();
  assert.ok([401,403].includes(wrong.status));
  assert.equal(authorizedReachesApp,1);
  passed('wrong-role-denied', 'A valid token with the same application audience could not access the route without the application group.');
  phase = 'health-failure';
  healthy = false;
  await assert.rejects(verifier.observe(subject,authorize), { reason:'health_failed' });
  passed('unhealthy', 'A valid authorized response with HTTP 503 did not count as successful health verification.');
  phase = 'backend-mismatch';
  let alternateRequests = 0;
  alternateServer = createServer((_request, response) => {
    alternateRequests++;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'healthy', version: 'other-demo' }));
  });
  await new Promise(resolve => alternateServer.listen(0, '127.0.0.1', resolve));
  const alternateUrl = 'http://localhost:' + alternateServer.address().port;
  const staged = structuredClone(config);
  staged.http.services.demo.loadBalancer.servers[0].url = alternateUrl;
  await writeFile(dir + '/dynamic.yml', JSON.stringify(staged));
  const readTraefikTarget = async () => {
    const response = await fetch(apiOrigin + '/api/http/services/demo@file');
    if (!response.ok) { await response.body?.cancel(); return null; }
    return (await response.json()).loadBalancer?.servers?.[0]?.url;
  };
  await until(async () => await readTraefikTarget() === alternateUrl, edge);
  await assert.rejects(verifier.observe(subject, authorize), { reason: 'ingress_route' });
  assert.equal(alternateRequests, 0);
  await writeFile(dir + '/dynamic.yml', JSON.stringify(config));
  await until(async () => await readTraefikTarget() === 'http://localhost:' + appPort, edge);
  passed('wrong-backend-denied', 'An active route to a different healthy service could not supply proof or receive a probe credential.');
  phase = 'fail-closed';
  const authClosed = new Promise(resolve => auth.once('exit',resolve));
  auth.kill();
  await authClosed;
  const closed = await fetch(origin+'/health',{redirect:'manual'});
  assert.ok(closed.status>=400);
  await closed.body?.cancel();
  assert.equal(authorizedReachesApp,2);
  passed('auth-outage-closed', 'Stopping the authentication service denied ingress and did not forward traffic.');
} catch (error) {
  const reason = error.reason ?? error.code ?? error.name;
  const diagnostics = { phase, reason: /^[a-zA-Z0-9_]+$/.test(reason ?? '') ? reason : 'fixture',
    processes: child.map(item => item.preservingDiagnostic()), exchanges: exchanges.slice(-12) };
  checks.push({ id: 'ingress-fixture-failed', status: 'failed', detail: JSON.stringify(diagnostics) });
} finally {
  globalThis.fetch = fetchRequest;
  for (const fixture of child) if (fixture.exitCode === null) fixture.kill();
  for (const listener of [server, alternateServer]) {
    if (!listener) continue;
    listener.closeAllConnections();
    await new Promise(resolve => listener.close(resolve));
  }
  if (docker) {
    const inspected = await exec('docker',['inspect','--format','{{ index .Config.Labels "io.itervane.ingress-test" }}',name]).catch(()=>null);
    if (inspected?.stdout.trim()===uid) await exec('docker',['rm','--force',name]).catch(()=>{});
  }
  await rm(dir,{recursive:true,force:true});
}

const result = report('protected-ingress', checks);
await saveReport(result);
console.log(JSON.stringify(result));
process.exitCode = result.status === 'passed' ? 0 : 1;
